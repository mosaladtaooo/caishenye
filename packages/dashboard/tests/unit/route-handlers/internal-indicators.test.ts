/**
 * GET /api/internal/indicators — TwelveData proxy route tests.
 *
 *   - Auth gate (401 / 500 LOUD on missing INTERNAL_API_TOKEN)
 *   - 500 LOUD on missing TWELVEDATA_API_KEY (constitution §15)
 *   - 400 on invalid indicator / missing symbol / invalid timeframe
 *   - Translates MT5 timeframe → TwelveData interval before passing to helper
 *   - Normalizes symbol (EURUSD → EUR/USD) before passing to helper
 *   - Optional outputsize + time_period passed through; invalid values dropped
 *   - Pass-through degraded body (200 with degraded:true)
 *   - 500 LOUD when helper itself throws
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let originalToken: string | undefined;
let originalTwelve: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  originalTwelve = process.env.TWELVEDATA_API_KEY;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  process.env.TWELVEDATA_API_KEY = 'TEST_KEY';
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalTwelve === undefined) delete process.env.TWELVEDATA_API_KEY;
  else process.env.TWELVEDATA_API_KEY = originalTwelve;
  vi.restoreAllMocks();
  vi.doUnmock('@caishen/routines/indicators');
});

async function importRoute() {
  return await import('../../../app/api/internal/indicators/route');
}

function buildReq(opts: { headerValue?: string; query: string }): Request {
  const headers = new Headers();
  if (opts.headerValue !== undefined) headers.set('Authorization', opts.headerValue);
  return new Request(`https://app.local/api/internal/indicators${opts.query}`, {
    method: 'GET',
    headers,
  });
}

const validQuery = '?indicator=atr&symbol=XAUUSD&timeframe=H4&time_period=14';

describe('GET /api/internal/indicators — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({ query: validQuery }));
    expect(res.status).toBe(401);
  });

  it('returns 500 when INTERNAL_API_TOKEN missing (§15 LOUD)', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(
      buildReq({ headerValue: `Bearer ${fixtureBearer}`, query: validQuery }),
    );
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/indicators — TWELVEDATA_API_KEY gate (§15 LOUD)', () => {
  it('returns 500 with a clear error when TWELVEDATA_API_KEY is missing', async () => {
    delete process.env.TWELVEDATA_API_KEY;
    const route = await importRoute();
    const res = await route.GET(
      buildReq({ headerValue: `Bearer ${fixtureBearer}`, query: validQuery }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/TWELVEDATA_API_KEY/);
  });
});

describe('GET /api/internal/indicators — query validation', () => {
  it('400 on invalid indicator', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?indicator=cci&symbol=EUR/USD&timeframe=H1',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on missing symbol', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?indicator=rsi&timeframe=H1',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on invalid timeframe', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?indicator=rsi&symbol=EUR/USD&timeframe=4h',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/internal/indicators — happy path with mocked helper', () => {
  it('translates timeframe + normalizes symbol before calling helper', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      indicator: 'atr',
      symbol: 'XAU/USD',
      interval: '4h',
      values: [{ datetime: '2026-05-05', atr: '12.34' }],
      meta: { symbol: 'XAU/USD', interval: '4h' },
      degraded: false,
    });
    vi.doMock('@caishen/routines/indicators', async () => {
      const actual = await vi.importActual<typeof import('@caishen/routines/indicators')>(
        '@caishen/routines/indicators',
      );
      return { ...actual, fetchIndicator: fetchSpy };
    });
    const route = await importRoute();
    const res = await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?indicator=atr&symbol=XAUUSD&timeframe=H4&time_period=14',
      }),
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'TEST_KEY' }),
      expect.objectContaining({
        indicator: 'atr',
        symbol: 'XAU/USD',
        interval: '4h',
        time_period: 14,
      }),
    );
  });

  it('passes outputsize when within bounds', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      indicator: 'rsi',
      symbol: 'EUR/USD',
      interval: '1h',
      values: [],
      meta: {},
      degraded: false,
    });
    vi.doMock('@caishen/routines/indicators', async () => {
      const actual = await vi.importActual<typeof import('@caishen/routines/indicators')>(
        '@caishen/routines/indicators',
      );
      return { ...actual, fetchIndicator: fetchSpy };
    });
    const route = await importRoute();
    await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?indicator=rsi&symbol=EUR/USD&timeframe=H1&outputsize=120',
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outputsize: 120 }),
    );
  });

  it('drops invalid outputsize / time_period silently (helper sees no override)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      indicator: 'rsi',
      symbol: 'EUR/USD',
      interval: '1h',
      values: [],
      meta: {},
      degraded: false,
    });
    vi.doMock('@caishen/routines/indicators', async () => {
      const actual = await vi.importActual<typeof import('@caishen/routines/indicators')>(
        '@caishen/routines/indicators',
      );
      return { ...actual, fetchIndicator: fetchSpy };
    });
    const route = await importRoute();
    await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?indicator=rsi&symbol=EUR/USD&timeframe=H1&outputsize=999999&time_period=-3',
      }),
    );
    const args = fetchSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('outputsize');
    expect(args).not.toHaveProperty('time_period');
  });

  it('passes through degraded:true 200 body unchanged', async () => {
    vi.doMock('@caishen/routines/indicators', async () => {
      const actual = await vi.importActual<typeof import('@caishen/routines/indicators')>(
        '@caishen/routines/indicators',
      );
      return {
        ...actual,
        fetchIndicator: vi.fn().mockResolvedValue({
          indicator: 'atr',
          symbol: 'XAU/USD',
          interval: '4h',
          values: [],
          meta: {},
          degraded: true,
          error_message: 'You have exceeded the API request limit',
        }),
      };
    });
    const route = await importRoute();
    const res = await route.GET(
      buildReq({ headerValue: `Bearer ${fixtureBearer}`, query: validQuery }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { degraded: boolean; error_message: string };
    expect(body.degraded).toBe(true);
    expect(body.error_message).toMatch(/exceeded the API request limit/);
  });
});

describe('GET /api/internal/indicators — programming-error path', () => {
  it('returns 500 LOUD when the helper itself throws', async () => {
    vi.doMock('@caishen/routines/indicators', async () => {
      const actual = await vi.importActual<typeof import('@caishen/routines/indicators')>(
        '@caishen/routines/indicators',
      );
      return { ...actual, fetchIndicator: vi.fn().mockRejectedValue(new Error('schema-incompat')) };
    });
    const route = await importRoute();
    const res = await route.GET(
      buildReq({ headerValue: `Bearer ${fixtureBearer}`, query: validQuery }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/schema-incompat/);
  });
});
