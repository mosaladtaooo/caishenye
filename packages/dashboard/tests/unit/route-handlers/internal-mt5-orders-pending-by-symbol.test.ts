/**
 * DELETE /api/internal/mt5/orders/pending/by-symbol/[symbol] —
 *   cancel-all-pending-by-symbol tests.
 *
 *   - Auth gate (401 / 500-LOUD)
 *   - Symbol path-segment sanitisation (alphanumeric only, uppercased)
 *   - 400 when symbol empty after sanitisation
 *   - Forwards to upstream DELETE /api/v1/order/pending/symbol/{symbol}
 *   - Upstream errors mapped via mapUpstreamError
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let mt5DeleteSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  mt5DeleteSpy = vi.fn();
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
    mt5Post: vi.fn(),
    mt5Put: vi.fn(),
    mt5Delete: mt5DeleteSpy,
  }));
  return await import('../../../app/api/internal/mt5/orders/pending/by-symbol/[symbol]/route');
}

function buildReq(headerValue: string | undefined): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/mt5/orders/pending/by-symbol/EURUSD', {
    method: 'DELETE',
    headers,
  });
}

const ctx = (symbol: string) => ({ params: Promise.resolve({ symbol }) });

describe('DELETE /api/internal/mt5/orders/pending/by-symbol/[symbol] — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.DELETE(buildReq(undefined), ctx('EURUSD'));
    expect(res.status).toBe(401);
    expect(mt5DeleteSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EURUSD'));
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/internal/mt5/orders/pending/by-symbol/[symbol] — sanitisation', () => {
  it('uppercases lowercase symbol', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('eurusd'));
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/order/pending/symbol/EURUSD');
  });

  it('strips non-alphanumeric chars', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EUR/USD'));
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/order/pending/symbol/EURUSD');
  });

  it('400 when symbol is empty after sanitisation', async () => {
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('!@#$'));
    expect(res.status).toBe(400);
    expect(mt5DeleteSpy).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/internal/mt5/orders/pending/by-symbol/[symbol] — happy path', () => {
  it('forwards to upstream and returns the JSON body', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true, cancelled_count: 2 });
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EURUSD'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled_count: number };
    expect(body.cancelled_count).toBe(2);
  });
});

describe('DELETE /api/internal/mt5/orders/pending/by-symbol/[symbol] — upstream errors', () => {
  it('returns mapped error when upstream throws', async () => {
    mt5DeleteSpy.mockRejectedValue(new Error('mt5: DELETE → HTTP 502'));
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EURUSD'));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
