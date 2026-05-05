/**
 * DELETE /api/internal/mt5/positions/by-symbol/{symbol} —
 *   close ALL open positions for a symbol.
 *
 * v1.1 — required for the verbatim SPARTAN constraint:
 *   "ALL EURO/London Session's trades will be cleared before US Session
 *    Start, vice versa for US Session's trades per day"
 *
 * The Executor calls this at session-end to flatten its own pair before
 * the next session starts. Operator overrides hit the dashboard's
 * `/api/overrides/close-pair` route (Auth.js + CSRF gated) — same upstream
 * effect, different access control surface.
 *
 * Upstream MT5 REST: DELETE /api/v1/positions/symbol/{symbol}
 *
 * Symbol path-segment is sanitised: alphanumeric only, uppercased. Same
 * hardening as the GET /api/internal/mt5/positions?symbol= route — defence
 * against path-injection via crafted symbols.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Delete } from '@/lib/mt5-server';

function sanitiseSymbol(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

interface RouteContext {
  params: Promise<{ symbol: string }>;
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

  try {
    const upstream = await mt5Delete(`/api/v1/positions/symbol/${symbol}`);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/positions/by-symbol DELETE');
  }
}
