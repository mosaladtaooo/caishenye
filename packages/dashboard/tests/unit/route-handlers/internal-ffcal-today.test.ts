/**
 * GET /api/internal/ffcal/today — proxy route tests (v1.1 #3 resurrection).
 *
 * Tests the resurrected calendar proxy:
 *   - Auth gate (401 without bearer; 500 with no INTERNAL_API_TOKEN per §15)
 *   - Default window (48h) + impact (medium) when no query params
 *   - Custom window= and impact= query params
 *   - Pass-through of fetchAndRenderCalendar's degraded shape
 *   - Schema-error path → 500 LOUD
 *
 * Note: the calendar helper itself is unit-tested in
 * packages/routines/tests/calendar.test.ts. These tests mock its return
 * shape via vi.mock, focusing on route-level concerns (auth + query
 * parsing + response wrapping).
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  vi.restoreAllMocks();
  vi.doUnmock('@caishen/routines/calendar');
});

async function importRoute() {
  return await import('../../../app/api/internal/ffcal/today/route');
}

function buildReq(opts: { headerValue?: string; query?: string }): Request {
  const headers = new Headers();
  if (opts.headerValue !== undefined) headers.set('Authorization', opts.headerValue);
  const url = `https://app.local/api/internal/ffcal/today${opts.query ?? ''}`;
  return new Request(url, { method: 'GET', headers });
}

describe('GET /api/internal/ffcal/today — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({}));
    expect(res.status).toBe(401);
  });

  it('returns 500 when INTERNAL_API_TOKEN missing (constitution §15 LOUD)', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq({ headerValue: `Bearer ${fixtureBearer}` }));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/ffcal/today — happy path with mocked helper', () => {
  it('returns 200 + the calendar shape on default params', async () => {
    const fakeResult = {
      event_count: 2,
      time_window_start: '2026-05-04T00:00:00.000Z',
      time_window_end: '2026-05-06T00:00:00.000Z',
      markdown: '## Economic Calendar\n...',
      events: [
        {
          title: 'NFP',
          currency: 'USD',
          time_gmt: '2026-05-04T12:30:00.000Z',
          impact: 'High',
          forecast: '180k',
          previous: '150k',
        },
      ],
      degraded: false,
    };
    const fetchSpy = vi.fn().mockResolvedValue(fakeResult);
    vi.doMock('@caishen/routines/calendar', () => ({
      fetchAndRenderCalendar: fetchSpy,
    }));
    const route = await importRoute();
    const res = await route.GET(buildReq({ headerValue: `Bearer ${fixtureBearer}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof fakeResult;
    expect(body.event_count).toBe(2);
    expect(body.events[0]?.title).toBe('NFP');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ windowHours: 48, impact: 'medium' }),
    );
  });

  it('passes ?window=24 through to the helper', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      event_count: 0,
      time_window_start: '',
      time_window_end: '',
      markdown: '',
      events: [],
      degraded: false,
    });
    vi.doMock('@caishen/routines/calendar', () => ({ fetchAndRenderCalendar: fetchSpy }));
    const route = await importRoute();
    await route.GET(buildReq({ headerValue: `Bearer ${fixtureBearer}`, query: '?window=24' }));
    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ windowHours: 24 }));
  });

  it('passes ?impact=high through to the helper', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      event_count: 0,
      time_window_start: '',
      time_window_end: '',
      markdown: '',
      events: [],
      degraded: false,
    });
    vi.doMock('@caishen/routines/calendar', () => ({ fetchAndRenderCalendar: fetchSpy }));
    const route = await importRoute();
    await route.GET(buildReq({ headerValue: `Bearer ${fixtureBearer}`, query: '?impact=high' }));
    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ impact: 'high' }));
  });

  it('falls back to defaults when query params are invalid', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      event_count: 0,
      time_window_start: '',
      time_window_end: '',
      markdown: '',
      events: [],
      degraded: false,
    });
    vi.doMock('@caishen/routines/calendar', () => ({ fetchAndRenderCalendar: fetchSpy }));
    const route = await importRoute();
    await route.GET(
      buildReq({
        headerValue: `Bearer ${fixtureBearer}`,
        query: '?window=999&impact=bogus',
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ windowHours: 48, impact: 'medium' }),
    );
  });

  it('returns 200 with degraded:true when helper reports unreachable feed', async () => {
    const degradedResult = {
      event_count: 0,
      time_window_start: '2026-05-04T00:00:00.000Z',
      time_window_end: '2026-05-06T00:00:00.000Z',
      markdown: '## Economic Calendar\n\nFeed unreachable',
      events: [],
      degraded: true,
    };
    vi.doMock('@caishen/routines/calendar', () => ({
      fetchAndRenderCalendar: vi.fn().mockResolvedValue(degradedResult),
    }));
    const route = await importRoute();
    const res = await route.GET(buildReq({ headerValue: `Bearer ${fixtureBearer}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof degradedResult;
    expect(body.degraded).toBe(true);
    expect(body.event_count).toBe(0);
  });
});

describe('GET /api/internal/ffcal/today — programming-error path', () => {
  it('returns 500 LOUD when the helper itself throws', async () => {
    vi.doMock('@caishen/routines/calendar', () => ({
      fetchAndRenderCalendar: vi.fn().mockRejectedValue(new Error('schema-incompat')),
    }));
    const route = await importRoute();
    const res = await route.GET(buildReq({ headerValue: `Bearer ${fixtureBearer}` }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/schema-incompat/);
  });
});
