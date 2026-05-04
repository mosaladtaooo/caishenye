/**
 * GET /api/internal/mt5/candles?symbol=...&timeframe=...&count=N
 *
 * Forwards to mt5Get('/candles?...') after validating query params.
 * Validates timeframe against canonical n8n list, count <= 500.
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
  return await import('../../../app/api/internal/mt5/candles/route');
}

function buildReq(qs: string, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request(`https://app.local/api/internal/mt5/candles${qs}`, {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/mt5/candles — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq('?symbol=XAUUSD&timeframe=H4&count=180'));
    expect(res.status).toBe(401);
    expect(mt5GetSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H4&count=180', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/mt5/candles — query validation', () => {
  it('rejects missing symbol with 400', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq('?timeframe=H4&count=10', `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects missing timeframe with 400', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq('?symbol=XAUUSD&count=10', `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects invalid timeframe ("H99") with 400', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H99&count=10', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing count with 400', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq('?symbol=XAUUSD&timeframe=H4', `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects count > 500 with 400 (Vercel-deadline guard)', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H4&count=501', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects count <= 0 with 400', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H4&count=0', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric count with 400', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H4&count=abc', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/internal/mt5/candles — count mode (latest)', () => {
  it('forwards to /api/v1/market/candles/latest with symbol_name + count', async () => {
    mt5GetSpy.mockResolvedValue([
      { time: '2026-05-04T08:00:00Z', open: 2300, high: 2310, low: 2295, close: 2305 },
      { time: '2026-05-04T12:00:00Z', open: 2305, high: 2320, low: 2300, close: 2315 },
    ]);
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H4&count=180', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    expect(mt5GetSpy).toHaveBeenCalledTimes(1);
    const calledWith = mt5GetSpy.mock.calls[0]?.[0] as string;
    expect(calledWith).toMatch(/^\/api\/v1\/market\/candles\/latest\?/);
    // Upstream uses symbol_name, not symbol.
    expect(calledWith).toContain('symbol_name=XAUUSD');
    expect(calledWith).toContain('timeframe=H4');
    expect(calledWith).toContain('count=180');
  });

  it('accepts every canonical timeframe (M1, M5, M15, M30, H1, H4, D1, W1, MN1)', async () => {
    mt5GetSpy.mockResolvedValue([]);
    const route = await importRoute();
    for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1']) {
      const res = await route.GET(
        buildReq(`?symbol=XAUUSD&timeframe=${tf}&count=10`, `Bearer ${fixtureBearer}`),
      );
      expect(res.status).toBe(200);
    }
  });

  it('sanitises symbol → alphanumeric + uppercase before forwarding', async () => {
    mt5GetSpy.mockResolvedValue([]);
    const route = await importRoute();
    await route.GET(buildReq('?symbol=eur%2Fusd&timeframe=H1&count=10', `Bearer ${fixtureBearer}`));
    const calledWith = mt5GetSpy.mock.calls[0]?.[0] as string;
    expect(calledWith).toContain('symbol_name=EURUSD');
    expect(calledWith).not.toContain('/usd');
  });
});

describe('GET /api/internal/mt5/candles — date mode', () => {
  it('forwards to /api/v1/market/candles/date with date_from + date_to', async () => {
    mt5GetSpy.mockResolvedValue([]);
    const route = await importRoute();
    const res = await route.GET(
      buildReq(
        '?symbol=EURUSD&timeframe=M15&date_from=2026-05-03+08%3A00&date_to=2026-05-04+08%3A00',
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(200);
    const calledWith = mt5GetSpy.mock.calls[0]?.[0] as string;
    expect(calledWith).toMatch(/^\/api\/v1\/market\/candles\/date\?/);
    expect(calledWith).toContain('symbol_name=EURUSD');
    expect(calledWith).toContain('timeframe=M15');
    expect(calledWith).toContain('date_from=');
    expect(calledWith).toContain('date_to=');
  });

  it('rejects date mode with only one of date_from/date_to (400)', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq(
        '?symbol=EURUSD&timeframe=M15&date_from=2026-05-03+08%3A00',
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it('rejects providing BOTH count AND date_from (400 — ambiguous mode)', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq(
        '?symbol=EURUSD&timeframe=M15&count=10&date_from=2026-05-03+08%3A00&date_to=2026-05-04+08%3A00',
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it('rejects when neither count nor date_from given (400)', async () => {
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=EURUSD&timeframe=M15', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/internal/mt5/candles — upstream errors', () => {
  it('returns 502 on upstream error', async () => {
    mt5GetSpy.mockRejectedValue(new Error('mt5: GET /candles → HTTP 504: timeout'));
    const route = await importRoute();
    const res = await route.GET(
      buildReq('?symbol=XAUUSD&timeframe=H4&count=180', `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(502);
  });
});

describe('GET /api/internal/mt5/candles — maxDuration export', () => {
  it('exports maxDuration > 10 (must extend beyond Hobby default for big counts)', async () => {
    const route = await importRoute();
    expect(route.maxDuration).toBeGreaterThan(10);
  });
});
