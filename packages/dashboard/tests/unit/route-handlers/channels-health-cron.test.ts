/**
 * /api/cron/channels-health — Vercel cron handler (FR-005 AC-005-2).
 *
 * Every 5 min:
 *   1. CRON_SECRET-gate the request (already implemented by validateCronAuth).
 *   2. Fetch HEALTHCHECK_URL with HEALTH_BEARER_TOKEN.
 *   3. Insert a `channels_health` row with healthy_bool + latency_ms + error.
 *   4. If unhealthy AND most recent unhealthy state has been >10 min:
 *      send a Telegram alert (per AC-005-2).
 *   5. Honour `mute_alarm_until` (ADR-009): if a row in the future, suppress
 *      the alert.
 *
 * R3 audit-or-abort: every channels_health insert MUST happen even if the
 * fetch errored (degraded healthy=false row), so the operator can see "we
 * couldn't reach the VPS at HH:MM".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CRON_KEY = 'cron-test-only-token';
const TEST_HEALTH_URL = 'https://caishen-vps.tailnet.ts.net/healthz';
const TEST_HEALTH_BEARER = 'health-bearer-test-only';

let fetchSpy: ReturnType<typeof vi.fn>;
let insertHealthSpy: ReturnType<typeof vi.fn>;
let lastUnhealthySpy: ReturnType<typeof vi.fn>;
let muteCheckSpy: ReturnType<typeof vi.fn>;
let telegramBroadcastSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CRON_SECRET = TEST_CRON_KEY;
  process.env.HEALTHCHECK_URL = TEST_HEALTH_URL;
  process.env.HEALTH_BEARER_TOKEN = TEST_HEALTH_BEARER;
  fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          tenantId: 1,
          healthy: true,
          uptimeSec: 3600,
          lastMessageHandledAt: '2026-05-04T11:55:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchSpy);
  insertHealthSpy = vi.fn(async () => 999);
  lastUnhealthySpy = vi.fn(async () => null);
  muteCheckSpy = vi.fn(async () => false);
  telegramBroadcastSpy = vi.fn(async () => undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importRoute() {
  vi.doMock('../../../lib/channels-health-cron', () => ({
    insertChannelsHealthRow: insertHealthSpy,
    queryLastUnhealthyTransition: lastUnhealthySpy,
    isMutedAlarm: muteCheckSpy,
  }));
  vi.doMock('../../../lib/telegram-broadcast', () => ({
    sendTelegramBroadcast: telegramBroadcastSpy,
  }));
  return await import('../../../app/api/cron/channels-health/route');
}

function buildReq(opts: { secret?: string }): Request {
  const headers = new Headers();
  const tok = opts.secret ?? TEST_CRON_KEY;
  headers.set('Authorization', `Bearer ${tok}`);
  return new Request('https://app.local/api/cron/channels-health', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/channels-health — auth', () => {
  it('returns 401 without CRON_SECRET', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({ secret: 'wrong' }));
    expect(res.status).toBe(401);
    expect(insertHealthSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/channels-health — happy path', () => {
  it('fetches healthcheck endpoint with bearer + inserts healthy row + returns 200', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({}));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchCallArgs = fetchSpy.mock.calls[0];
    expect(fetchCallArgs?.[0]).toBe(TEST_HEALTH_URL);
    const fetchOpts = fetchCallArgs?.[1] as RequestInit | undefined;
    const headers = fetchOpts?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization ?? headers?.authorization).toBe(`Bearer ${TEST_HEALTH_BEARER}`);

    expect(insertHealthSpy).toHaveBeenCalledTimes(1);
    const insertArg = insertHealthSpy.mock.calls[0]?.[0];
    expect(insertArg.healthyBool).toBe(true);
    expect(insertArg.tenantId).toBe(1);
    expect(typeof insertArg.latencyMs).toBe('number');
    expect(insertArg.error).toBeNull();
  });

  it('does NOT send a telegram alert when healthy', async () => {
    const route = await importRoute();
    await route.GET(buildReq({}));
    expect(telegramBroadcastSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/channels-health — unhealthy paths', () => {
  it('inserts unhealthy row when fetch returns healthy=false', async () => {
    fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tenantId: 1,
            healthy: false,
            uptimeSec: 3600,
            lastMessageHandledAt: '2026-05-04T10:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    await route.GET(buildReq({}));

    expect(insertHealthSpy).toHaveBeenCalledTimes(1);
    const insertArg = insertHealthSpy.mock.calls[0]?.[0];
    expect(insertArg.healthyBool).toBe(false);
  });

  it('inserts unhealthy row when fetch throws (network error)', async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    const res = await route.GET(buildReq({}));

    expect(res.status).toBe(200); // The cron itself doesn't fail; it records the failure.
    expect(insertHealthSpy).toHaveBeenCalledTimes(1);
    const insertArg = insertHealthSpy.mock.calls[0]?.[0];
    expect(insertArg.healthyBool).toBe(false);
    expect(insertArg.error).toMatch(/ECONNREFUSED/);
  });

  it('inserts unhealthy row when fetch returns non-2xx', async () => {
    fetchSpy = vi.fn(async () => new Response('oops', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);

    const route = await importRoute();
    await route.GET(buildReq({}));

    expect(insertHealthSpy).toHaveBeenCalledTimes(1);
    const insertArg = insertHealthSpy.mock.calls[0]?.[0];
    expect(insertArg.healthyBool).toBe(false);
    expect(insertArg.error).toMatch(/503/);
  });
});

describe('GET /api/cron/channels-health — alert tier (>10 min unhealthy)', () => {
  it('does NOT alert on first unhealthy row (queryLastUnhealthyTransition returns null)', async () => {
    fetchSpy = vi.fn(async () => new Response('oops', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);
    lastUnhealthySpy = vi.fn(async () => null); // no prior unhealthy row

    const route = await importRoute();
    await route.GET(buildReq({}));

    expect(telegramBroadcastSpy).not.toHaveBeenCalled();
  });

  it('alerts when unhealthy duration exceeds 10 min', async () => {
    fetchSpy = vi.fn(async () => new Response('oops', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);
    // Last became unhealthy 11 min ago.
    lastUnhealthySpy = vi.fn(async () => new Date(Date.now() - 11 * 60_000));

    const route = await importRoute();
    await route.GET(buildReq({}));

    expect(telegramBroadcastSpy).toHaveBeenCalledTimes(1);
    const msg = telegramBroadcastSpy.mock.calls[0]?.[0];
    expect(msg).toMatch(/channels|down|unhealthy/i);
  });

  it('does NOT alert when mute_alarm_until is in the future (ADR-009)', async () => {
    fetchSpy = vi.fn(async () => new Response('oops', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);
    lastUnhealthySpy = vi.fn(async () => new Date(Date.now() - 11 * 60_000));
    muteCheckSpy = vi.fn(async () => true); // muted

    const route = await importRoute();
    await route.GET(buildReq({}));

    expect(telegramBroadcastSpy).not.toHaveBeenCalled();
  });
});
