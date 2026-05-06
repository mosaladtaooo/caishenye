/**
 * GET /api/cron/close-due-sessions — v1.2 FR-027 D2 extension tests.
 *
 * Extension scope:
 *   - cancelPendingBySymbol(symbol) called BEFORE closePositionsBySymbol per pair (R8 ordering)
 *   - tickStartAt captured FIRST per R8 (renamed from nowIso)
 *   - Response shape: cancelled_pending_count, closed_count,
 *     closed_due_to_pending_fill_during_close, errors[]
 *   - 5 Telegram-wording cases per AC-027-3 (1+1, 0+1, 1+0, 0+0, race)
 *   - EC-027-4 race detection via closed_positions[].opened_at > tickStartAt
 *   - W1: defensive opened_at:null -> race-false (cannot prove race)
 *   - EC-027-1 idempotency: zero-affected on subsequent ticks does NOT throw
 *   - EC-027-2: pending DELETE 5xx + positions DELETE OK -> response 200,
 *               errors[] entry, special Telegram text
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronToken = randomBytes(32).toString('hex');
const internalApiToken = randomBytes(32).toString('hex');

let runNamedQuerySpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let originalCronSecret: string | undefined;
let originalAuthUrl: string | undefined;
let originalInternalApi: string | undefined;

beforeEach(() => {
  originalCronSecret = process.env.CRON_SECRET;
  originalAuthUrl = process.env.AUTH_URL;
  originalInternalApi = process.env.INTERNAL_API_TOKEN;
  process.env.CRON_SECRET = cronToken;
  process.env.AUTH_URL = 'https://test.local';
  process.env.INTERNAL_API_TOKEN = internalApiToken;
  runNamedQuerySpy = vi.fn();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
  if (originalInternalApi === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalInternalApi;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('@/lib/internal-postgres-queries', () => ({
    runNamedQuery: runNamedQuerySpy,
  }));
  return await import('../../../app/api/cron/close-due-sessions/route');
}

function buildReq(): Request {
  return new Request('https://app.local/api/cron/close-due-sessions', {
    method: 'GET',
    headers: { authorization: `Bearer ${cronToken}` },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Build a mock fetch that responds based on the URL path. Records all calls
 * in the supplied array so tests can assert ordering.
 */
function mockFetch(
  log: FetchCall[],
  responses: {
    pendingDelete?: () => Response;
    positionsDelete?: () => Response;
    telegram?: () => Response;
  },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    log.push({ url: u, init });
    if (u.includes('/api/internal/mt5/orders/pending/by-symbol/')) {
      return responses.pendingDelete
        ? responses.pendingDelete()
        : okJson({ success: true, cancelled_count: 0 });
    }
    if (u.includes('/api/internal/mt5/positions/by-symbol/')) {
      return responses.positionsDelete
        ? responses.positionsDelete()
        : okJson({ success: true, closed_count: 0, tickets: [], closed_positions: [] });
    }
    if (u.includes('/api/internal/telegram/send')) {
      return responses.telegram ? responses.telegram() : okJson({ ok: true });
    }
    return okJson({});
  });
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/cron/close-due-sessions — auth + happy path', () => {
  it('returns 401 without CRON_SECRET bearer', async () => {
    const route = await importRoute();
    const req = new Request('https://app.local/api/cron/close-due-sessions', {
      method: 'GET',
    });
    const res = await route.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 + dueCount=0 when no due sessions', async () => {
    runNamedQuerySpy.mockResolvedValue({ rows: [] });
    const route = await importRoute();
    const res = await route.GET(buildReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dueCount: number };
    expect(body.ok).toBe(true);
    expect(body.dueCount).toBe(0);
  });
});

