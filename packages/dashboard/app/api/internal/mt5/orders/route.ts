/**
 * POST /api/internal/mt5/orders — proxy for MT5 order placement.
 *
 * Body validation: { symbol: string, side: 'buy'|'sell', volume: number > 0,
 * sl?: number, tp?: number, comment?: string }. Strict allow-list — extra
 * fields are stripped before forwarding (defence against prompt-injection
 * via the Routine).
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Post } from '@/lib/mt5-server';

interface OrderBody {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  sl?: number;
  tp?: number;
  comment?: string;
}

function validateBody(raw: unknown): OrderBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return null;
  if (r.side !== 'buy' && r.side !== 'sell') return null;
  if (typeof r.volume !== 'number' || !(r.volume > 0)) return null;
  const out: OrderBody = { symbol: r.symbol, side: r.side, volume: r.volume };
  if (typeof r.sl === 'number') out.sl = r.sl;
  if (typeof r.tp === 'number') out.tp = r.tp;
  if (typeof r.comment === 'string') out.comment = r.comment;
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRes(400, { error: 'invalid JSON body' });
  }

  const body = validateBody(raw);
  if (!body) {
    return jsonRes(400, {
      error: 'invalid body: require { symbol, side: buy|sell, volume>0 } + optional sl/tp/comment',
    });
  }

  try {
    const upstream = await mt5Post('/orders', body);
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/orders');
  }
}
