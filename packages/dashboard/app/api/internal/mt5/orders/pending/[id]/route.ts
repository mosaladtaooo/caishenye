/**
 * DELETE /api/internal/mt5/orders/pending/{id} — cancel one specific pending order.
 *
 * Upstream: DELETE /api/v1/order/pending/{id}
 *
 * Used when MSCP analysis invalidates a previously-placed pending order
 * (e.g., the structural level the order was waiting at got broken before
 * a retracement; or the planner re-fired and a new schedule replaced this
 * pair's window).
 *
 * Path-segment id sanitised (positive integer only) — defence against
 * curl-from-Routine path-injection.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Delete } from '@/lib/mt5-server';

function validateId(raw: string): string | null {
  if (raw.length === 0) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  return raw;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const { id: rawId } = await ctx.params;
  const id = validateId(rawId);
  if (id === null) {
    return jsonRes(400, {
      error: 'mt5/orders/pending/[id]: invalid id (must be a positive integer)',
    });
  }

  try {
    const upstream = await mt5Delete(`/api/v1/order/pending/${id}`);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/orders/pending/[id] DELETE');
  }
}
