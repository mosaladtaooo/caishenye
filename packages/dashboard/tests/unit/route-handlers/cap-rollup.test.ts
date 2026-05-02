/**
 * /api/cron/cap-rollup — daily 12:00 GMT (FR-021 AC-021-1).
 *
 * 1. CRON_SECRET-gated.
 * 2. Reads yesterday's cap_usage_local rows, computes daily_used.
 * 3. Upserts a cap_usage row with source='local_counter'.
 * 4. (Optional) If the /v1/usage cross-check is enabled, fetches the
 *    Anthropic /v1/usage endpoint, inserts a parallel row with
 *    source='anthropic_api', and alerts via Telegram if drift > 1.
 * 5. Sends the cap-tier transition alert (12/15 warning, 14/15 hard) per
 *    AC-021-3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CRON_KEY = 'cron-test-token';

let readLocalSpy: ReturnType<typeof vi.fn>;
let upsertCapUsageSpy: ReturnType<typeof vi.fn>;
let telegramBroadcastSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CRON_SECRET = TEST_CRON_KEY;
  delete process.env.ANTHROPIC_USAGE_RECONCILE_ENABLED;
  readLocalSpy = vi.fn(async () => [
    { id: 1, at: new Date('2026-05-04T05:00:00Z'), capKind: 'planner_recurring' },
    { id: 2, at: new Date('2026-05-04T08:00:00Z'), capKind: 'executor_one_off_cap_counted' },
  ]);
  upsertCapUsageSpy = vi.fn(async () => undefined);
  telegramBroadcastSpy = vi.fn(async () => undefined);
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importRoute() {
  vi.doMock('../../../lib/cap-rollup', () => ({
    readYesterdayCapLocal: readLocalSpy,
    upsertCapUsageDaily: upsertCapUsageSpy,
    fetchAnthropicUsage: vi.fn(async () => null),
  }));
  vi.doMock('../../../lib/telegram-broadcast', () => ({
    sendTelegramBroadcast: telegramBroadcastSpy,
  }));
  return await import('../../../app/api/cron/cap-rollup/route');
}

function buildReq(opts: { secret?: string }): Request {
  const headers = new Headers();
  const secret = opts.secret ?? TEST_CRON_KEY;
  headers.set('Authorization', `Bearer ${secret}`);
  return new Request('https://app.local/api/cron/cap-rollup', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cap-rollup — auth', () => {
  it('returns 401 without CRON_SECRET', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({ secret: 'wrong' }));
    expect(res.status).toBe(401);
    expect(readLocalSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/cap-rollup — happy path', () => {
  it('reads yesterday + upserts cap_usage with daily_used count', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({}));
    expect(res.status).toBe(200);
    expect(upsertCapUsageSpy).toHaveBeenCalledTimes(1);
    const arg = upsertCapUsageSpy.mock.calls[0]?.[0];
    expect(arg.dailyUsed).toBe(2);
    expect(arg.source).toBe('local_counter');
    expect(arg.dailyLimit).toBe(15);
  });

  it('does NOT alert when daily_used < 12', async () => {
    const route = await importRoute();
    await route.GET(buildReq({}));
    expect(telegramBroadcastSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/cap-rollup — alert tiers', () => {
  it('alerts at 12/15 warning threshold', async () => {
    readLocalSpy = vi.fn(async () => {
      const rows: { id: number; at: Date; capKind: string }[] = [];
      for (let i = 0; i < 12; i++) {
        rows.push({
          id: i + 1,
          at: new Date('2026-05-04T05:00:00Z'),
          capKind: 'planner_recurring',
        });
      }
      return rows;
    });
    const route = await importRoute();
    await route.GET(buildReq({}));
    expect(telegramBroadcastSpy).toHaveBeenCalledTimes(1);
    const msg = telegramBroadcastSpy.mock.calls[0]?.[0];
    expect(msg).toMatch(/cap warning|12 \/ 15/);
  });

  it('alerts at 14/15 hard threshold', async () => {
    readLocalSpy = vi.fn(async () => {
      const rows: { id: number; at: Date; capKind: string }[] = [];
      for (let i = 0; i < 14; i++) {
        rows.push({
          id: i + 1,
          at: new Date('2026-05-04T05:00:00Z'),
          capKind: 'planner_recurring',
        });
      }
      return rows;
    });
    const route = await importRoute();
    await route.GET(buildReq({}));
    expect(telegramBroadcastSpy).toHaveBeenCalledTimes(1);
    const msg = telegramBroadcastSpy.mock.calls[0]?.[0];
    expect(msg).toMatch(/cap hard|14 \/ 15/);
  });

  it('does NOT alert at 13/15 (between thresholds)', async () => {
    readLocalSpy = vi.fn(async () => {
      const rows: { id: number; at: Date; capKind: string }[] = [];
      for (let i = 0; i < 13; i++) {
        rows.push({
          id: i + 1,
          at: new Date('2026-05-04T05:00:00Z'),
          capKind: 'planner_recurring',
        });
      }
      return rows;
    });
    const route = await importRoute();
    await route.GET(buildReq({}));
    expect(telegramBroadcastSpy).not.toHaveBeenCalled();
  });
});
