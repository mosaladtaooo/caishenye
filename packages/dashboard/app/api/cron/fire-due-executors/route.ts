/**
 * GET /api/cron/fire-due-executors — every-minute cron tick.
 *
 * v1.1 — replaces the dead `/api/internal/anthropic/schedule` path. Per
 * ADR-013 (cascade edit 2026-05-05): Anthropic exposes no programmatic
 * `/schedule` API; the only HTTP-callable routine API is `/fire`. So the
 * Planner now writes `pair_schedules` rows in `status='scheduled'` and
 * THIS cron tick polls every minute, fires each due row via `/fire`, and
 * settles the row to `status='fired'` with the returned session_id.
 *
 * Triggered by `.github/workflows/cron-fire-due-executors.yml` (every-min;
 * GH Actions cron has up-to-15-min documented jitter, acceptable for
 * intraday session-start firing where the SPARTAN protocol's 15–30 min
 * post-news buffer absorbs minor lateness).
 *
 * Auth: CRON_SECRET bearer (same secret used by other crons, present in
 * both Vercel env AND GitHub repo Secrets).
 *
 * Per-row flow (atomic):
 *   1. SELECT due rows: status='scheduled' AND start_time_gmt <= now AND
 *      scheduled_one_off_id IS NULL (lookback bounded — 5 min default)
 *   2. For each row, CLAIM via UPDATE-where-null pattern (atomic;
 *      concurrent ticks lose the race silently)
 *   3. POST /v1/claude_code/routines/{executor_id}/fire with `{text: ...}`
 *      where text contains pair_schedule_id + pair + session for the
 *      Executor's stale-check
 *   4. On success: SETTLE row to status='fired' with returned session_id
 *   5. On failure: RELEASE claim (set scheduled_one_off_id back to null)
 *      so the next tick retries; Telegram-alert the operator
 *
 * Idempotent: if the same row is somehow seen twice (e.g., concurrent
 * cron triggers), the second claim returns 0 rows and the loop skips it.
 *
 * Tenant scoping: v1 = single-tenant (DEFAULT_TENANT_ID=1).
 *
 * Vercel maxDuration: 30s (firing all 13 due rows + Telegram alerts on
 * a worst-case run; typical 0–2 fires per tick takes <1s).
 */

import { resolveRoutine } from '@/lib/anthropic-routine-resolve';
import { validateCronAuth } from '@/lib/cron-auth';
import { runNamedQuery } from '@/lib/internal-postgres-queries';
import { jsonRes } from '@/lib/internal-route-helpers';

export const maxDuration = 30;

const FIRE_TIMEOUT_MS = 20_000;
const DEFAULT_TENANT_ID = Number(process.env.DEFAULT_TENANT_ID ?? '1');

interface DueRow {
  id: number;
  tenantId: number;
  pairCode: string;
  sessionName: string;
  startTimeGmt: string | Date | null;
  endTimeGmt: string | Date | null;
  /** v1.1.1 — used by the cascade-cancel dedupe (KI-006). */
  plannerRunId: number | null;
  date: string;
}

interface FireResult {
  pair_schedule_id: number;
  pair: string;
  session: string;
  outcome: 'fired' | 'claim-lost' | 'fire-failed' | 'settle-failed';
  session_id?: string;
  error?: string;
}

function buildExecutorText(row: DueRow): string {
  const xauBlock =
    row.pairCode === 'XAU/USD'
      ? "\nWhen calling MT5 candles/orders, use the symbol 'XAUUSD' (NOT 'XAUUSDF') — see spartan prompt verbatim section.\n"
      : '';
  const nowGmt = new Date().toISOString();
  return [
    `LET'S START`,
    `Current Analysis Pair :`,
    row.pairCode,
    ``,
    xauBlock.trim(),
    ``,
    `Time Now: ${nowGmt}`,
    ``,
    `pair_schedule_id=${row.id}`,
    `sessionName=${row.sessionName}`,
  ].join('\n');
}

