/**
 * FR-001 AC-001-3 — `/fire` API verification + (R1) deployed-prompt READ probe.
 *
 * The spike module under test:
 *   packages/routines/src/spike/ac-001-3-fire-api.ts
 *
 * Per the contract:
 *   - Fires a no-op routine via POST /v1/claude_code/routines/{id}/fire.
 *     Asserts response shape: { type, claude_code_session_id, claude_code_session_url }.
 *     Pins the beta header `experimental-cc-routine-2026-04-01` (ADR-004).
 *   - (R1) ALSO probes two GET endpoints to discover whether deployed system
 *     prompts are fetchable: drives the `deployed_prompt_endpoint` field in
 *     spike-fr-001-outcomes.json which gates AC-002-1-b / AC-003-1-b.
 *
 * Tests stub `fetch` so they don't need a live Anthropic account. The fake
 * bearer values below are obviously-not-secret test fixtures — never copy
 * this shape into a real .env (constitution §10).
 */

import { describe, expect, it, vi } from 'vitest';
import { runSpike3, type Spike3Deps } from '../../src/spike/ac-001-3-fire-api';
import type { FireApiResponse, SpikeEnv } from '../../src/spike/types';

// Test-fixture-only labels — NOT real Anthropic credentials.
const FAKE_BEARER_NOOP = 'TEST_FIXTURE_BEARER_FOR_NOOP_ROUTINE';
const FAKE_BEARER_PLANNER = 'TEST_FIXTURE_BEARER_FOR_PLANNER_ROUTINE';

function makeEnv(over: Partial<SpikeEnv> = {}): SpikeEnv {
  return {
    PLANNER_ROUTINE_ID: 'trig_test_planner',
    PLANNER_ROUTINE_BEARER: FAKE_BEARER_PLANNER,
    SPIKE_NOOP_ROUTINE_ID: 'trig_test_noop',
    SPIKE_NOOP_ROUTINE_BEARER: FAKE_BEARER_NOOP,
    ROUTINE_BETA_HEADER: 'experimental-cc-routine-2026-04-01',
    ...over,
  };
}

function makeDeps(over: Partial<Spike3Deps> = {}): Spike3Deps {
  return {
    fetch: vi.fn(),
    now: () => new Date('2026-05-03T12:00:00Z'),
    recordRoutineRun: vi.fn(async () => ({ id: 1 })),
    env: makeEnv(),
    ...over,
  };
}

const goodFireResponse: FireApiResponse = {
  type: 'routine_fire',
  claude_code_session_id: 'session_01HJKLMNOPQRSTUVWXYZ',
  claude_code_session_url: 'https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ',
};

