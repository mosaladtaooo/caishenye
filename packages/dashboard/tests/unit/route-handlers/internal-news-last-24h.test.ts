/**
 * GET /api/internal/news/last-24h — session 5g.
 *
 * Wraps fetchAndRenderNews from @caishen/routines/news (FR-014).
 * Bearer-gated; no other env required (the routines/news module reads
 * its own feed URL default). EC-014-1 fallback is handled inside the
 * routine, so the route always returns 200 with a valid shape.
 *
 * Tests cover: auth gate (401, 500 INTERNAL_API_TOKEN missing), happy
 * path (200 + shape + count + markdown form), feed-unreachable EC-014-1
 * fallback (200 + news_count=0), time-window cutoff correctness.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let fetchAndRenderNewsSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  fetchAndRenderNewsSpy = vi.fn();
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('@caishen/routines/news', () => ({
    fetchAndRenderNews: fetchAndRenderNewsSpy,
  }));
  return await import('../../../app/api/internal/news/last-24h/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/news/last-24h', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/news/last-24h — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
    expect(fetchAndRenderNewsSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong bearer', async () => {
    const route = await importRoute();
    const wrong = `${fixtureBearer.slice(0, -4)}beef`;
    const res = await route.GET(buildReq(`Bearer ${wrong}`));
    expect(res.status).toBe(401);
    expect(fetchAndRenderNewsSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing (constitution §15 LOUD)', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/news/last-24h — happy path', () => {
  it('returns 200 with the canonical FR-014 shape (news_count, time_window_start, markdown)', async () => {
    fetchAndRenderNewsSpy.mockResolvedValue({
      news_count: 3,
      time_window_start: '2026-05-03T15:00:00.000Z',
      markdown:
        '## News Summary (Last 24 Hours)\n\n### 1. CPI surprise\n**Time:** May 4 08:30 AM (UTC)\n**Summary:** US CPI prints hot.\n\n---\n\n',
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(fetchAndRenderNewsSpy).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as {
      news_count: number;
      time_window_start: string;
      markdown: string;
    };
    expect(body).toHaveProperty('news_count');
    expect(body).toHaveProperty('time_window_start');
    expect(body).toHaveProperty('markdown');
    expect(typeof body.news_count).toBe('number');
    expect(typeof body.time_window_start).toBe('string');
    expect(typeof body.markdown).toBe('string');
  });

  it('forwards news_count from the underlying renderer (item-count assertion)', async () => {
    fetchAndRenderNewsSpy.mockResolvedValue({
      news_count: 7,
      time_window_start: '2026-05-03T15:00:00.000Z',
      markdown: 'pretend-markdown',
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    const body = (await res.json()) as { news_count: number };
    expect(body.news_count).toBe(7);
  });

  it('preserves markdown shape verbatim (## News Summary header)', async () => {
    const markdown =
      '## News Summary (Last 24 Hours)\n\n### 1. ECB pause\n**Time:** May 4 14:00 PM (UTC)\n**Summary:** ECB holds.\n\n---\n\n';
    fetchAndRenderNewsSpy.mockResolvedValue({
      news_count: 1,
      time_window_start: '2026-05-03T15:00:00.000Z',
      markdown,
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toBe(markdown);
    expect(body.markdown).toMatch(/^## News Summary \(Last 24 Hours\)/);
  });

  it('passes a fetch implementation to the news module (no plain undefined)', async () => {
    fetchAndRenderNewsSpy.mockResolvedValue({
      news_count: 0,
      time_window_start: '2026-05-03T15:00:00.000Z',
      markdown: 'No news found in the last 24 hours.',
    });
    const route = await importRoute();
    await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    const callArgs = fetchAndRenderNewsSpy.mock.calls[0]?.[0] as { fetch: unknown };
    expect(callArgs).toHaveProperty('fetch');
    expect(typeof callArgs.fetch).toBe('function');
  });

  it('exports maxDuration > 10 (extends beyond Hobby default for slow feeds)', async () => {
    const route = await importRoute();
    expect(route.maxDuration).toBeGreaterThan(10);
  });
});

describe('GET /api/internal/news/last-24h — EC-014-1 feed-unreachable fallback', () => {
  it('returns 200 with news_count=0 and canonical "No news" markdown when feed dead', async () => {
    // EC-014-1 is handled inside fetchAndRenderNews — when the feed is
    // unreachable the function returns a degraded shape rather than throwing.
    fetchAndRenderNewsSpy.mockResolvedValue({
      news_count: 0,
      time_window_start: '2026-05-03T15:00:00.000Z',
      markdown: 'No news found in the last 24 hours.',
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { news_count: number; markdown: string };
    expect(body.news_count).toBe(0);
    expect(body.markdown).toBe('No news found in the last 24 hours.');
  });
});

describe('GET /api/internal/news/last-24h — time-window correctness', () => {
  it('forwards time_window_start as an ISO string the caller can parse', async () => {
    const cutoffIso = '2026-05-03T15:30:00.000Z';
    fetchAndRenderNewsSpy.mockResolvedValue({
      news_count: 2,
      time_window_start: cutoffIso,
      markdown: 'two items',
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    const body = (await res.json()) as { time_window_start: string };
    expect(body.time_window_start).toBe(cutoffIso);
    // Must be parseable by Date constructor.
    const parsed = new Date(body.time_window_start);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });
});

describe('GET /api/internal/news/last-24h — internal errors', () => {
  it('returns 500 when fetchAndRenderNews throws (programming bug, not feed down)', async () => {
    fetchAndRenderNewsSpy.mockRejectedValue(new Error('schema mismatch in renderer'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/news/);
  });
});
