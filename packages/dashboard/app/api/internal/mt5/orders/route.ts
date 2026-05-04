/**
 * POST /api/internal/mt5/orders — proxy for MT5 market-order placement.
 *
 * Forwards to the n8n-canonical `POST /api/v1/order/market` endpoint
 * (verified via `财神爷 Agent.json`'s order-market HTTP-tool node).
 *
 * Session 5g — corrected path from `/orders` to `/api/v1/order/market` and
 * remapped the body shape to what the upstream MT5 server actually accepts:
 *
 *   Routine-side (this proxy's contract — kept ergonomic for Claude):
 *     { symbol: string, side: 'buy'|'sell', volume: number > 0,
 *       sl?: number, tp?: number, comment?: string }
 *
 *   Upstream MT5 REST shape (we translate):
 *     { symbol: string, volume: number, type: 'BUY'|'SELL',
 *       stop_loss?: number, take_profit?: number, comment?: string }
 *
 * Strict allow-list — extra fields are stripped before forwarding (defence
 * against prompt-injection via the Routine).
 *
 * Symbol is sanitised (alphanumeric only, uppercased) — same hardening the
 * n8n workflow's $fromAI("symbol", ...).replace(/[^a-zA-Z0-9]/g,"").toUpperCase()
 * step performs.
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

interface UpstreamOrderBody {
  symbol: string;
  volume: number;
  type: 'BUY' | 'SELL';
  stop_loss?: number;
  take_profit?: number;
  comment?: string;
}

function sanitiseSymbol(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
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

function toUpstream(body: OrderBody): UpstreamOrderBody {
  const upstream: UpstreamOrderBody = {
    symbol: sanitiseSymbol(body.symbol),
    volume: body.volume,
    type: body.side === 'buy' ? 'BUY' : 'SELL',
  };
  if (typeof body.sl === 'number') upstream.stop_loss = body.sl;
  if (typeof body.tp === 'number') upstream.take_profit = body.tp;
  if (typeof body.comment === 'string') upstream.comment = body.comment;
  return upstream;
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
    const upstream = await mt5Post('/api/v1/order/market', toUpstream(body));
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/orders');
  }
}
