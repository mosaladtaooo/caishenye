/**
 * POST /api/internal/mt5/orders/pending — proxy for MT5 REST pending-order placement.
 *
 * v1.1 Phase C — adds the verbatim "PLACE LIMIT/STOP ORDER IF" branch the
 * SPARTAN prompt requires when the current market price has moved too far
 * for a market entry to satisfy the R:R ratio.
 *
 * Upstream MT5 REST: POST /api/v1/order/pending with body
 *   { symbol, volume, type ("BUY"|"SELL"), price, stop_loss?, take_profit? }
 *
 * The MT5 server determines limit vs stop based on `price` relative to the
 * current market price (BUY below market = LIMIT; BUY above market = STOP;
 * SELL above market = LIMIT; SELL below market = STOP). The n8n executor
 * used the same simplified shape — preserving for parity.
 *
 * Routine-facing contract (kept ergonomic for Claude):
 *   { symbol, side ("buy"|"sell"), volume, price, sl?, tp?, comment? }
 *
 * Strict allow-list — extra fields are stripped before forwarding.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes, mapUpstreamError } from '@/lib/internal-route-helpers';
import { mt5Post } from '@/lib/mt5-server';

interface PendingOrderBody {
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  price: number;
  sl?: number;
  tp?: number;
  comment?: string;
}

interface UpstreamPendingBody {
  symbol: string;
  volume: number;
  type: 'BUY' | 'SELL';
  price: number;
  stop_loss?: number;
  take_profit?: number;
  comment?: string;
}

function sanitiseSymbol(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function validateBody(raw: unknown): PendingOrderBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return null;
  if (r.side !== 'buy' && r.side !== 'sell') return null;
  if (typeof r.volume !== 'number' || !(r.volume > 0)) return null;
  if (typeof r.price !== 'number' || !Number.isFinite(r.price) || r.price <= 0) return null;
  const out: PendingOrderBody = {
    symbol: r.symbol,
    side: r.side,
    volume: r.volume,
    price: r.price,
  };
  if (r.sl !== undefined) {
    if (typeof r.sl !== 'number' || !Number.isFinite(r.sl)) return null;
    out.sl = r.sl;
  }
  if (r.tp !== undefined) {
    if (typeof r.tp !== 'number' || !Number.isFinite(r.tp)) return null;
    out.tp = r.tp;
  }
  if (r.comment !== undefined) {
    if (typeof r.comment !== 'string') return null;
    out.comment = r.comment;
  }
  return out;
}

function toUpstream(body: PendingOrderBody): UpstreamPendingBody {
  const upstream: UpstreamPendingBody = {
    symbol: sanitiseSymbol(body.symbol),
    volume: body.volume,
    type: body.side === 'buy' ? 'BUY' : 'SELL',
    price: body.price,
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
    return jsonRes(400, { error: 'mt5/orders/pending: invalid JSON body' });
  }
  const body = validateBody(raw);
  if (body === null) {
    return jsonRes(400, {
      error:
        'mt5/orders/pending: body must be { symbol, side: buy|sell, volume>0, price>0, sl?, tp?, comment? }',
    });
  }

  try {
    const upstream = await mt5Post('/api/v1/order/pending', toUpstream(body));
    return jsonRes(200, upstream);
  } catch (e) {
    return mapUpstreamError(e, 'mt5/orders/pending');
  }
}