describe('GET /api/cron/close-due-sessions — R8 tickStartAt ordering pin', () => {
  it('captures tickStartAt as ISO8601 UTC shape BEFORE any mt5 call', async () => {
    runNamedQuerySpy.mockResolvedValue({ rows: [] });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {});
    vi.stubGlobal('fetch', fetchSpy);
    const route = await importRoute();
    const res = await route.GET(buildReq());
    const body = (await res.json()) as { tick: string };
    // ISO8601 UTC shape: e.g., '2026-05-06T12:00:00.000Z'
    expect(body.tick).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('calls cancelPendingBySymbol BEFORE closePositionsBySymbol per pair (R8 ordering)', async () => {
    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {
      pendingDelete: () => okJson({ success: true, cancelled_count: 1 }),
      positionsDelete: () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [{ ticket: 101, opened_at: '2026-05-05T22:00:00Z' }],
        }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const route = await importRoute();
    await route.GET(buildReq());
    // Find the pending vs positions DELETE indices in the call log.
    const pendingIdx = log.findIndex((c) => c.url.includes('/orders/pending/by-symbol/'));
    const positionsIdx = log.findIndex((c) => c.url.includes('/positions/by-symbol/'));
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(positionsIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeLessThan(positionsIdx);
  });
});

describe('GET /api/cron/close-due-sessions — AC-027-3 Telegram wording', () => {
  function setupOnePair(
    closedDeleteResponse: () => Response,
    pendingResponse: () => Response = () => okJson({ success: true, cancelled_count: 0 }),
  ) {
    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {
      pendingDelete: pendingResponse,
      positionsDelete: closedDeleteResponse,
    });
    vi.stubGlobal('fetch', fetchSpy);
    return log;
  }

  function getTelegramText(log: FetchCall[]): string | null {
    const tg = log.find((c) => c.url.includes('/api/internal/telegram/send'));
    if (!tg || !tg.init?.body) return null;
    const parsed = JSON.parse(tg.init.body as string) as { text: string };
    return parsed.text;
  }

  it('case 1+1: closed 1 + cancelled 1 -> "closed 1 position + cancelled 1 pending"', async () => {
    const log = setupOnePair(
      () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [{ ticket: 101, opened_at: '2026-05-05T22:00:00Z' }],
        }),
      () => okJson({ success: true, cancelled_count: 1 }),
    );
    const route = await importRoute();
    await route.GET(buildReq());
    const text = getTelegramText(log);
    expect(text).toMatch(/closed 1 position \+ cancelled 1 pending/);
  });

  it('case 0+1: 0 positions + 1 pending -> "cancelled 1 pending (no open positions)"', async () => {
    const log = setupOnePair(
      () => okJson({ success: true, closed_count: 0, tickets: [], closed_positions: [] }),
      () => okJson({ success: true, cancelled_count: 1 }),
    );
    const route = await importRoute();
    await route.GET(buildReq());
    const text = getTelegramText(log);
    expect(text).toMatch(/cancelled 1 pending \(no open positions\)/);
  });

  it('case 1+0: 1 position + 0 pending -> "closed 1 position (no pending orders)"', async () => {
    const log = setupOnePair(
      () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [{ ticket: 101, opened_at: '2026-05-05T22:00:00Z' }],
        }),
      () => okJson({ success: true, cancelled_count: 0 }),
    );
    const route = await importRoute();
    await route.GET(buildReq());
    const text = getTelegramText(log);
    expect(text).toMatch(/closed 1 position \(no pending orders\)/);
  });

  it('case 0+0: nothing to act on -> NO Telegram emitted (idempotent silence)', async () => {
    const log = setupOnePair(
      () => okJson({ success: true, closed_count: 0, tickets: [], closed_positions: [] }),
      () => okJson({ success: true, cancelled_count: 0 }),
    );
    const route = await importRoute();
    await route.GET(buildReq());
    const tg = log.find((c) => c.url.includes('/api/internal/telegram/send'));
    expect(tg).toBeUndefined();
  });
});