function makeFetchSequence(...responses: Array<{ status?: number; body?: unknown }>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i] ?? { status: 500, body: {} };
    i += 1;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('Spike 3 (AC-001-3) — /fire POST', () => {
  it('POSTs to /v1/claude_code/routines/{routine_id}/fire with correct headers', async () => {
    const fetchMock = makeFetchSequence(
      { status: 200, body: goodFireResponse },
      { status: 404, body: { error: 'no read endpoint' } },
      { status: 404, body: { error: 'no read endpoint' } },
    );
    const deps = makeDeps({ fetch: fetchMock });

    await runSpike3(deps);

    // First call = the /fire POST.
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/claude_code\/routines\/trig_test_noop\/fire$/);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_BEARER_NOOP}`);
    expect(headers['anthropic-beta']).toBe('experimental-cc-routine-2026-04-01');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('passes a `text` field in the JSON body', async () => {
    const fetchMock = makeFetchSequence(
      { status: 200, body: goodFireResponse },
      { status: 404, body: {} },
      { status: 404, body: {} },
    );
    const deps = makeDeps({ fetch: fetchMock });
    await runSpike3(deps);

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const init = calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.text).toBeTypeOf('string');
    expect(body.text.length).toBeGreaterThan(0);
  });

  it('records PASS when /fire returns the expected shape', async () => {
    const deps = makeDeps({
      fetch: makeFetchSequence(
        { status: 200, body: goodFireResponse },
        { status: 404, body: {} },
        { status: 404, body: {} },
      ),
    });

    const outcome = await runSpike3(deps);

    expect(outcome.status).toBe('PASS');
    expect(outcome.details).toMatchObject({
      claude_code_session_id: 'session_01HJKLMNOPQRSTUVWXYZ',
      claude_code_session_url: 'https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ',
    });
  });

  it('records FAIL when /fire returns 401 (bad bearer)', async () => {
    const deps = makeDeps({
      fetch: makeFetchSequence({ status: 401, body: { error: 'unauthorized' } }),
    });

    const outcome = await runSpike3(deps);

    expect(outcome.status).toBe('FAIL');
    expect(outcome.notes).toMatch(/401|unauthorized/i);
  });

  it('records FAIL when response shape does not match (missing session_id)', async () => {
    const deps = makeDeps({
      fetch: makeFetchSequence(
        { status: 200, body: { type: 'routine_fire' } }, // no session_id
        { status: 404, body: {} },
        { status: 404, body: {} },
      ),
    });

    const outcome = await runSpike3(deps);

    expect(outcome.status).toBe('FAIL');
    expect(outcome.notes).toMatch(/shape|session_id|missing/i);
  });

  it('records FAIL when fetch itself throws (network blip)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const deps = makeDeps({ fetch: fetchMock });

    const outcome = await runSpike3(deps);

    expect(outcome.status).toBe('FAIL');
    expect(outcome.notes).toMatch(/ECONNRESET|network/i);
  });

  it('writes a routine_runs audit row before any fetch (constitution §3 audit-or-abort)', async () => {
    const recordRoutineRun = vi.fn(async () => ({ id: 1 }));
    const fetchMock = makeFetchSequence(
      { status: 200, body: goodFireResponse },
      { status: 404, body: {} },
      { status: 404, body: {} },
    );
    const deps = makeDeps({ recordRoutineRun, fetch: fetchMock });

    await runSpike3(deps);

    // Audit row inserted FIRST.
    const auditOrder = recordRoutineRun.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const fetchOrder =
      (fetchMock as unknown as { mock: { invocationCallOrder: number[] } }).mock
        .invocationCallOrder[0] ?? -1;
    expect(auditOrder).toBeLessThan(fetchOrder);
  });

  it('records spike-noop routine_name in audit row', async () => {
    const recordRoutineRun = vi.fn(async () => ({ id: 1 }));
    const deps = makeDeps({
      recordRoutineRun,
      fetch: makeFetchSequence(
        { status: 200, body: goodFireResponse },
        { status: 404, body: {} },
        { status: 404, body: {} },
      ),
    });

    await runSpike3(deps);

    expect(recordRoutineRun).toHaveBeenCalledWith(
      expect.objectContaining({ routine_name: expect.stringMatching(/spike/i) }),
    );
  });
});

describe('Spike 3 (R1) — deployed-prompt READ endpoint probe', () => {
  it('probes GET /v1/claude_code/routines/{id} first (option a)', async () => {
    const fetchMock = makeFetchSequence(
      { status: 200, body: goodFireResponse },
      { status: 200, body: { id: 'trig_test_noop', system_prompt: 'You are noop.' } },
    );
    const deps = makeDeps({ fetch: fetchMock });

    await runSpike3(deps);

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const [url, init] = calls[1] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/claude_code\/routines\/trig_test_noop$/);
    expect(init.method).toBe('GET');
  });

  it('records deployed_prompt_endpoint when option (a) returns 200 with system_prompt', async () => {
    const deps = makeDeps({
      fetch: makeFetchSequence(
        { status: 200, body: goodFireResponse },
        { status: 200, body: { id: 'trig_test_noop', system_prompt: 'You are noop.' } },
      ),
    });

    const outcome = await runSpike3(deps);

    expect(outcome.details.deployed_prompt_endpoint).toMatchObject({
      url_pattern: expect.stringMatching(/\/v1\/claude_code\/routines\/\{id\}$/),
      method: 'GET',
    });
  });

  it('falls back to GET .../{id}/system_prompt (option b) when option (a) is 404', async () => {
    const fetchMock = makeFetchSequence(
      { status: 200, body: goodFireResponse },
      { status: 404, body: {} },
      { status: 200, body: { system_prompt: 'You are noop.' } },
    );
    const deps = makeDeps({ fetch: fetchMock });

    const outcome = await runSpike3(deps);

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[2]?.[0]).toMatch(/\/v1\/claude_code\/routines\/trig_test_noop\/system_prompt$/);
    expect(outcome.details.deployed_prompt_endpoint).toMatchObject({
      url_pattern: expect.stringMatching(/\/system_prompt$/),
    });
  });

  it('records deployed_prompt_endpoint=null when both options 404', async () => {
    const deps = makeDeps({
      fetch: makeFetchSequence(
        { status: 200, body: goodFireResponse },
        { status: 404, body: {} },
        { status: 404, body: {} },
      ),
    });

    const outcome = await runSpike3(deps);

    expect(outcome.details.deployed_prompt_endpoint).toBeNull();
    expect(outcome.notes).toMatch(/no read endpoint|tier 2 SKIP/i);
  });

  it('records deployed_prompt_endpoint=null when option (a) returns 200 but body lacks system_prompt', async () => {
    const deps = makeDeps({
      fetch: makeFetchSequence(
        { status: 200, body: goodFireResponse },
        { status: 200, body: { id: 'trig_test_noop' } }, // no system_prompt
        { status: 404, body: {} },
      ),
    });

    const outcome = await runSpike3(deps);

    expect(outcome.details.deployed_prompt_endpoint).toBeNull();
  });

  it('attaches Authorization Bearer header to the GET probes', async () => {
    const fetchMock = makeFetchSequence(
      { status: 200, body: goodFireResponse },
      { status: 200, body: { id: 'trig_test_noop', system_prompt: 'OK' } },
    );
    const deps = makeDeps({ fetch: fetchMock });
    await runSpike3(deps);

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const init = calls[1]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_BEARER_NOOP}`);
    expect(headers['anthropic-beta']).toBe('experimental-cc-routine-2026-04-01');
  });
});
