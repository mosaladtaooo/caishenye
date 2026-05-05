/**
 * POST /api/internal/mt5/orders/pending — pending-order placement tests.
 *
 *   - Auth gate (401 / 500-LOUD on missing INTERNAL_API_TOKEN)
 *   - Body validation: requires symbol, side, volume>0, price>0; sl/tp optional
 *   - Translates side→type ("buy"→"BUY", "sell"→"SELL"), sl→stop_loss, tp→take_profit
 *   - Sanitizes symbol (alphanumeric uppercased) before forwarding
 *   - Strips extra fields before forwarding (allow-list)
 *   - Forwards to upstream POST /api/v1/order/pending
 *   - Upstream errors mapped via mapUpstreamError
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let mt5PostSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  mt5PostSpy = vi.fn();
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('../../../lib/mt5-server', () => ({
    mt5Get: vi.fn(),
    mt5Post: mt5PostSpy,
    mt5Put: vi.fn(),
    mt5Delete: vi.fn(),
  }));
  return await import('../../../app/api/internal/mt5/orders/pending/route');
}

function buildReq(headerValue: string | undefined, body: unknown): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/mt5/orders/pending', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = {
  symbol: 'EURUSD',
  side: 'buy' as const,
  volume: 0.1,
  price: 1.082,
  sl: 1.0795,
  tp: 1.087,
};

describe('POST /api/internal/mt5/orders/pending — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq(undefined, validBody));
    expect(res.status).toBe(401);
    expect(mt5PostSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`, validBody));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/internal/mt5/orders/pending — body validation', () => {
  it('400 on malformed JSON', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`, '{not json'));
    expect(res.status).toBe(400);
  });

  it.each([
    ['missing symbol', { side: 'buy', volume: 0.1, price: 1.08 }],
    ['empty symbol', { symbol: '', side: 'buy', volume: 0.1, price: 1.08 }],
    ['invalid side', { symbol: 'EURUSD', side: 'long', volume: 0.1, price: 1.08 }],
    ['volume <= 0', { symbol: 'EURUSD', side: 'buy', volume: 0, price: 1.08 }],
    ['volume not number', { symbol: 'EURUSD', side: 'buy', volume: '0.1', price: 1.08 }],
    ['price <= 0', { symbol: 'EURUSD', side: 'buy', volume: 0.1, price: 0 }],
    ['price not number', { symbol: 'EURUSD', side: 'buy', volume: 0.1, price: '1.08' }],
    ['sl not number', { symbol: 'EURUSD', side: 'buy', volume: 0.1, price: 1.08, sl: 'low' }],
    ['tp Infinity', { symbol: 'EURUSD', side: 'buy', volume: 0.1, price: 1.08, tp: Infinity }],
  ])('400 on %s', async (_label, body) => {
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`, body));
    expect(res.status).toBe(400);
    expect(mt5PostSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/mt5/orders/pending — translation', () => {
  it('translates buy/sl/tp + sanitises symbol + strips extras', async () => {
    mt5PostSpy.mockResolvedValue({ success: true, ticket: 999 });
    const route = await importRoute();
    const res = await route.POST(
      buildReq(`Bearer ${fixtureBearer}`, {
        ...validBody,
        symbol: 'eur/usd', // sanitised → EURUSD
        magic_number: 12345, // extra field — should be stripped
      }),
    );
    expect(res.status).toBe(200);
    expect(mt5PostSpy).toHaveBeenCalledWith('/api/v1/order/pending', {
      symbol: 'EURUSD',
      type: 'BUY',
      volume: 0.1,
      price: 1.082,
      stop_loss: 1.0795,
      take_profit: 1.087,
    });
  });

  it('translates sell → SELL', async () => {
    mt5PostSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.POST(
      buildReq(`Bearer ${fixtureBearer}`, {
        symbol: 'XAUUSD',
        side: 'sell',
        volume: 0.5,
        price: 2400,
      }),
    );
    expect(mt5PostSpy).toHaveBeenCalledWith('/api/v1/order/pending', {
      symbol: 'XAUUSD',
      type: 'SELL',
      volume: 0.5,
      price: 2400,
    });
  });

  it('omits stop_loss when sl not provided', async () => {
    mt5PostSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.POST(
      buildReq(`Bearer ${fixtureBearer}`, {
        symbol: 'EURUSD',
        side: 'buy',
        volume: 0.1,
        price: 1.08,
      }),
    );
    const arg = mt5PostSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('stop_loss');
    expect(arg).not.toHaveProperty('take_profit');
  });

  it('forwards comment when provided', async () => {
    mt5PostSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.POST(
      buildReq(`Bearer ${fixtureBearer}`, {
        ...validBody,
        comment: 'caishen-pending-EURUSD-EUR',
      }),
    );
    expect(mt5PostSpy).toHaveBeenCalledWith(
      '/api/v1/order/pending',
      expect.objectContaining({ comment: 'caishen-pending-EURUSD-EUR' }),
    );
  });
});

describe('POST /api/internal/mt5/orders/pending — upstream errors', () => {
  it('returns mapped error when upstream throws', async () => {
    mt5PostSpy.mockRejectedValue(new Error('mt5: POST → HTTP 504: timeout'));
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`, validBody));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
