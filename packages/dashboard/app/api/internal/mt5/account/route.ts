/**
 * GET /api/internal/mt5/account — proxy to MT5 REST /account.
 *
 * Per ADR-012: Routine-side curl (Authorization: Bearer
 * ${INTERNAL_API_TOKEN}) → this handler → mt5Get('/account') → upstream.
 *
 * mt5-server.ts already implements EC-003-1 retry-with-backoff (2× 10s) and
 * env validation (throws 'mt5: MT5_BASE_URL missing in env'). We translate
 * thrown errors via mapUpstreamError to keep response codes consistent
 * across the /api/internal/* surface.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Get } from '@/lib/mt5-server';

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  try {
    const upstream = await mt5Get('/account');
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/account');
  }
}
