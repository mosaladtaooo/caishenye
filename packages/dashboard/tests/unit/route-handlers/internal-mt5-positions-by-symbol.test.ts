/**
 * DELETE /api/internal/mt5/positions/by-symbol/[symbol] — close-all-by-symbol tests.
 *
 * v1.1 — Phase B. Used by the Executor at session-end to flatten all
 * positions on its pair (per the verbatim "ALL EURO/London Session's
 * trades will be cleared before US Session Start" rule).
 *
 *   - Auth gate (401 / 500 LOUD)
 *   - Symbol path-segment sanitisation (alphanumeric only, uppercased)
 *   - Forwards to upstream DELETE /api/v1/positions/symbol/{symbol}
 *   - Empty-after-sanitise → 400
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
  return await import('../../../app/api/internal/mt5/positions/by-symbol/[symbol]/route');
}

function buildReq(headerValue: string | undefined): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/mt5/positions/by-symbol/EURUSD', {
    method: 'DELETE',
    headers,
  });
}

const ctx = (symbol: string) => ({ params: Promise.resolve({ symbol }) });

describe('DELETE /api/internal/mt5/positions/by-symbol/[symbol] — auth gate', () => {
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

describe('DELETE /api/internal/mt5/positions/by-symbol/[symbol] — symbol sanitisation', () => {
  it('uppercases lowercase symbol', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('eurusd'));
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/positions/symbol/EURUSD');
  });

  it('strips non-alphanumeric chars (path-injection defence)', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.DELETE(
      buildReq(`Bearer ${fixtureBearer}`),
      ctx('EUR/USD'), // path traversal would be ../foo, slash already test-coverage
    );
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/positions/symbol/EURUSD');
  });

  it('preserves XAUUSD as-is', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('XAUUSD'));
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/positions/symbol/XAUUSD');
  });

  it('400 when symbol is empty after sanitisation', async () => {
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('!@#$'));
    expect(res.status).toBe(400);
    expect(mt5DeleteSpy).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/internal/mt5/positions/by-symbol/[symbol] — happy path', () => {
  it('forwards to upstream and returns the JSON body', async () => {
    mt5DeleteSpy.mockResolvedValue({
      success: true,
      closed_count: 3,
      tickets: [101, 102, 103],
    });
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EURUSD'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { closed_count: number };
    expect(body.closed_count).toBe(3);
  });

  it('returns 200 with closed_count=0 when nothing to close', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true, closed_count: 0, tickets: [] });
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EURUSD'));
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/internal/mt5/positions/by-symbol/[symbol] — upstream errors', () => {
  it('returns mapped error when upstream throws', async () => {
    mt5DeleteSpy.mockRejectedValue(new Error('mt5: DELETE → HTTP 504: timeout'));
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('EURUSD'));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