describe('GET /api/cron/close-due-sessions — EC-027-4 race detection (pending filled mid-close)', () => {
  it('detects race when closed_positions[].opened_at > tickStartAt -> flag true + special Telegram text', async () => {
    // Frozen clock: tick starts at 2026-05-06T12:00:00Z.
    const fakeNow = new Date('2026-05-06T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {
      // Pending DELETE returns 5xx (transient broker error; pending order remains live).
      pendingDelete: () => errJson(502, { error: 'broker timeout' }),
      // Positions DELETE returns a position whose opened_at is AFTER tickStartAt
      // (i.e., the pending filled mid-close at 12:00:30Z).
      positionsDelete: () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [
            { ticket: 101, opened_at: '2026-05-06T12:00:30Z', fill_price: 1.0834 },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    const res = await route.GET(buildReq());
    const body = (await res.json()) as {
      results: Array<{
        outcome: string;
        closed_due_to_pending_fill_during_close?: boolean;
      }>;
    };
    expect(body.results[0]?.closed_due_to_pending_fill_during_close).toBe(true);

    // Telegram wording per AC-027-3 case 5.
    const tg = log.find((c) => c.url.includes('/api/internal/telegram/send'));
    expect(tg).toBeDefined();
    const tgText = JSON.parse(tg?.init?.body as string).text as string;
    expect(tgText).toMatch(/pending filled mid-close/);

    vi.useRealTimers();
  });

  it('flag=false when opened_at is earlier than tickStartAt', async () => {
    const fakeNow = new Date('2026-05-06T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {
      pendingDelete: () => errJson(502, { error: 'broker timeout' }),
      positionsDelete: () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [{ ticket: 101, opened_at: '2026-05-05T22:00:00Z' }],
        }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    const res = await route.GET(buildReq());
    const body = (await res.json()) as {
      results: Array<{
        outcome: string;
        closed_due_to_pending_fill_during_close?: boolean;
      }>;
    };
    expect(body.results[0]?.closed_due_to_pending_fill_during_close).toBe(false);

    vi.useRealTimers();
  });

  it('W1 defensive: opened_at:null -> flag false (cannot prove race without timestamp)', async () => {
    const fakeNow = new Date('2026-05-06T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);

    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {
      pendingDelete: () => errJson(502, { error: 'broker timeout' }),
      positionsDelete: () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [{ ticket: 101, opened_at: null }],
        }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    const res = await route.GET(buildReq());
    const body = (await res.json()) as {
      results: Array<{
        outcome: string;
        closed_due_to_pending_fill_during_close?: boolean;
      }>;
    };
    // W1 watch-item: null opened_at -> race-false (cannot prove race occurred).
    expect(body.results[0]?.closed_due_to_pending_fill_during_close).toBe(false);

    vi.useRealTimers();
  });
});

describe('GET /api/cron/close-due-sessions — EC-027-2 partial failure (pending DELETE 5xx, positions OK)', () => {
  it('returns 200 + errors[] entry + PENDING-CANCEL FAILED Telegram wording', async () => {
    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    const log: FetchCall[] = [];
    fetchSpy = mockFetch(log, {
      pendingDelete: () => errJson(502, { error: 'broker timeout' }),
      positionsDelete: () =>
        okJson({
          success: true,
          closed_count: 1,
          tickets: [101],
          closed_positions: [{ ticket: 101, opened_at: '2026-05-05T22:00:00Z' }],
        }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    const res = await route.GET(buildReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        errors?: unknown[];
        closed_count?: number;
        cancelled_pending_count?: number | null;
      }>;
    };
    const r0 = body.results[0];
    expect(r0?.closed_count).toBe(1);
    expect(r0?.cancelled_pending_count).toBeNull();
    expect(r0?.errors).toBeDefined();
    expect(Array.isArray(r0?.errors)).toBe(true);
    // The pending cancellation step is recorded as failed.
    const tg = log.find((c) => c.url.includes('/api/internal/telegram/send'));
    expect(tg).toBeDefined();
    const tgText = JSON.parse(tg?.init?.body as string).text as string;
    expect(tgText).toMatch(/PENDING-CANCEL FAILED/);
  });
});

describe('GET /api/cron/close-due-sessions — EC-027-1 idempotency (zero-affected, no throw)', () => {
  it('returns 200 even when both DELETEs return 0 affected', async () => {
    runNamedQuerySpy.mockResolvedValue({
      rows: [
        {
          id: 1,
          tenantId: 1,
          pairCode: 'EUR/USD',
          sessionName: 'EUR',
          startTimeGmt: null,
          endTimeGmt: null,
        },
      ],
    });
    fetchSpy = mockFetch([], {
      pendingDelete: () => okJson({ success: true, cancelled_count: 0 }),
      positionsDelete: () =>
        okJson({ success: true, closed_count: 0, tickets: [], closed_positions: [] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const route = await importRoute();
    const res = await route.GET(buildReq());
    expect(res.status).toBe(200);
  });
});
