/**
 * GET /api/internal/mt5/positions — proxy to MT5 REST /positions.
 * Same auth + error-mapping shape as account.
 *
 * All bearer values derived from randomBytes() at module load — no literal
 * tokens in source per AgentLint no-secrets + constitution §10.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');
const wrongBearer = randomBytes(32).toString('hex');

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
  return await import('../../../app/api/internal/mt5/positions/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/mt5/positions', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/mt5/positions', () => {
  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });

  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
    expect(mt5GetSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${wrongBearer}`));
    expect(res.status).toBe(401);
  });

  it('forwards to mt5Get("/api/v1/positions") and returns the JSON list', async () => {
    mt5GetSpy.mockResolvedValue([
      { ticket: 1, symbol: 'XAUUSD', volume: 0.1, side: 'buy', sl: 2300, tp: 2400 },
      { ticket: 2, symbol: 'EURUSD', volume: 0.5, side: 'sell', sl: 1.09, tp: 1.07 },
    ]);
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(mt5GetSpy).toHaveBeenCalledWith('/api/v1/positions');
    const body = (await res.json()) as Array<{ ticket: number; symbol: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.symbol).toBe('XAUUSD');
  });

  it('returns 200 with empty array when no positions open', async () => {
    mt5GetSpy.mockResolvedValue([]);
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(0);
  });

  it('returns 502 on upstream error', async () => {
    mt5GetSpy.mockRejectedValue(new Error('mt5: GET /api/v1/positions → HTTP 503: down'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 500 on env-missing upstream error', async () => {
    mt5GetSpy.mockRejectedValue(new Error('mt5: MT5_BEARER_TOKEN missing in env'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/mt5/positions — symbol filter', () => {
  function buildReqWithSymbol(symbol: string, headerValue?: string): Request {
    const headers = new Headers();
    if (headerValue !== undefined) headers.set('Authorization', headerValue);
    return new Request(`https://app.local/api/internal/mt5/positions?symbol=${symbol}`, {
      method: 'GET',
      headers,
    });
  }

  it('forwards to /api/v1/positions/symbol/<sym> when symbol query present', async () => {
    mt5GetSpy.mockResolvedValue([{ ticket: 5, symbol: 'EURUSD', volume: 0.3 }]);
    const route = await importRoute();
    const res = await route.GET(buildReqWithSymbol('EURUSD', `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(mt5GetSpy).toHaveBeenCalledWith('/api/v1/positions/symbol/EURUSD');
  });

  it('sanitises and uppercases the symbol (path-injection defence)', async () => {
    mt5GetSpy.mockResolvedValue([]);
    const route = await importRoute();
    // attacker tries to inject path traversal: %2F → '/', %3B → ';' after URL decode
    await route.GET(buildReqWithSymbol('eur%2Fusd%3Bdrop', `Bearer ${fixtureBearer}`));
    const callPath = mt5GetSpy.mock.calls[0]?.[0] as string;
    expect(callPath).toBe('/api/v1/positions/symbol/EURUSDDROP');
    // The sanitised symbol component (after the last '/') must contain neither '/' nor ';'.
    const symbolComponent = callPath.split('/').pop() ?? '';
    expect(symbolComponent).not.toContain('/');
    expect(symbolComponent).not.toContain(';');
    expect(symbolComponent).toBe('EURUSDDROP');
  });

  it('treats empty symbol param as full-list (no symbol path)', async () => {
    mt5GetSpy.mockResolvedValue([]);
    const route = await importRoute();
    await route.GET(buildReqWithSymbol('', `Bearer ${fixtureBearer}`));
    expect(mt5GetSpy).toHaveBeenCalledWith('/api/v1/positions');
  });
});
