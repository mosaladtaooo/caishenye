/**
 * GET /api/internal/mt5/candles?symbol=&timeframe=&count=
 *
 * Forwards to mt5Get('/candles?...') after validating query params.
 * Vercel Hobby default is 10s; we set maxDuration=30s for headroom on
 * count=250+ over Tailscale Funnel (per routines-architecture.md § 8).
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Get } from '@/lib/mt5-server';

export const maxDuration = 30;

const TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1']);
const MAX_COUNT = 500;

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol') ?? '';
  const timeframe = url.searchParams.get('timeframe') ?? '';
  const countStr = url.searchParams.get('count') ?? '';

  if (symbol.length === 0) {
    return jsonRes(400, { error: 'missing symbol query param' });
  }
  if (!TIMEFRAMES.has(timeframe)) {
    return jsonRes(400, {
      error: `invalid timeframe; must be one of ${[...TIMEFRAMES].join(',')}`,
    });
  }
  const count = Number(countStr);
  if (!Number.isFinite(count) || count <= 0 || count > MAX_COUNT) {
    return jsonRes(400, { error: `invalid count; must be 1..${MAX_COUNT}` });
  }

  const path = `/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&count=${count}`;
  try {
    const upstream = await mt5Get(path);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/candles');
  }
}
