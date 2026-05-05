/**
 * DELETE /api/internal/mt5/orders/pending/by-symbol/{symbol} —
 *   cancel ALL pending orders on this pair.
 *
 * Upstream: DELETE /api/v1/order/pending/symbol/{symbol}
 *
 * Used at session-end (alongside the position-close route) so the next
 * session's executor sees a clean slate. Verbatim "ALL EURO/London
 * Session's trades will be cleared before US Session Start" applies to
 * un-filled pendings as much as filled positions.
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
      error: 'mt5/orders/pending/by-symbol/[symbol]: invalid symbol (alphanumeric required)',
    });
  }

  try {
    const upstream = await mt5Delete(`/api/v1/order/pending/symbol/${symbol}`);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/orders/pending/by-symbol DELETE');
  }
}
