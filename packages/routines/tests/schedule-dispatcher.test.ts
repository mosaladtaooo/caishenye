/**
 * schedule-dispatcher — selects between `claude /schedule` Bash and `/fire` API
 * for scheduling per-pair Executor one-offs, based on Spike 1 outcome.
 *
 * If Spike 1 PASSED (one-offs are cap-exempt): use `claude /schedule` Bash.
 * If Spike 1 FAILED (cap-counted): fallback to `/fire` API at session-start time.
 *
 * The dispatcher reads .harness/data/spike-fr-001-outcomes.json; if the file
 * is missing or the spike1 outcome is PENDING, it errors loudly (refuses to
 * fire blind).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSchedule,
  type ScheduleDispatcherDeps,
  type ScheduleDispatchInput,
  selectScheduleStrategy,
} from '../src/schedule-dispatcher';

const PASSING_OUTCOMES = {
  spike1: {
    verdict: 'PASS' as const,
    evidence: 'one-offs run with x-anthropic-cc-routine-fire-kind=cap_exempt',
  },
  spike2: { verdict: 'PENDING' as const },
  spike3: { verdict: 'PENDING' as const },
  spike4: { verdict: 'PENDING' as const },
};

const FAILING_OUTCOMES = {
  spike1: {
    verdict: 'FAIL' as const,
    evidence: 'one-offs counted against the daily cap',
  },
  spike2: { verdict: 'PENDING' as const },
  spike3: { verdict: 'PENDING' as const },
  spike4: { verdict: 'PENDING' as const },
};

const PENDING_OUTCOMES = {
  spike1: { verdict: 'PENDING' as const },
  spike2: { verdict: 'PENDING' as const },
  spike3: { verdict: 'PENDING' as const },
  spike4: { verdict: 'PENDING' as const },
};

describe('schedule-dispatcher — selectScheduleStrategy', () => {
  it('returns "claude_schedule_bash" when spike1 PASSES (cap-exempt)', () => {
    const strategy = selectScheduleStrategy(PASSING_OUTCOMES);
    expect(strategy).toBe('claude_schedule_bash');
  });

  it('returns "fire_api" when spike1 FAILS (cap-counted)', () => {
    const strategy = selectScheduleStrategy(FAILING_OUTCOMES);
    expect(strategy).toBe('fire_api');
  });

  it('throws when spike1 is PENDING (refuses to fire blind)', () => {
    expect(() => selectScheduleStrategy(PENDING_OUTCOMES)).toThrow(/spike1.*pending/i);
  });
});

const SAMPLE_INPUT: ScheduleDispatchInput = {
  tenantId: 1,
  pairCode: 'EUR/USD',
  sessionName: 'EUR',
  fireAtIso: '2026-05-04T07:30:00.000Z',
  scheduledOneOffId: 'one-off-EUR-7-30',
};

describe('schedule-dispatcher — dispatchSchedule (claude_schedule_bash)', () => {
  it('invokes the bash command with the scheduled time when strategy is claude_schedule_bash', async () => {
    const runBashSpy = vi.fn<ScheduleDispatcherDeps['runBash']>(async () => ({
      exitCode: 0,
      stdout: 'scheduled',
      stderr: '',
    }));
    const fireApiSpy = vi.fn<ScheduleDispatcherDeps['fireApi']>();

    const deps: ScheduleDispatcherDeps = {
      runBash: runBashSpy,
      fireApi: fireApiSpy,
    };

    await dispatchSchedule(SAMPLE_INPUT, 'claude_schedule_bash', deps);

    expect(runBashSpy).toHaveBeenCalledTimes(1);
    expect(fireApiSpy).not.toHaveBeenCalled();
    const cmd = runBashSpy.mock.calls[0]?.[0];
    expect(cmd).toBeDefined();
    if (cmd === undefined) throw new Error('unreachable: cmd defined-guarded above');
    expect(cmd).toMatch(/claude.*\/schedule/);
    expect(cmd).toContain(SAMPLE_INPUT.fireAtIso);
    expect(cmd).toContain(SAMPLE_INPUT.pairCode);
  });

  it('throws when claude_schedule_bash exits non-zero', async () => {
    const deps: ScheduleDispatcherDeps = {
      runBash: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'schedule denied' })),
      fireApi: vi.fn(),
    };
    await expect(dispatchSchedule(SAMPLE_INPUT, 'claude_schedule_bash', deps)).rejects.toThrow(
      /schedule denied|exit/i,
    );
  });
});

describe('schedule-dispatcher — dispatchSchedule (fire_api)', () => {
  it('invokes /fire with the right shape when strategy is fire_api', async () => {
    const fireApiSpy = vi.fn<ScheduleDispatcherDeps['fireApi']>(async () => ({
      ok: true as const,
      anthropicOneOffId: 'one-off-XYZ',
    }));
    const runBashSpy = vi.fn<ScheduleDispatcherDeps['runBash']>();

    const deps: ScheduleDispatcherDeps = {
      runBash: runBashSpy,
      fireApi: fireApiSpy,
    };

    const result = await dispatchSchedule(SAMPLE_INPUT, 'fire_api', deps);

    expect(fireApiSpy).toHaveBeenCalledTimes(1);
    expect(runBashSpy).not.toHaveBeenCalled();
    const callArg = fireApiSpy.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    if (callArg === undefined) throw new Error('unreachable: callArg defined-guarded above');
    expect(callArg.pairCode).toBe('EUR/USD');
    expect(callArg.sessionName).toBe('EUR');
    expect(callArg.fireAtIso).toBe(SAMPLE_INPUT.fireAtIso);
    expect(result.dispatched).toBe(true);
    expect(result.anthropicOneOffId).toBe('one-off-XYZ');
  });

  it('throws when /fire returns ok=false', async () => {
    const deps: ScheduleDispatcherDeps = {
      runBash: vi.fn(),
      fireApi: vi.fn(async () => ({ ok: false as const, errorMessage: 'fire api 503' })),
    };
    await expect(dispatchSchedule(SAMPLE_INPUT, 'fire_api', deps)).rejects.toThrow(/fire api 503/);
  });
});

describe('schedule-dispatcher — FR-021 cap-burn instrumentation', () => {
  it('records executor_one_off_cap_exempt when strategy=claude_schedule_bash', async () => {
    const recordCapBurn = vi.fn<NonNullable<ScheduleDispatcherDeps['recordCapBurn']>>(
      async () => undefined,
    );
    const deps: ScheduleDispatcherDeps = {
      runBash: vi.fn(async () => ({ exitCode: 0, stdout: 'scheduled', stderr: '' })),
      fireApi: vi.fn(),
      recordCapBurn,
    };
    const result = await dispatchSchedule(SAMPLE_INPUT, 'claude_schedule_bash', deps);
    expect(result.capBurn).toBe('executor_one_off_cap_exempt');
    expect(recordCapBurn).toHaveBeenCalledTimes(1);
    expect(recordCapBurn.mock.calls[0]?.[0]).toBe('executor_one_off_cap_exempt');
  });

  it('records executor_one_off_cap_counted when strategy=fire_api', async () => {
    const recordCapBurn = vi.fn<NonNullable<ScheduleDispatcherDeps['recordCapBurn']>>(
      async () => undefined,
    );
    const deps: ScheduleDispatcherDeps = {
      runBash: vi.fn(),
      fireApi: vi.fn(async () => ({ ok: true as const, anthropicOneOffId: 'XYZ' })),
      recordCapBurn,
    };
    const result = await dispatchSchedule(SAMPLE_INPUT, 'fire_api', deps);
    expect(result.capBurn).toBe('executor_one_off_cap_counted');
    expect(recordCapBurn).toHaveBeenCalledTimes(1);
    expect(recordCapBurn.mock.calls[0]?.[0]).toBe('executor_one_off_cap_counted');
  });

  it('does NOT record cap burn when /fire fails (no slot consumed)', async () => {
    const recordCapBurn = vi.fn<NonNullable<ScheduleDispatcherDeps['recordCapBurn']>>(
      async () => undefined,
    );
    const deps: ScheduleDispatcherDeps = {
      runBash: vi.fn(),
      fireApi: vi.fn(async () => ({ ok: false as const, errorMessage: 'fire api 503' })),
      recordCapBurn,
    };
    await expect(dispatchSchedule(SAMPLE_INPUT, 'fire_api', deps)).rejects.toThrow();
    expect(recordCapBurn).not.toHaveBeenCalled();
  });

  it('still works when recordCapBurn is not provided (optional)', async () => {
    const deps: ScheduleDispatcherDeps = {
      runBash: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      fireApi: vi.fn(),
      // no recordCapBurn
    };
    const result = await dispatchSchedule(SAMPLE_INPUT, 'claude_schedule_bash', deps);
    expect(result.capBurn).toBe('executor_one_off_cap_exempt');
  });
});
