/**
 * GET /api/internal/ffcal/today — proxy to ForexFactory MCP /today.
 *
 * Different from MT5 routes: there's no existing ffcal-server.ts client
 * (the routine-side TS modules call FFCal MCP directly). This handler
 * uses fetch() with FFCAL_BASE_URL + FFCAL_BEARER_TOKEN env.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');
const ffcalBearer = randomBytes(32).toString('hex');

let fetchSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;
let originalFfcalBase: string | undefined;
let originalFfcalBearer: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  originalFfcalBase = process.env.FFCAL_BASE_URL;
  originalFfcalBearer = process.env.FFCAL_BEARER_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  process.env.FFCAL_BASE_URL = 'https://ffcal.example/';
  process.env.FFCAL_BEARER_TOKEN = ffcalBearer;
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalFfcalBase === undefined) delete process.env.FFCAL_BASE_URL;
  else process.env.FFCAL_BASE_URL = originalFfcalBase;
  if (originalFfcalBearer === undefined) delete process.env.FFCAL_BEARER_TOKEN;
  else process.env.FFCAL_BEARER_TOKEN = originalFfcalBearer;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function importRoute() {
  return await import('../../../app/api/internal/ffcal/today/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/ffcal/today', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/ffcal/today — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/ffcal/today — env validation', () => {
  it('returns 500 when FFCAL_BASE_URL missing', async () => {
    delete process.env.FFCAL_BASE_URL;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when FFCAL_BEARER_TOKEN missing', async () => {
    delete process.env.FFCAL_BEARER_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/internal/ffcal/today — happy path', () => {
  it('forwards to FFCAL_BASE_URL/today with FFCAL bearer', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ events: [{ time: '08:30', currency: 'USD', impact: 'high' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ffcal.example/today');
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Bearer ${ffcalBearer}`);
  });

  it('handles trailing slash on FFCAL_BASE_URL correctly (no double slash)', async () => {
    process.env.FFCAL_BASE_URL = 'https://ffcal.example/';
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const route = await importRoute();
    await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe('https://ffcal.example/today');
  });
});

describe('GET /api/internal/ffcal/today — upstream errors', () => {
  it('returns 502 when upstream returns 5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 502 when fetch throws (network error)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 502 when upstream returns 401 (FFCal bearer wrong)', async () => {
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 401 }));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });
});
