/**
 * GET /api/internal/mt5/positions — proxy to MT5 REST /positions.
 * ADR-012 proxy gateway. Same shape as /api/internal/mt5/account.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Get } from '@/lib/mt5-server';

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  try {
    const upstream = await mt5Get('/positions');
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/positions');
  }
}
