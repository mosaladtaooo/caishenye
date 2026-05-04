/**
 * GET /api/internal/mt5/candles?symbol=&timeframe=&count= (latest mode)
 * GET /api/internal/mt5/candles?symbol=&timeframe=&date_from=&date_to= (date mode)
 *
 * Session 5g — corrected paths to the n8n-canonical `/api/v1/...` shape:
 *   - count mode → GET /api/v1/market/candles/latest
 *       upstream params: symbol_name, timeframe, count
 *   - date mode → GET /api/v1/market/candles/date
 *       upstream params: symbol_name, timeframe, date_from, date_to
 *
 * Note the upstream uses `symbol_name` (not `symbol`) — verified via
 * `财神爷 Agent.json`'s candles HTTP-tool nodes. Our Routine-facing query
 * accepts the ergonomic `symbol=` for consistency with /positions and
 * /orders; we translate to `symbol_name=` before forwarding.
 *
 * Symbol is sanitised (alphanumeric only, uppercased) — matches n8n's
 * $fromAI("symbol_name", ...).replace(/[^a-zA-Z0-9]/g,"").toUpperCase().
 *
 * Vercel Hobby default is 10s; we set maxDuration=30s for headroom on
 * count=250+ over Tailscale Funnel (per routines-architecture.md § 8).
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Get } from '@/lib/mt5-server';

export const maxDuration = 30;

const TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1']);
const MAX_COUNT = 500;

function sanitiseSymbol(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const rawSymbol = url.searchParams.get('symbol') ?? '';
  const timeframe = url.searchParams.get('timeframe') ?? '';
  const countStr = url.searchParams.get('count') ?? '';
  const dateFrom = url.searchParams.get('date_from') ?? '';
  const dateTo = url.searchParams.get('date_to') ?? '';

  if (rawSymbol.length === 0) {
    return jsonRes(400, { error: 'missing symbol query param' });
  }
  if (!TIMEFRAMES.has(timeframe)) {
    return jsonRes(400, {
      error: `invalid timeframe; must be one of ${[...TIMEFRAMES].join(',')}`,
    });
  }

  const symbol = sanitiseSymbol(rawSymbol);

  // Mode discrimination — count XOR (date_from + date_to).
  const hasCount = countStr.length > 0;
  const hasDateRange = dateFrom.length > 0 || dateTo.length > 0;

  if (hasCount && hasDateRange) {
    return jsonRes(400, {
      error: 'choose ONE mode: either count, OR date_from+date_to (not both)',
    });
  }

  let path: string;
  if (hasCount) {
    const count = Number(countStr);
    if (!Number.isFinite(count) || count <= 0 || count > MAX_COUNT) {
      return jsonRes(400, { error: `invalid count; must be 1..${MAX_COUNT}` });
    }
    path = `/api/v1/market/candles/latest?symbol_name=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&count=${count}`;
  } else if (dateFrom.length > 0 && dateTo.length > 0) {
    // date mode — both date_from + date_to required.
    path = `/api/v1/market/candles/date?symbol_name=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`;
  } else {
    return jsonRes(400, {
      error: 'invalid query: provide either count (latest mode) or date_from+date_to (date mode)',
    });
  }

  try {
    const upstream = await mt5Get(path);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/candles');
  }
}
