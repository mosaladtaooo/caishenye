/**
 * GET /api/cron/close-due-sessions -- every-minute session-end close tick.
 *
 * v1.1.1 -- closes the gap from v1.1 where pair_schedules' end_time_gmt was
 * never enforced. Per the verbatim SPARTAN prompt:
 *   "ALL EURO/London Session's trades will be cleared before US Session
 *    Start, vice versa for US Session's trades per day."
 *
 * v1.2 FR-027 D2 extension:
 *   - cancelPendingBySymbol() called BEFORE closePositionsBySymbol() per pair
 *     (R8 ordering pin -- pending must be cancelled before close so they
 *     don't fill mid-close).
 *   - tickStartAt captured FIRST per R8 (renamed from nowIso for intent
 *     consolidation; same value).
 *   - Response shape extended additively: per-pair entry now carries
 *     {cancelled_pending_count, closed_count, closed_positions[],
 *      closed_due_to_pending_fill_during_close, errors[]}.
 *   - 5-case Telegram wording per AC-027-3:
 *       1+1: "closed N position + cancelled N pending"
 *       0+1: "cancelled N pending (no open positions)"
 *       1+0: "closed N position (no pending orders)"
 *       0+0: NO Telegram (idempotent silence)
 *       race: "pending filled mid-close, position closed at {fill_price}"
 *   - EC-027-4 race detection: a closed_position whose opened_at > tickStartAt
 *     was opened during the close window (the pending DELETE failed, the
 *     pending filled before this positions DELETE landed).
 *   - W1 watch-item: opened_at:null is treated as race-FALSE (cannot prove
 *     race without timestamp).
 *
 * Lookback window default: 60 min. Operator can ?lookbackMinutes=240 to
 * recover sessions whose end_time was missed by GH Actions cron throttling.
 *
 * Idempotent: MT5's close-by-symbol returns success with closed_count=0 if
 * nothing to close; same for cancel-pending-by-symbol. Multiple ticks see
 * the same row in its 5-min window; only the first actually closes anything.
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

interface ClosedPosition {
  ticket: number;
  opened_at: string | null;
  fill_price?: number;
}

interface CloseResult {
  pair_schedule_id: number;
  pair: string;
  session: string;
  outcome: 'closed' | 'close-failed' | 'nothing-to-close';
  cancelled_pending_count: number | null;
  closed_count: number;
  closed_positions: ClosedPosition[];
  closed_due_to_pending_fill_during_close: boolean;
  errors: Array<{ step: string; upstream_status?: number; message: string }>;
}

interface CancelPendingOutcome {
  ok: boolean;
  cancelled_count: number;
  error?: string;
  upstream_status?: number;
}

interface ClosePositionsOutcome {
  ok: boolean;
  closed_count: number;
  closed_positions: ClosedPosition[];
  error?: string;
  upstream_status?: number;
}

function pairToMt5Symbol(pairCode: string): string {
  // EUR/USD -> EURUSD; XAU/USD -> XAUUSD; alphanumeric only.
  return pairCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

async function cancelPendingBySymbol(symbol: string): Promise<CancelPendingOutcome> {
  const baseUrl = process.env.AUTH_URL ?? 'https://caishenv2.vercel.app';
  const internalToken = process.env.INTERNAL_API_TOKEN ?? '';
  if (internalToken.length === 0) {
    return { ok: false, cancelled_count: 0, error: 'INTERNAL_API_TOKEN missing in env' };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/internal/mt5/orders/pending/by-symbol/${encodeURIComponent(symbol)}`;
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
      return {
        ok: false,
        cancelled_count: 0,
        upstream_status: r.status,
        error: `HTTP ${r.status}: ${body.slice(0, 200)}`,
      };
    }
    const json = (await r.json()) as { cancelled_count?: unknown };
    const cancelled = typeof json.cancelled_count === 'number' ? json.cancelled_count : 0;
    return { ok: true, cancelled_count: cancelled };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      cancelled_count: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function closePositionsBySymbol(symbol: string): Promise<ClosePositionsOutcome> {
  const baseUrl = process.env.AUTH_URL ?? 'https://caishenv2.vercel.app';
  const internalToken = process.env.INTERNAL_API_TOKEN ?? '';
  if (internalToken.length === 0) {
    return {
      ok: false,
      closed_count: 0,
      closed_positions: [],
      error: 'INTERNAL_API_TOKEN missing in env',
    };
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
      return {
        ok: false,
        closed_count: 0,
        closed_positions: [],
        upstream_status: r.status,
        error: `HTTP ${r.status}: ${body.slice(0, 200)}`,
      };
    }
    const json = (await r.json()) as {
      closed_count?: unknown;
      closed_positions?: unknown;
    };
    const closedCount = typeof json.closed_count === 'number' ? json.closed_count : 0;
    const closedPositions: ClosedPosition[] = Array.isArray(json.closed_positions)
      ? json.closed_positions
          .filter(
            (cp: unknown): cp is Record<string, unknown> => cp !== null && typeof cp === 'object',
          )
          .map((cp) => ({
            ticket: typeof cp.ticket === 'number' ? cp.ticket : 0,
            opened_at: typeof cp.opened_at === 'string' ? cp.opened_at : null,
            fill_price: typeof cp.fill_price === 'number' ? cp.fill_price : undefined,
          }))
      : [];
    return { ok: true, closed_count: closedCount, closed_positions: closedPositions };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      closed_count: 0,
      closed_positions: [],
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

/**
 * Per AC-027-3 + EC-027-4: build the right Telegram-alert string for the
 * outcome of a single pair's close-due tick. Returns null when no Telegram
 * should be emitted (the 0+0 idempotent-silence case).
 */
