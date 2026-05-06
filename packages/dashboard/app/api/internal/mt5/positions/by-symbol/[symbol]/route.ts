/**
 * DELETE /api/internal/mt5/positions/by-symbol/{symbol} --
 *   close ALL open positions for a symbol.
 *
 * v1.1 -- required for the verbatim SPARTAN constraint:
 *   "ALL EURO/London Session's trades will be cleared before US Session
 *    Start, vice versa for US Session's trades per day"
 *
 * The Executor calls this at session-end to flatten its own pair before
 * the next session starts. Operator overrides hit the dashboard's
 * `/api/overrides/close-pair` route (CSRF gated) -- same upstream effect,
 * different access control surface.
 *
 * Upstream MT5 REST: DELETE /api/v1/positions/symbol/{symbol}
 *
 * Symbol path-segment is sanitised: alphanumeric only, uppercased. Same
 * hardening as the GET /api/internal/mt5/positions?symbol= route -- defence
 * against path-injection via crafted symbols.
 *
 * v1.2 FR-027 D2 (R3 additive extension): the response is enriched with
 * `closed_positions[]` -- a sibling array of `{ticket, opened_at}` for each
 * position closed by this DELETE call. The cron close-due-sessions route
 * uses `opened_at` to detect EC-027-4 race ("pending order filled mid-close"
 * -- a position whose opened_at > tickStartAt was opened DURING the close
 * window, indicating the pending DELETE failed and the live pending filled
 * before this positions DELETE landed).
 *
 * Source resolution (per Q1 answer in negotiate review):
 *   1. If upstream MT5 REST already includes `closed_positions[]` in its
 *      response, pass through directly.
 *   2. Otherwise, make ONE additional `mt5Get('/api/v1/positions/history?
 *      tickets=<comma-list>')` call scoped to the just-closed tickets and
 *      merge `opened_at` per ticket.
 *
 * Defensive (W1 watch-item): if the merge step's lookup is partial (one
 * ticket missing from history) OR the mt5Get itself throws, default the
 * missing `opened_at` to null. The cron route's race-detection logic
 * MUST treat `opened_at === null` as race-false (cannot prove the race
 * occurred without the timestamp), so callers stay safe.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Delete, mt5Get } from '@/lib/mt5-server';

interface UpstreamDeleteResponse {
  success?: unknown;
  closed_count?: unknown;
  tickets?: unknown;
  closed_positions?: unknown;
}

interface ClosedPosition {
  ticket: number;
  opened_at: string | null;
}

interface HistoryEntry {
  ticket?: unknown;
  opened_at?: unknown;
}

function sanitiseSymbol(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

interface RouteContext {
  params: Promise<{ symbol: string }>;
}

/**
 * Coerce upstream-supplied closed_positions[] (if present) into the
 * dashboard-route shape `Array<{ticket: number, opened_at: string | null}>`.
 */
function coerceUpstreamClosedPositions(raw: unknown): ClosedPosition[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ClosedPosition[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.ticket !== 'number') continue;
    const openedAt = typeof r.opened_at === 'string' ? r.opened_at : null;
    out.push({ ticket: r.ticket, opened_at: openedAt });
  }
  return out;
}

/**
 * Look up opened_at per ticket via mt5Get('/api/v1/positions/history?...').
 * Returns one entry per input ticket; missing-from-history tickets default
 * to opened_at:null (W1 defensive case).
 */
async function buildClosedPositionsFromHistory(tickets: number[]): Promise<ClosedPosition[]> {
  if (tickets.length === 0) return [];
  let history: HistoryEntry[] = [];
  try {
    const raw = await mt5Get(`/api/v1/positions/history?tickets=${tickets.join(',')}`);
    if (Array.isArray(raw)) history = raw as HistoryEntry[];
  } catch (e) {
    // mt5Get failure must NOT cascade -- the position close itself succeeded.
    // Log + return all-null shape (W1 race-false safety).
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[mt5/positions/by-symbol] history lookup failed (closed_positions[].opened_at defaulting to null): ${msg}\n`,
    );
  }
  const byTicket = new Map<number, string | null>();
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.ticket !== 'number') continue;
    const openedAt = typeof entry.opened_at === 'string' ? entry.opened_at : null;
    byTicket.set(entry.ticket, openedAt);
  }
  return tickets.map((ticket) => ({
    ticket,
    opened_at: byTicket.get(ticket) ?? null,
  }));
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const { symbol: rawSymbol } = await ctx.params;
  const symbol = sanitiseSymbol(rawSymbol);
  if (symbol.length === 0) {
    return jsonRes(400, {
      error: 'mt5/positions/by-symbol/[symbol]: invalid symbol (alphanumeric required)',
    });
  }

  let upstream: UpstreamDeleteResponse;
  try {
    upstream = (await mt5Delete(`/api/v1/positions/symbol/${symbol}`)) as UpstreamDeleteResponse;
  } catch (e) {
    return mapUpstreamError(e, 'mt5/positions/by-symbol DELETE');
  }

  // R3 additive: synthesize closed_positions[] for the response.
  let closedPositions: ClosedPosition[];
  const upstreamClosed = coerceUpstreamClosedPositions(upstream.closed_positions);
  if (upstreamClosed !== null) {
    // Path 1: upstream already has the field; pass through.
    closedPositions = upstreamClosed;
  } else {
    // Path 2: dashboard-route-merge -- fetch opened_at per ticket via history.
    const tickets = Array.isArray(upstream.tickets)
      ? upstream.tickets.filter((t): t is number => typeof t === 'number')
      : [];
    closedPositions = await buildClosedPositionsFromHistory(tickets);
  }

  return jsonRes(200, {
    ...upstream,
    closed_positions: closedPositions,
  });
}
