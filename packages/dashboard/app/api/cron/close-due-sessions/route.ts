/**
 * GET /api/cron/close-due-sessions — every-minute session-end close tick.
 *
 * v1.1.1 — closes the gap from v1.1 where pair_schedules' end_time_gmt was
 * never enforced. Per the verbatim SPARTAN prompt:
 *   "ALL EURO/London Session's trades will be cleared before US Session
 *    Start, vice versa for US Session's trades per day."
 *
 * v1.1 added the close-by-symbol DELETE route (Phase B AC-022-2) but no
 * scheduler called it. This cron polls pair_schedules where status='fired'
 * AND end_time_gmt has passed (within 5-min lookback), then calls
 * `DELETE /api/internal/mt5/positions/by-symbol/{symbol}` to close any
 * still-open positions for that pair.
 *
 * Lookback window is 5 min: a one-minute cron interval handles real-time
 * cleanly; the 5-min buffer is for jittered GitHub Actions cron windows.
 * Beyond that, a missed close is operator-investigation territory (cap +
 * Telegram alert system catches operator attention by other paths).
 *
 * Idempotent: MT5's close-by-symbol returns success-shape with closed_count=0
 * if nothing to close. So even if multiple cron ticks see the same row in
 * its 5-min window, only the first actually closes anything.
 *
 * No status update on the pair_schedules row in v1.1.1 — adding a "closed"
 * status would require a migration; deferred to v1.2. Telegram alerts +
 * the MT5 positions API are the source of truth that the close happened.
 *
 * Auth: CRON_SECRET (same as fire-due-executors).
 */

import { validateCronAuth } from '@/lib/cron-auth';
import { runNamedQuery } from '@/lib/internal-postgres-queries';
import { jsonRes } from '@/lib/internal-route-helpers';

export const maxDuration = 30;

const CLOSE_TIMEOUT_MS = 15_000;
const DEFAULT_TENANT_ID = Number(process.env.DEFAULT_TENANT_ID ?? '1');

interface DueRow {
  id: number;
  tenantId: number;
  pairCode: string;
  sessionName: string;
  startTimeGmt: string | Date | null;
  endTimeGmt: string | Date | null;
}

interface CloseResult {
  pair_schedule_id: number;
  pair: string;
  session: string;
  outcome: 'closed' | 'close-failed' | 'nothing-to-close';
  closed_count?: number;
  error?: string;
}

function pairToMt5Symbol(pairCode: string): string {
  // EUR/USD → EURUSD; XAU/USD → XAUUSD; alphanumeric only.
  return pairCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

async function closePositionsBySymbol(symbol: string): Promise<{
  ok: boolean;
  closed_count: number;
  error?: string;
}> {
  const baseUrl = process.env.AUTH_URL ?? 'https://caishenv2.vercel.app';
  const internalToken = process.env.INTERNAL_API_TOKEN ?? '';
  if (internalToken.length === 0) {
    return { ok: false, closed_count: 0, error: 'INTERNAL_API_TOKEN missing in env' };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/internal/mt5/positions/by-symbol/${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOSE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${internalToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, closed_count: 0, error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    const json = (await r.json()) as { closed_count?: unknown; success?: unknown };
    const closedCount = typeof json.closed_count === 'number' ? json.closed_count : 0;
    return { ok: true, closed_count: closedCount };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      closed_count: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function safeTelegramAlert(text: string): Promise<void> {
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
      process.stderr.write(`[close-due-sessions] telegram alert failed: HTTP ${r.status}\n`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[close-due-sessions] telegram alert exception: ${msg}\n`);
  }
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  const tenantId =
    Number.isFinite(DEFAULT_TENANT_ID) && DEFAULT_TENANT_ID > 0 ? DEFAULT_TENANT_ID : 1;
  const nowIso = new Date().toISOString();

  // 1. SELECT due-for-close rows.
  let dueRows: DueRow[];
  try {
    const result = await runNamedQuery({
      name: 'select_pair_schedules_due_for_close',
      params: { tenantId, nowIso },
    });
    dueRows = result.rows as DueRow[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, {
      error: `close-due-sessions: select_due_for_close failed: ${msg.slice(0, 256)}`,
    });
  }

  if (dueRows.length === 0) {
    return jsonRes(200, { ok: true, tick: nowIso, dueCount: 0, results: [] });
  }

  // 2. Per pair (dedupe — multiple sessions for same pair would close twice).
  // Group by pair_code so each pair gets ONE close call regardless of how
  // many of its sessions have due end_time. Keep all schedule_ids in
  // results so audit trace is complete.
  const byPair = new Map<string, DueRow[]>();
  for (const row of dueRows) {
    const arr = byPair.get(row.pairCode);
    if (arr) arr.push(row);
    else byPair.set(row.pairCode, [row]);
  }

  const results: CloseResult[] = [];
  for (const [pairCode, rows] of byPair.entries()) {
    const symbol = pairToMt5Symbol(pairCode);
    const closeResult = await closePositionsBySymbol(symbol);

    if (!closeResult.ok) {
      for (const row of rows) {
        results.push({
          pair_schedule_id: row.id,
          pair: row.pairCode,
          session: row.sessionName,
          outcome: 'close-failed',
          error: closeResult.error,
        });
      }
      void safeTelegramAlert(
        `[caishen] SESSION-END CLOSE FAILED -- pair=${pairCode}: ${closeResult.error?.slice(0, 200) ?? 'unknown'}`,
      );
      continue;
    }

    const outcome: CloseResult['outcome'] =
      closeResult.closed_count > 0 ? 'closed' : 'nothing-to-close';
    for (const row of rows) {
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome,
        closed_count: closeResult.closed_count,
      });
    }
    if (closeResult.closed_count > 0) {
      void safeTelegramAlert(
        `[caishen] Session-end close OK -- ${pairCode}: ${closeResult.closed_count} position(s) closed at ${nowIso}`,
      );
    }
  }

  return jsonRes(200, {
    ok: true,
    tick: nowIso,
    dueCount: dueRows.length,
    pairsClosedCount: results.filter((r) => r.outcome === 'closed').length,
    results,
  });
}
