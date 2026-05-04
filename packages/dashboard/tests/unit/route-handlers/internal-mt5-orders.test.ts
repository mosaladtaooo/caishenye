/**
 * POST /api/internal/mt5/orders — proxy to MT5 REST /orders for placement.
 *
 * Body: { symbol, side, volume, sl?, tp?, comment? }. Strict shape — extra
 * fields rejected (defence against prompt-injection slipping through).
 *
 * Forwards to mt5Post('/orders', body).
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
  }));
  return await import('../../../app/api/internal/mt5/orders/route');
}

function buildReq(body: unknown, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/mt5/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/mt5/orders — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ symbol: 'XAUUSD', side: 'buy', volume: 0.1 }));
    expect(res.status).toBe(401);
    expect(mt5PostSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', side: 'buy', volume: 0.1 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/internal/mt5/orders — body validation', () => {
  it('rejects missing symbol with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ side: 'buy', volume: 0.1 }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
    expect(mt5PostSpy).not.toHaveBeenCalled();
  });

  it('rejects missing side with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', volume: 0.1 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing volume with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', side: 'buy' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid side ("sideways") with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', side: 'sideways', volume: 0.1 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects negative volume with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', side: 'buy', volume: -0.1 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-JSON body with 400', async () => {
    const route = await importRoute();
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${fixtureBearer}`);
    headers.set('content-type', 'application/json');
    const req = new Request('https://app.local/api/internal/mt5/orders', {
      method: 'POST',
      headers,
      body: 'not-json{{',
    });
    const res = await route.POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/internal/mt5/orders — happy path', () => {
  it('forwards minimal valid body to /api/v1/order/market with translated shape', async () => {
    mt5PostSpy.mockResolvedValue({ ticket: 12345, status: 'placed' });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', side: 'buy', volume: 0.1 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    expect(mt5PostSpy).toHaveBeenCalledTimes(1);
    // Upstream shape: type (not side), stop_loss/take_profit (not sl/tp).
    expect(mt5PostSpy).toHaveBeenCalledWith('/api/v1/order/market', {
      symbol: 'XAUUSD',
      type: 'BUY',
      volume: 0.1,
    });
    const body = (await res.json()) as { ticket: number };
    expect(body.ticket).toBe(12345);
  });

  it('translates side: "sell" → type: "SELL" and full body with stop_loss/take_profit/comment', async () => {
    mt5PostSpy.mockResolvedValue({ ticket: 99 });
    const route = await importRoute();
    await route.POST(
      buildReq(
        {
          symbol: 'EURUSD',
          side: 'sell',
          volume: 0.5,
          sl: 1.09,
          tp: 1.07,
          comment: 'caishen-12',
        },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(mt5PostSpy).toHaveBeenCalledWith('/api/v1/order/market', {
      symbol: 'EURUSD',
      type: 'SELL',
      volume: 0.5,
      stop_loss: 1.09,
      take_profit: 1.07,
      comment: 'caishen-12',
    });
  });

  it('sanitises symbol to alphanumeric+upper before forwarding (path-injection defence)', async () => {
    mt5PostSpy.mockResolvedValue({ ticket: 1 });
    const route = await importRoute();
    await route.POST(
      buildReq({ symbol: 'eur/usd;drop', side: 'buy', volume: 0.1 }, `Bearer ${fixtureBearer}`),
    );
    const passedBody = mt5PostSpy.mock.calls[0]?.[1] as { symbol: string };
    expect(passedBody.symbol).toBe('EURUSDDROP');
  });

  it('strips unknown fields before forwarding (defence against prompt-injection)', async () => {
    mt5PostSpy.mockResolvedValue({ ticket: 1 });
    const route = await importRoute();
    await route.POST(
      buildReq(
        {
          symbol: 'XAUUSD',
          side: 'buy',
          volume: 0.1,
          // injection attempt:
          adminBypass: true,
          deleteAccount: 'yes',
        },
        `Bearer ${fixtureBearer}`,
      ),
    );
    const passedBody = mt5PostSpy.mock.calls[0]?.[1];
    expect(passedBody).not.toHaveProperty('adminBypass');
    expect(passedBody).not.toHaveProperty('deleteAccount');
  });
});

describe('POST /api/internal/mt5/orders — upstream errors', () => {
  it('returns 502 when mt5Post throws upstream error', async () => {
    mt5PostSpy.mockRejectedValue(new Error('mt5: POST /api/v1/order/market → HTTP 500: rejected'));
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ symbol: 'XAUUSD', side: 'buy', volume: 0.1 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(502);
  });
});
