/**
 * GET /api/cron/runner-watchdog -- AC-024-4 path 2 Vercel-cron backstop.
 *
 * v1.2 FR-024 D5: Vercel cron `*\/30 * * * *` hits this route. It queries
 * MAX(pinged_at) FROM cron_runner_health WHERE tenant_id = $1; if
 * now() - max_pinged_at > interval '30 minutes', emits ONE direct Telegram
 * Bot API alert: "Cron-runner ALL DEAD -- last ping HH:MM GMT, 30+ min stale."
 *
 * Coverage:
 *   (a) fresh max(pinged_at) (e.g., 5min stale) -> no alert
 *   (b) 25 min stale (under 30 threshold) -> no alert
 *   (c) 35 min stale -> 1 alert via Telegram Bot API mock
 *   (d) no cron_runner_health rows at all -> 1 alert with explicit "never received"
 *   (e) Telegram Bot API call failure does NOT throw the route (logs + 200)
 *   (f) wrong bearer -> 401
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronToken = randomBytes(32).toString('hex');
const tgBotToken = `${randomBytes(8).toString('hex')}:test-bot-token`;
const operatorChatId = '12345';

let selectMaxSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let originalCronSecret: string | undefined;
let originalTgToken: string | undefined;
let originalChatId: string | undefined;

beforeEach(() => {
  originalCronSecret = process.env.CRON_SECRET;
  originalTgToken = process.env.TELEGRAM_BOT_TOKEN;
  originalChatId = process.env.OPERATOR_CHAT_ID;
  process.env.CRON_SECRET = cronToken;
  process.env.TELEGRAM_BOT_TOKEN = tgBotToken;
  process.env.OPERATOR_CHAT_ID = operatorChatId;
  selectMaxSpy = vi.fn();
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  if (originalTgToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalTgToken;
  if (originalChatId === undefined) delete process.env.OPERATOR_CHAT_ID;
  else process.env.OPERATOR_CHAT_ID = originalChatId;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('@caishen/db/client', () => ({
    getTenantDb: vi.fn(() => ({
      drizzle: {
        select: () => ({
          from: () => ({
            where: selectMaxSpy,
          }),
        }),
      },
    })),
  }));
  return await import('../../../app/api/cron/runner-watchdog/route');
}

function buildReq(bearer: string | undefined): Request {
  const headers = new Headers();
  if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
  return new Request('https://app.local/api/cron/runner-watchdog', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/runner-watchdog -- auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/cron/runner-watchdog -- staleness checks', () => {
  it('case (a): fresh ping (5 min stale) -> no Telegram emitted, returns 200 ok', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    selectMaxSpy.mockResolvedValueOnce([{ maxPingedAt: fiveMinAgo }]);
    const route = await importRoute();
    const res = await route.GET(buildReq(cronToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; alertEmitted: boolean };
    expect(body.ok).toBe(true);
    expect(body.alertEmitted).toBe(false);
    // Telegram Bot API NOT called.
    const tgCalls = fetchSpy.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : '';
      return url.includes('api.telegram.org');
    });
    expect(tgCalls.length).toBe(0);
  });

  it('case (b): 25 min stale (under 30 threshold) -> no alert', async () => {
    const stale25 = new Date(Date.now() - 25 * 60_000);
    selectMaxSpy.mockResolvedValueOnce([{ maxPingedAt: stale25 }]);
    const route = await importRoute();
    const res = await route.GET(buildReq(cronToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alertEmitted: boolean };
    expect(body.alertEmitted).toBe(false);
  });

  it('case (c): 35 min stale -> 1 Telegram Bot API alert', async () => {
    const stale35 = new Date(Date.now() - 35 * 60_000);
    selectMaxSpy.mockResolvedValueOnce([{ maxPingedAt: stale35 }]);
    const route = await importRoute();
    const res = await route.GET(buildReq(cronToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alertEmitted: boolean };
    expect(body.alertEmitted).toBe(true);
    // Telegram Bot API called once.
    const tgCalls = fetchSpy.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : '';
      return url.includes('api.telegram.org');
    });
    expect(tgCalls.length).toBe(1);
    // Verify URL pattern + body shape.
    const [tgUrl, tgInit] = tgCalls[0] as [string, RequestInit];
    expect(tgUrl).toMatch(/api\.telegram\.org\/bot.*\/sendMessage/);
    const tgBody = JSON.parse(tgInit.body as string) as { text: string };
    expect(tgBody.text).toMatch(/Cron-runner ALL DEAD/);
    expect(tgBody.text).toMatch(/30\+ min stale/);
  });

  it('case (d): no cron_runner_health rows -> 1 alert "never received any pings"', async () => {
    selectMaxSpy.mockResolvedValueOnce([{ maxPingedAt: null }]);
    const route = await importRoute();
    const res = await route.GET(buildReq(cronToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alertEmitted: boolean };
    expect(body.alertEmitted).toBe(true);
    const tgCalls = fetchSpy.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : '';
      return url.includes('api.telegram.org');
    });
    expect(tgCalls.length).toBe(1);
    const tgBody = JSON.parse((tgCalls[0]?.[1] as RequestInit).body as string) as {
      text: string;
    };
    expect(tgBody.text).toMatch(/never received any pings/);
  });
});

describe('GET /api/cron/runner-watchdog -- Telegram failure boundary', () => {
  it('Telegram Bot API fetch failure does NOT crash the route (logs + 200)', async () => {
    const stale35 = new Date(Date.now() - 35 * 60_000);
    selectMaxSpy.mockResolvedValueOnce([{ maxPingedAt: stale35 }]);
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error('telegram: ECONNREFUSED');
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(cronToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alertEmitted: boolean; alertError?: string };
    // alertEmitted=false because fetch failed; alertError documents the failure.
    expect(body.alertEmitted).toBe(false);
    expect(body.alertError).toMatch(/ECONNREFUSED/);
  });
});