function buildTelegramText(args: {
  pair: string;
  cancelled: number;
  closed: number;
  raceDetected: boolean;
  raceFillPrice: number | undefined;
  pendingFailed: boolean;
}): string | null {
  // EC-027-4 race detection takes precedence (case 5).
  if (args.raceDetected) {
    const priceStr =
      typeof args.raceFillPrice === 'number' ? args.raceFillPrice.toString() : 'unknown';
    return `Session ended for ${args.pair}: pending filled mid-close, position closed at ${priceStr}`;
  }
  // EC-027-2 pending-DELETE failed but positions OK (special wording).
  if (args.pendingFailed) {
    if (args.closed > 0) {
      return `Session ended for ${args.pair}: closed ${args.closed} position + PENDING-CANCEL FAILED (see logs)`;
    }
    return `Session ended for ${args.pair}: PENDING-CANCEL FAILED (see logs); 0 positions to close`;
  }
  // 5-case wording per AC-027-3.
  if (args.closed > 0 && args.cancelled > 0) {
    return `Session ended for ${args.pair}: closed ${args.closed} position + cancelled ${args.cancelled} pending`;
  }
  if (args.closed === 0 && args.cancelled > 0) {
    return `Session ended for ${args.pair}: cancelled ${args.cancelled} pending (no open positions)`;
  }
  if (args.closed > 0 && args.cancelled === 0) {
    return `Session ended for ${args.pair}: closed ${args.closed} position (no pending orders)`;
  }
  // 0+0: silence.
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  // R8 PIN: tickStartAt captured FIRST (BEFORE any await on mt5/postgres).
  const tickStartAt = new Date().toISOString();

  const tenantId =
    Number.isFinite(DEFAULT_TENANT_ID) && DEFAULT_TENANT_ID > 0 ? DEFAULT_TENANT_ID : 1;

  // Lookback override -- same pattern as fire-due-executors.
  const url = new URL(req.url);
  const lookbackRaw = url.searchParams.get('lookbackMinutes') ?? '';
  const lookbackParsed = Number(lookbackRaw);
  const lookbackMinutes =
    Number.isFinite(lookbackParsed) && lookbackParsed > 0 && lookbackParsed <= 1440
      ? Math.floor(lookbackParsed)
      : 60;

  // 1. SELECT due-for-close rows.
  let dueRows: DueRow[];
  try {
    const result = await runNamedQuery({
      name: 'select_pair_schedules_due_for_close',
      params: { tenantId, nowIso: tickStartAt, lookbackMinutes },
    });
    dueRows = result.rows as DueRow[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, {
      error: `close-due-sessions: select_due_for_close failed: ${msg.slice(0, 256)}`,
    });
  }

  if (dueRows.length === 0) {
    return jsonRes(200, { ok: true, tick: tickStartAt, dueCount: 0, results: [] });
  }

  // 2. Per pair (dedupe).
  const byPair = new Map<string, DueRow[]>();
  for (const row of dueRows) {
    const arr = byPair.get(row.pairCode);
    if (arr) arr.push(row);
    else byPair.set(row.pairCode, [row]);
  }

  const tickStartMs = Date.parse(tickStartAt);
  const results: CloseResult[] = [];

  for (const [pairCode, rows] of byPair.entries()) {
    const symbol = pairToMt5Symbol(pairCode);

    // R8 ordering: cancel pending FIRST so they don't fill mid-close.
    const cancelOutcome = await cancelPendingBySymbol(symbol);
    const closeOutcome = await closePositionsBySymbol(symbol);

    // EC-027-4 race detection on closed_positions[].opened_at vs tickStartAt.
    let raceDetected = false;
    let raceFillPrice: number | undefined;
    if (!cancelOutcome.ok && closeOutcome.ok && closeOutcome.closed_positions.length > 0) {
      for (const cp of closeOutcome.closed_positions) {
        // W1 watch-item: opened_at:null -> race-false (cannot prove race).
        if (cp.opened_at === null) continue;
        const openedMs = Date.parse(cp.opened_at);
        if (Number.isFinite(openedMs) && openedMs > tickStartMs) {
          raceDetected = true;
          raceFillPrice = cp.fill_price;
          break;
        }
      }
    }

    // Build the per-pair errors[] array.
    const errors: CloseResult['errors'] = [];
    if (!cancelOutcome.ok) {
      errors.push({
        step: 'cancel_pending',
        upstream_status: cancelOutcome.upstream_status,
        message: cancelOutcome.error ?? 'unknown',
      });
    }
    if (!closeOutcome.ok) {
      errors.push({
        step: 'close_positions',
        upstream_status: closeOutcome.upstream_status,
        message: closeOutcome.error ?? 'unknown',
      });
    }

    // Outcome string for the per-row results entries (preserves v1.1 contract).
    const outcome: CloseResult['outcome'] = !closeOutcome.ok
      ? 'close-failed'
      : closeOutcome.closed_count > 0
        ? 'closed'
        : 'nothing-to-close';

    // Telegram wording.
    const tgText = buildTelegramText({
      pair: pairCode,
      cancelled: cancelOutcome.ok ? cancelOutcome.cancelled_count : 0,
      closed: closeOutcome.closed_count,
      raceDetected,
      raceFillPrice,
      pendingFailed: !cancelOutcome.ok,
    });
    if (tgText !== null) {
      void safeTelegramAlert(`[caishen] ${tgText}`);
    }

    for (const row of rows) {
      results.push({
        pair_schedule_id: row.id,
        pair: row.pairCode,
        session: row.sessionName,
        outcome,
        // EC-027-2: cancel failed -> cancelled_pending_count = null (sentinel).
        cancelled_pending_count: cancelOutcome.ok ? cancelOutcome.cancelled_count : null,
        closed_count: closeOutcome.closed_count,
        closed_positions: closeOutcome.closed_positions,
        closed_due_to_pending_fill_during_close: raceDetected,
        errors,
      });
    }
  }

  return jsonRes(200, {
    ok: true,
    tick: tickStartAt,
    dueCount: dueRows.length,
    pairsClosedCount: results.filter((r) => r.outcome === 'closed').length,
    results,
  });
}
