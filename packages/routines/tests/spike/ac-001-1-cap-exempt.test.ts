/**
 * FR-001 AC-001-1 — does `claude /schedule` from inside a routine count
 * against the daily cap?
 *
 * Per Anthropic docs (Context7 2026-05-03):
 *   "One-off routine runs are exempt from the daily routine cap. They consume
 *    regular subscription usage like any other session but do not count
 *    towards the per-account daily routine run allowance."
 *
 * The spike codifies the behavior verification:
 *   - PASS  = flag-file artefact created AND /usage delta = 0
 *   - PARTIAL = flag created AND /usage delta ≥ 1 (one-off counted; ADR-002 fallback (b))
 *   - FAIL    = flag NOT created (one-off didn't fire)
 *
 * Since the spike depends on filesystem + a 12-min wall clock + Anthropic
 * /usage API, this unit-level coverage exercises the OUTCOME-COMPUTATION logic
 * (input → verdict mapping) with mocked filesystem. The live run is operator-
 * gated (bearer tokens + Anthropic console access — see implementation report).
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluateSpike1, runSpike1, type Spike1Deps } from '../../src/spike/ac-001-1-cap-exempt';

function makeDeps(over: Partial<Spike1Deps> = {}): Spike1Deps {
  return {
    now: () => new Date('2026-05-03T12:00:00Z'),
    recordRoutineRun: vi.fn(async () => ({ id: 1 })),
    flagExists: vi.fn(async () => true),
    capUsageBefore: 5,
    capUsageAfter: 5,
    ...over,
  };
}

describe('Spike 1 (AC-001-1) — verdict computation', () => {
  it('PASS when flag exists AND cap delta = 0 (one-off cap-exempt)', () => {
    expect(evaluateSpike1({ flagExists: true, before: 7, after: 7 })).toEqual({
      status: 'PASS',
      delta: 0,
    });
  });

  it('PARTIAL when flag exists AND cap delta ≥ 1 (one-off counted)', () => {
    expect(evaluateSpike1({ flagExists: true, before: 7, after: 8 })).toEqual({
      status: 'PARTIAL',
      delta: 1,
    });
  });

  it('FAIL when flag does NOT exist (one-off never fired)', () => {
    expect(evaluateSpike1({ flagExists: false, before: 7, after: 7 })).toEqual({
      status: 'FAIL',
      delta: 0,
    });
    expect(evaluateSpike1({ flagExists: false, before: 7, after: 8 })).toEqual({
      status: 'FAIL',
      delta: 1,
    });
  });

  it('FAIL when before > after (impossible — usage cannot decrease intra-day)', () => {
    // Negative delta means the operator's data is wrong; flag this as ambiguous.
    expect(evaluateSpike1({ flagExists: true, before: 10, after: 7 })).toEqual({
      status: 'FAIL',
      delta: -3,
    });
  });
});

describe('Spike 1 (AC-001-1) — runSpike1', () => {
  it('records PASS in SpikeOutcome when cap-exempt verified', async () => {
    const deps = makeDeps({
      flagExists: vi.fn(async () => true),
      capUsageBefore: 5,
      capUsageAfter: 5,
    });
    const outcome = await runSpike1(deps);
    expect(outcome.status).toBe('PASS');
    expect(outcome.details).toMatchObject({ flag_exists: true, cap_delta: 0 });
  });

  it('records PARTIAL when one-off counted', async () => {
    const deps = makeDeps({ capUsageBefore: 5, capUsageAfter: 6 });
    const outcome = await runSpike1(deps);
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.details).toMatchObject({ flag_exists: true, cap_delta: 1 });
  });

  it('records FAIL when flag missing', async () => {
    const deps = makeDeps({ flagExists: vi.fn(async () => false) });
    const outcome = await runSpike1(deps);
    expect(outcome.status).toBe('FAIL');
  });

  it('writes audit row before any other check (constitution §3)', async () => {
    const recordRoutineRun = vi.fn(async () => ({ id: 1 }));
    const flagExists = vi.fn(async () => true);
    const deps = makeDeps({ recordRoutineRun, flagExists });
    await runSpike1(deps);
    const auditOrder = recordRoutineRun.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const flagOrder = flagExists.mock.invocationCallOrder[0] ?? -1;
    expect(auditOrder).toBeLessThan(flagOrder);
  });
});
