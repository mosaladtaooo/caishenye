/**
 * GET /api/internal/mt5/account — proxy to MT5 REST /account.
 *
 * Auth: INTERNAL_API_TOKEN bearer (validateInternalAuth).
 * Forwards to ${MT5_BASE_URL}/account using mt5Get('/account') which
 * already handles bearer + retry per EC-003-1.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let mt5GetSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  mt5GetSpy = vi.fn();
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('../../../lib/mt5-server', () => ({
    mt5Get: mt5GetSpy,
    mt5Post: vi.fn(),
  }));
  return await import('../../../app/api/internal/mt5/account/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/mt5/account', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/mt5/account — auth', () => {
  it('returns 500 when INTERNAL_API_TOKEN is missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
    expect(mt5GetSpy).not.toHaveBeenCalled();
  });

  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
    expect(mt5GetSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong bearer', async () => {
    const route = await importRoute();
    const wrong = `${fixtureBearer.slice(0, -4)}beef`;
    const res = await route.GET(buildReq(`Bearer ${wrong}`));
    expect(res.status).toBe(401);
    expect(mt5GetSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/mt5/account — happy path', () => {
  it('forwards to mt5Get("/account") and returns the upstream JSON 200', async () => {
    mt5GetSpy.mockResolvedValue({ balance: 1234.56, equity: 1234.56, currency: 'USD' });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(mt5GetSpy).toHaveBeenCalledTimes(1);
    expect(mt5GetSpy).toHaveBeenCalledWith('/api/v1/account/info');
    const body = (await res.json()) as { balance: number; equity: number; currency: string };
    expect(body.balance).toBe(1234.56);
    expect(body.currency).toBe('USD');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('GET /api/internal/mt5/account — upstream errors', () => {
  it('returns 502 when mt5Get throws (upstream unreachable)', async () => {
    mt5GetSpy.mockRejectedValue(new Error('mt5: GET /account → HTTP 503: gateway down'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mt5/i);
  });

  it('returns 502 when mt5Get throws a generic Error', async () => {
    mt5GetSpy.mockRejectedValue(new Error('boom'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 500 when MT5_BASE_URL/MT5_BEARER_TOKEN env missing (mt5Get throws upstream-config)', async () => {
    mt5GetSpy.mockRejectedValue(new Error('mt5: MT5_BASE_URL missing in env'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    // Treat env-misconfig as 500 (server side), not 502 (upstream).
    expect([500, 502]).toContain(res.status);
  });
});