async function callAnthropicFire(
  routineName: string,
  text: string,
): Promise<{ session_id: string }> {
  const { id, bearer } = resolveRoutine(routineName);
  const baseUrl = process.env.ANTHROPIC_ROUTINES_BASE_URL ?? 'https://api.anthropic.com';
  const beta = process.env.ROUTINE_BETA_HEADER ?? 'experimental-cc-routine-2026-04-01';
  // Per Anthropic docs (docs.code.claude.com/routines), the canonical fire
  // path is `/v1/claude_code/routines/{id}/fire`. The legacy
  // `/v1/routines/{id}/fire` path (used by /api/internal/anthropic/fire)
  // works in production today but the docs suggest the canonical form;
  // we use the canonical form here to future-proof.
  const url = `${baseUrl.replace(/\/$/, '')}/v1/claude_code/routines/${id}/fire`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'anthropic-beta': beta,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`fire HTTP ${r.status}: ${body.slice(0, 256)}`);
    }
    const json = (await r.json()) as { claude_code_session_id?: unknown; one_off_id?: unknown };
    // The docs say claude_code_session_id; production response also includes
    // one_off_id (legacy path). Take whichever is present.
    const sessionId =
      typeof json.claude_code_session_id === 'string'
        ? json.claude_code_session_id
        : typeof json.one_off_id === 'string'
          ? json.one_off_id
          : '';
    if (sessionId.length === 0) throw new Error('upstream response missing session_id');
    return { session_id: sessionId };
  } finally {
    clearTimeout(timer);
  }
}

