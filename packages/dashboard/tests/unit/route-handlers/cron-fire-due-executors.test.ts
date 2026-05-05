/**
 * GET /api/cron/fire-due-executors — every-minute cron tick tests (v1.1 ADR-013).
 *
 * Verifies:
 *   - CRON_SECRET auth (401 without; 500 LOUD when env missing)
 *   - Empty due-list → 200 with dueCount=0 (fast path)
 *   - For each due row: claim → fire → settle (happy path)
 *   - Claim race lost → outcome='claim-lost', no fire attempt
 *   - Fire fails → outcome='fire-failed', claim released, telegram alert
 *   - Settle fails → outcome='settle-failed' (fire succeeded; orphan-detect handles)
 *   - Multiple rows processed sequentially with per-row outcomes
 *   - XAU/USD pair triggers the symbol-cleaning hint in the executor text
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CRON_KEY = `cron-test-token-${randomBytes(8).toString('hex')}`;
const TEST_INTERNAL_TOKEN = randomBytes(32).toString('hex');
const TEST_EXECUTOR_BEARER = `sk-ant-oat01-test-${randomBytes(16).toString('hex')}`;

let runNamedQuerySpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

const origEnv: Record<string, string | undefined> = {};
function snapshotEnv(): void {
  for (const k of [
    'CRON_SECRET',
    'INTERNAL_API_TOKEN',
    'AUTH_URL',
    'EXECUTOR_ROUTINE_IDS',
    'EXECUTOR_ROUTINE_BEARERS',
    'ANTHROPIC_ROUTINES_BASE_URL',
    'ROUTINE_BETA_HEADER',
    'DEFAULT_TENANT_ID',
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
  process.env.CRON_SECRET = TEST_CRON_KEY;
  process.env.INTERNAL_API_TOKEN = TEST_INTERNAL_TOKEN;
  process.env.AUTH_URL = 'https://app.test';
  process.env.EXECUTOR_ROUTINE_IDS = JSON.stringify({ default: 'trig_executor_001' });
  process.env.EXECUTOR_ROUTINE_BEARERS = JSON.stringify({ default: TEST_EXECUTOR_BEARER });
  process.env.ANTHROPIC_ROUTINES_BASE_URL = 'https://api.anthropic.test';
  process.env.DEFAULT_TENANT_ID = '1';
  runNamedQuerySpy = vi.fn();
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
  vi.doMock('../../../lib/internal-postgres-queries', () => ({
    runNamedQuery: runNamedQuerySpy,
    KNOWN_QUERY_NAMES: [],
  }));
  return await import('../../../app/api/cron/fire-due-executors/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/cron/fire-due-executors', {
    method: 'GET',
    headers,
  });
}

function dueRow(overrides: Partial<{ id: number; pairCode: string; sessionName: string }> = {}) {
  return {
    id: overrides.id ?? 42,
    tenantId: 1,
    pairCode: overrides.pairCode ?? 'EUR/USD',
    sessionName: overrides.sessionName ?? 'london',
    startTimeGmt: new Date('2026-05-05T08:00:00Z'),
    endTimeGmt: new Date('2026-05-05T12:00:00Z'),
  };
}

describe('GET /api/cron/fire-due-executors — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });

  it('returns 500 when CRON_SECRET missing', async () => {
    delete process.env.CRON_SECRET;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(res.status).toBe(500);
  });

  it('returns 401 with wrong bearer', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq('Bearer wrong-token'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/cron/fire-due-executors — empty due-list', () => {
  it('returns 200 with dueCount=0 when no rows are due', async () => {
    runNamedQuerySpy.mockResolvedValueOnce({ rows: [] });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dueCount: number; results: unknown[] };
    expect(body.dueCount).toBe(0);
    expect(body.results).toEqual([]);
  });

  it('does NOT call Anthropic /fire when no rows are due', async () => {
    runNamedQuerySpy.mockResolvedValueOnce({ rows: [] });
    const route = await importRoute();
    await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/fire-due-executors — happy path', () => {
  it('claims, fires, and settles a single due row', async () => {
    const row = dueRow({ id: 42, pairCode: 'EUR/USD', sessionName: 'london' });
    runNamedQuerySpy.mockImplementation(async (req: { name: string }) => {
      if (req.name === 'select_pair_schedules_due_for_fire') return { rows: [row] };
      if (req.name === 'claim_pair_schedule_for_fire')
        return { rows: [{ id: 42 }], rowsAffected: 1 };
      if (req.name === 'update_pair_schedule_fired') return { rows: [{ id: 42 }], rowsAffected: 1 };
      throw new Error(`unexpected query: ${req.name}`);
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          claude_code_session_id: 'session_01HJK',
          claude_code_session_url: 'https://claude.ai/code/session_01HJK',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dueCount: number;
      firedCount: number;
      results: Array<{ outcome: string; session_id?: string }>;
    };
    expect(body.dueCount).toBe(1);
    expect(body.firedCount).toBe(1);
    expect(body.results[0]?.outcome).toBe('fired');
    expect(body.results[0]?.session_id).toBe('session_01HJK');

    // Verify the fire URL was called correctly.
    const calls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/v1/claude_code/routines/'),
    );
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toBe(
      'https://api.anthropic.test/v1/claude_code/routines/trig_executor_001/fire',
    );
    const fireInit = calls[0]?.[1] as RequestInit;
    expect(fireInit.method).toBe('POST');
    const fireBody = JSON.parse(fireInit.body as string) as { text: string };
    expect(fireBody.text).toMatch(/pair_schedule_id=42/);
    expect(fireBody.text).toMatch(/sessionName=london/);
    expect(fireBody.text).toMatch(/Current Analysis Pair :\nEUR\/USD/);
  });

  it('embeds XAU symbol-cleaning hint when pair is XAU/USD', async () => {
    const row = dueRow({ id: 99, pairCode: 'XAU/USD', sessionName: 'ny' });
    runNamedQuerySpy.mockImplementation(async (req: { name: string }) => {
      if (req.name === 'select_pair_schedules_due_for_fire') return { rows: [row] };
      if (req.name === 'claim_pair_schedule_for_fire')
        return { rows: [{ id: 99 }], rowsAffected: 1 };
      return { rows: [{ id: 99 }], rowsAffected: 1 };
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ claude_code_session_id: 'session_xau' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const route = await importRoute();
    await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    const fireCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/fire'));
    const fireBody = JSON.parse((fireCall?.[1] as RequestInit).body as string) as { text: string };
    expect(fireBody.text).toMatch(/'XAUUSD'/);
  });

  it('falls back to legacy one_off_id when claude_code_session_id is absent', async () => {
    const row = dueRow();
    runNamedQuerySpy.mockImplementation(async (req: { name: string }) => {
      if (req.name === 'select_pair_schedules_due_for_fire') return { rows: [row] };
      if (req.name === 'claim_pair_schedule_for_fire')
        return { rows: [{ id: 42 }], rowsAffected: 1 };
      return { rows: [{ id: 42 }], rowsAffected: 1 };
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ one_off_id: 'one_off_legacy_xyz' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    const body = (await res.json()) as { results: Array<{ session_id?: string }> };
    expect(body.results[0]?.session_id).toBe('one_off_legacy_xyz');
  });
});

describe('GET /api/cron/fire-due-executors — claim race', () => {
  it('reports outcome=claim-lost when atomic claim returns 0 rows', async () => {
    const row = dueRow();
    runNamedQuerySpy.mockImplementation(async (req: { name: string }) => {
      if (req.name === 'select_pair_schedules_due_for_fire') return { rows: [row] };
      if (req.name === 'claim_pair_schedule_for_fire') return { rows: [], rowsAffected: 0 };
      throw new Error(`unexpected query: ${req.name}`);
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      firedCount: number;
      results: Array<{ outcome: string }>;
    };
    expect(body.firedCount).toBe(0);
    expect(body.results[0]?.outcome).toBe('claim-lost');
    // Did NOT attempt to call Anthropic.
    const fireCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/fire'));
    expect(fireCalls).toHaveLength(0);
  });
});

describe('GET /api/cron/fire-due-executors — fire-failed path', () => {
  it('releases the claim and reports outcome=fire-failed on Anthropic 5xx', async () => {
    const row = dueRow();
    let releaseCalled = false;
    runNamedQuerySpy.mockImplementation(
      async (req: { name: string; params: Record<string, unknown> }) => {
        if (req.name === 'select_pair_schedules_due_for_fire') return { rows: [row] };
        if (req.name === 'claim_pair_schedule_for_fire')
          return { rows: [{ id: 42 }], rowsAffected: 1 };
        if (
          req.name === 'update_pair_schedule_one_off_id' &&
          req.params.scheduledOneOffId === null
        ) {
          releaseCalled = true;
          return { rows: [{ id: 42 }], rowsAffected: 1 };
        }
        throw new Error(`unexpected query: ${req.name}`);
      },
    );
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/v1/claude_code/routines/')) {
        return new Response('upstream gateway error', { status: 502 });
      }
      // Telegram alert path
      return new Response(JSON.stringify({ ok: true, telegramMessageId: 1 }), { status: 200 });
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      firedCount: number;
      results: Array<{ outcome: string; error?: string }>;
    };
    expect(body.firedCount).toBe(0);
    expect(body.results[0]?.outcome).toBe('fire-failed');
    expect(body.results[0]?.error).toMatch(/HTTP 502/);
    expect(releaseCalled).toBe(true);
  });
});

describe('GET /api/cron/fire-due-executors — settle-failed path', () => {
  it('reports outcome=settle-failed when DB update after fire fails (orphan-detect handles)', async () => {
    const row = dueRow();
    runNamedQuerySpy.mockImplementation(async (req: { name: string }) => {
      if (req.name === 'select_pair_schedules_due_for_fire') return { rows: [row] };
      if (req.name === 'claim_pair_schedule_for_fire')
        return { rows: [{ id: 42 }], rowsAffected: 1 };
      if (req.name === 'update_pair_schedule_fired') throw new Error('postgres connection lost');
      throw new Error(`unexpected query: ${req.name}`);
    });
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/v1/claude_code/routines/')) {
        return new Response(JSON.stringify({ claude_code_session_id: 'session_orphan' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    const body = (await res.json()) as {
      results: Array<{ outcome: string; session_id?: string; error?: string }>;
    };
    expect(body.results[0]?.outcome).toBe('settle-failed');
    expect(body.results[0]?.session_id).toBe('session_orphan');
  });
});

describe('GET /api/cron/fire-due-executors — multi-row processing', () => {
  it('processes 3 rows independently and reports per-row outcomes', async () => {
    const rows = [
      dueRow({ id: 1, pairCode: 'EUR/USD', sessionName: 'london' }),
      dueRow({ id: 2, pairCode: 'XAU/USD', sessionName: 'london' }),
      dueRow({ id: 3, pairCode: 'GBP/USD', sessionName: 'london' }),
    ];
    let claimCount = 0;
    let fireCount = 0;
    runNamedQuerySpy.mockImplementation(
      async (req: { name: string; params: Record<string, unknown> }) => {
        if (req.name === 'select_pair_schedules_due_for_fire') return { rows };
        if (req.name === 'claim_pair_schedule_for_fire') {
          claimCount += 1;
          // Row 2 loses the claim race.
          if (req.params.id === 2) return { rows: [], rowsAffected: 0 };
          return { rows: [{ id: req.params.id }], rowsAffected: 1 };
        }
        if (req.name === 'update_pair_schedule_fired')
          return { rows: [{ id: req.params.id }], rowsAffected: 1 };
        if (req.name === 'update_pair_schedule_one_off_id')
          return { rows: [{ id: req.params.id }], rowsAffected: 1 };
        throw new Error(`unexpected query: ${req.name}`);
      },
    );
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/v1/claude_code/routines/')) {
        fireCount += 1;
        // Row 3's fire fails.
        if (fireCount === 2) {
          return new Response('upstream gateway error', { status: 502 });
        }
        return new Response(JSON.stringify({ claude_code_session_id: `session_${fireCount}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    const body = (await res.json()) as {
      dueCount: number;
      firedCount: number;
      results: Array<{ pair_schedule_id: number; outcome: string }>;
    };
    expect(body.dueCount).toBe(3);
    expect(body.firedCount).toBe(1); // row 1 fired; row 2 claim-lost; row 3 fire-failed
    expect(claimCount).toBe(3);
    expect(body.results.find((r) => r.pair_schedule_id === 1)?.outcome).toBe('fired');
    expect(body.results.find((r) => r.pair_schedule_id === 2)?.outcome).toBe('claim-lost');
    expect(body.results.find((r) => r.pair_schedule_id === 3)?.outcome).toBe('fire-failed');
  });
});

describe('GET /api/cron/fire-due-executors — select-failed path', () => {
  it('returns 500 when the select_due query throws', async () => {
    runNamedQuerySpy.mockRejectedValueOnce(new Error('postgres unreachable'));
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${TEST_CRON_KEY}`));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/select_due failed/);
  });
});
