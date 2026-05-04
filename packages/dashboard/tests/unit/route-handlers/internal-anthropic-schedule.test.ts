/**
 * POST /api/internal/anthropic/schedule — schedule an Anthropic Routine
 * one-off at a future time. Mirrors fire route's resolver + auth shape.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');
const executorBearer = `sk-ant-oat01-test-${randomBytes(16).toString('hex')}`;

let fetchSpy: ReturnType<typeof vi.fn>;
const origEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of [
    'INTERNAL_API_TOKEN',
    'EXECUTOR_ROUTINE_IDS',
    'EXECUTOR_ROUTINE_BEARERS',
    'ANTHROPIC_ROUTINES_BASE_URL',
    'ROUTINE_BETA_HEADER',
  ]) {
    origEnv[k] = process.env[k];
  }
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  snapshotEnv();
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  process.env.EXECUTOR_ROUTINE_IDS = JSON.stringify({ default: 'trig_executor_001' });
  process.env.EXECUTOR_ROUTINE_BEARERS = JSON.stringify({ default: executorBearer });
  process.env.ANTHROPIC_ROUTINES_BASE_URL = 'https://api.anthropic.test';
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function importRoute() {
  return await import('../../../app/api/internal/anthropic/schedule/route');
}

function buildReq(body: unknown, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/anthropic/schedule', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const validBody = {
  routine: 'executor',
  fire_at_iso: '2026-05-04T13:30:00Z',
  body: { pair_schedule_id: 5 },
};

describe('POST /api/internal/anthropic/schedule — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq(validBody));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(buildReq(validBody, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/internal/anthropic/schedule — body validation', () => {
  it('rejects missing routine with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ fire_at_iso: '2026-05-04T13:30:00Z' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing fire_at_iso with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects invalid ISO format in fire_at_iso with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ routine: 'executor', fire_at_iso: 'not-an-iso-date' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown routine name with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { routine: 'unknown', fire_at_iso: '2026-05-04T13:30:00Z' },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/internal/anthropic/schedule — happy path', () => {
  it('POSTs to /v1/routines/${id}/schedule with fire_at_iso in body', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ scheduled_one_off_id: 'sched_xyz' }), { status: 200 }),
    );
    const route = await importRoute();
    const res = await route.POST(buildReq(validBody, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.test/v1/routines/trig_executor_001/schedule');
    const sent = JSON.parse(init.body as string);
    expect(sent.fire_at).toBe('2026-05-04T13:30:00Z');
    const body = (await res.json()) as { ok: boolean; scheduledOneOffId: string };
    expect(body.scheduledOneOffId).toBe('sched_xyz');
  });

  it('forwards inner body alongside fire_at', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ scheduled_one_off_id: 'sched' }), { status: 200 }),
    );
    const route = await importRoute();
    await route.POST(buildReq(validBody, `Bearer ${fixtureBearer}`));
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.body.pair_schedule_id).toBe(5);
  });
});

describe('POST /api/internal/anthropic/schedule — upstream errors', () => {
  it('returns 502 when upstream 5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('down', { status: 503 }));
    const route = await importRoute();
    const res = await route.POST(buildReq(validBody, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 502 when upstream response missing scheduled_one_off_id', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const route = await importRoute();
    const res = await route.POST(buildReq(validBody, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });
});