async function safeTelegramAlert(text: string): Promise<void> {
  // Best-effort. Failures are stderr-logged, never abort the cron.
  try {
    const r = await fetch(
      `${process.env.AUTH_URL ?? 'https://caishenv2.vercel.app'}/api/internal/telegram/send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.INTERNAL_API_TOKEN ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
    );
    if (!r.ok) {
      process.stderr.write(`[fire-due-executors] telegram alert failed: HTTP ${r.status}\n`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[fire-due-executors] telegram alert exception: ${msg}\n`);
  }
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  const tenantId =
    Number.isFinite(DEFAULT_TENANT_ID) && DEFAULT_TENANT_ID > 0 ? DEFAULT_TENANT_ID : 1;
  const nowIso = new Date().toISOString();

  // Lookback override — for operator-driven recovery when GH Actions cron
  // misses windows (free-tier `* * * * *` is best-effort; gaps of 30+ min
  // are documented). Default 60 min (was 5 in v1.1; bumped after live
  // observation that GH Actions can throttle to one run per ~2.5h).
  // Recovery via curl: `?lookbackMinutes=240` to catch the morning's
  // missed London window from later in the day.
  const url = new URL(req.url);
  const lookbackRaw = url.searchParams.get('lookbackMinutes') ?? '';
  const lookbackParsed = Number(lookbackRaw);
  const lookbackMinutes =
    Number.isFinite(lookbackParsed) && lookbackParsed > 0 && lookbackParsed <= 1440
      ? Math.floor(lookbackParsed)
      : 60;

  // 1. SELECT due rows.
  let dueRows: DueRow[];
  try {
    const result = await runNamedQuery({
      name: 'select_pair_schedules_due_for_fire',
      params: { tenantId, nowIso, lookbackMinutes },
    });
    dueRows = result.rows as DueRow[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `fire-due-executors: select_due failed: ${msg.slice(0, 256)}` });
  }

  if (dueRows.length === 0) {
    return jsonRes(200, { ok: true, tick: nowIso, dueCount: 0, results: [] });
  }

  // 1b. EC-002-3 cascade-cancel: when multiple planner runs left scheduled
  // rows for the same (pair, session, date), the cron MUST only fire the
  // latest run's row and cancel the older ones. Otherwise N planner runs ×
  // M pair-sessions = N×M executor fires, exhausting the daily cap and
  // firing conflicting executors. The planner doesn't do this cancel
  // itself (KI-006); we defend at the firing layer.
  const dedupedRows: DueRow[] = [];
  const cancelledIds: number[] = [];
  const groupKey = (r: DueRow): string => `${r.pairCode}|${r.sessionName}|${r.date}`;
  const groups = new Map<string, DueRow[]>();
  for (const row of dueRows) {
    const k = groupKey(row);
    const arr = groups.get(k);
    if (arr) arr.push(row);
    else groups.set(k, [row]);
  }
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      dedupedRows.push(arr[0] as DueRow);
      continue;
    }
    // Multiple rows for same (pair, session, date) — pick highest planner_run_id;
    // ties broken by highest schedule id.
    const sorted = [...arr].sort((a, b) => {
      const ar = a.plannerRunId ?? -1;
      const br = b.plannerRunId ?? -1;
      if (ar !== br) return br - ar;
      return b.id - a.id;
    });
    const winner = sorted[0] as DueRow;
    dedupedRows.push(winner);
    for (const loser of sorted.slice(1)) cancelledIds.push(loser.id);
  }

  // Auto-cancel the loser rows (best-effort; if this fails the claim race
  // would still have the cron processing each independently — same as v1.1
  // behaviour, so failing here is graceful-degraded not catastrophic).
  for (const id of cancelledIds) {
    try {
      await runNamedQuery({
        name: 'update_pair_schedule_status',
        params: { tenantId, id, status: 'cancelled' },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[fire-due-executors] cascade-cancel id=${id} failed (continuing): ${msg}\n`,
      );
    }
  }

  // 2. For each (deduped) row: claim → fire → settle.
  const results: FireResult[] = [];
  for (const row of dedupedRows) {
    const claimToken = `claiming-${Date.now()}-${row.id}`;

    // 2a. Atomic claim.
    let claimed = false;
    try {
      const claimResult = await runNamedQuery({
        name: 'claim_pair_schedule_for_fire',
        params: { tenantId, id: row.id, claimToken },
      });
      claimed = (claimResult.rowsAffected ?? 0) > 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome: 'fire-failed',
        error: `claim DB error: ${msg.slice(0, 200)}`,
      });
      continue;
    }
    if (!claimed) {
      // Lost the race to a concurrent cron tick; skip silently.
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome: 'claim-lost',
      });
      continue;
    }

    // 2b. Fire upstream.
    const text = buildExecutorText(row);
    let sessionId: string;
    try {
      const fireResult = await callAnthropicFire('executor', text);
      sessionId = fireResult.session_id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Release the claim so the next tick can retry.
      try {
        await runNamedQuery({
          name: 'update_pair_schedule_one_off_id',
          params: { tenantId, id: row.id, scheduledOneOffId: null },
        });
      } catch (releaseErr) {
        const releaseMsg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        process.stderr.write(
          `[fire-due-executors] release-claim failed for id=${row.id}: ${releaseMsg}\n`,
        );
      }
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome: 'fire-failed',
        error: msg.slice(0, 200),
      });
      void safeTelegramAlert(
        `[caishen] EXECUTOR FIRE FAILED — pair_schedule_id=${row.id} pair=${row.pairCode} session=${row.sessionName}: ${msg.slice(0, 200)}`,
      );
      continue;
    }

    // 2c. Settle row.
    try {
      await runNamedQuery({
        name: 'update_pair_schedule_fired',
        params: { tenantId, id: row.id, scheduledOneOffId: sessionId },
      });
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome: 'fired',
        session_id: sessionId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Already fired upstream — orphan-detect cron will reconcile.
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome: 'settle-failed',
        session_id: sessionId,
        error: msg.slice(0, 200),
      });
      void safeTelegramAlert(
        `[caishen] EXECUTOR SETTLE FAILED — pair_schedule_id=${row.id} session_id=${sessionId} fired but DB update failed: ${msg.slice(0, 200)}`,
      );
    }
  }

  return jsonRes(200, {
    ok: true,
    tick: nowIso,
    lookbackMinutes,
    cascadeCancelledCount: cancelledIds.length,
    dueCount: dueRows.length,
    dedupedCount: dedupedRows.length,
    firedCount: results.filter((r) => r.outcome === 'fired').length,
    results,
  });
}
