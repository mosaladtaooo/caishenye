/**
 * POST /api/internal/anthropic/fire — fire an Anthropic Routine.
 *
 * Body: { routine: "executor"|"planner"|"spike-noop", body?: object }
 *
 * Looks up routine_id + bearer from env (PLANNER_ROUTINE_ID/_BEARER for
 * "planner", EXECUTOR_ROUTINE_IDS/_BEARERS JSON keyed by routine name for
 * "executor"+, SPIKE_NOOP_ROUTINE_ID/_BEARER for "spike-noop"). Calls
 * /v1/claude_code/routines/${id}/fire with the experimental beta header.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');
const plannerBearer = `sk-ant-oat01-test-${randomBytes(16).toString('hex')}`;
const executorBearer = `sk-ant-oat01-test-${randomBytes(16).toString('hex')}`;

let fetchSpy: ReturnType<typeof vi.fn>;
const origEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of [
    'INTERNAL_API_TOKEN',
    'PLANNER_ROUTINE_ID',
    'PLANNER_ROUTINE_BEARER',
    'EXECUTOR_ROUTINE_IDS',
    'EXECUTOR_ROUTINE_BEARERS',
    'SPIKE_NOOP_ROUTINE_ID',
    'SPIKE_NOOP_ROUTINE_BEARER',
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
  process.env.PLANNER_ROUTINE_ID = 'trig_planner_001';
  process.env.PLANNER_ROUTINE_BEARER = plannerBearer;
  process.env.EXECUTOR_ROUTINE_IDS = JSON.stringify({ default: 'trig_executor_001' });
  process.env.EXECUTOR_ROUTINE_BEARERS = JSON.stringify({ default: executorBearer });
  process.env.ANTHROPIC_ROUTINES_BASE_URL = 'https://api.anthropic.test';
  process.env.ROUTINE_BETA_HEADER = 'experimental-cc-routine-2026-04-01';
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
  return await import('../../../app/api/internal/anthropic/fire/route');
}

function buildReq(body: unknown, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/anthropic/fire', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/anthropic/fire — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/internal/anthropic/fire — body validation', () => {
  it('rejects missing routine field with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({}, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects unknown routine name with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'magic' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/internal/anthropic/fire — env-routing per routine name', () => {
  it('looks up planner via PLANNER_ROUTINE_ID + PLANNER_ROUTINE_BEARER', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ one_off_id: 'oneoff_planner_abc', session_id: 'session_planner_abc' }),
        { status: 200 },
      ),
    );
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'planner' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.test/v1/claude_code/routines/trig_planner_001/fire');
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Bearer ${plannerBearer}`);
    const beta = (init.headers as Record<string, string>)['anthropic-beta'];
    expect(beta).toBe('experimental-cc-routine-2026-04-01');
  });

  it('looks up executor via EXECUTOR_ROUTINE_IDS["default"] + EXECUTOR_ROUTINE_BEARERS["default"]', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ one_off_id: 'oneoff_executor_xyz' }), { status: 200 }),
    );
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.test/v1/claude_code/routines/trig_executor_001/fire');
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toBe(`Bearer ${executorBearer}`);
  });

  it('returns 500 when env for the requested routine is missing', async () => {
    delete process.env.PLANNER_ROUTINE_ID;
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'planner' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/anthropic/fire — happy path returns oneoff id', () => {
  it('returns ok with anthropicOneOffId', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ one_off_id: 'oneoff_xyz', session_id: 'session_xyz' }), {
        status: 200,
      }),
    );
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; anthropicOneOffId: string };
    expect(body.ok).toBe(true);
    expect(body.anthropicOneOffId).toBe('oneoff_xyz');
  });

  it('forwards body to upstream when supplied', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ one_off_id: 'oneoff' }), { status: 200 }),
    );
    const route = await importRoute();
    await route.POST(
      buildReq(
        { routine: 'executor', body: { pair_schedule_id: 42, reason: 'planner-fan-out' } },
        `Bearer ${fixtureBearer}`,
      ),
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.pair_schedule_id).toBe(42);
    expect(sent.reason).toBe('planner-fan-out');
  });
});

describe('POST /api/internal/anthropic/fire — upstream errors', () => {
  it('returns 502 when upstream returns 5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 502 when upstream response has no one_off_id', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });

  it('returns 502 when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    const route = await importRoute();
    const res = await route.POST(buildReq({ routine: 'executor' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(502);
  });
});
