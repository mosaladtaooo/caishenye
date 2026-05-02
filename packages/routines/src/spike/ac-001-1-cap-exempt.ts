/**
 * FR-001 AC-001-1 — does `claude /schedule` from inside a routine count
 * against the daily cap?
 *
 * Per Anthropic docs (Context7 2026-05-03):
 *   "One-off routine runs are exempt from the daily routine cap. They consume
 *    regular subscription usage like any other session but do not count
 *    towards the per-account daily routine run allowance."
 *
 * Verdict mapping (per contract):
 *   PASS    = flag exists AND cap delta = 0
 *   PARTIAL = flag exists AND cap delta ≥ 1 (one-off counted; ADR-002 fallback)
 *   FAIL    = flag missing (one-off didn't fire)
 */

import type { SpikeOutcome } from './types';

export interface Spike1Deps {
  now: () => Date;
  recordRoutineRun: (row: {
    routine_name: string;
    started_at: Date;
    ended_at: Date | null;
    status: 'running' | 'completed' | 'failed' | 'degraded';
  }) => Promise<{ id: number }>;
  flagExists: () => Promise<boolean>;
  capUsageBefore: number;
  capUsageAfter: number;
}

export interface Spike1Verdict {
  status: 'PASS' | 'PARTIAL' | 'FAIL';
  delta: number;
}

export function evaluateSpike1(input: {
  flagExists: boolean;
  before: number;
  after: number;
}): Spike1Verdict {
  const delta = input.after - input.before;
  if (!input.flagExists) return { status: 'FAIL', delta };
  if (delta < 0) return { status: 'FAIL', delta };
  if (delta === 0) return { status: 'PASS', delta };
  return { status: 'PARTIAL', delta };
}

export async function runSpike1(deps: Spike1Deps): Promise<SpikeOutcome> {
  const startedAt = deps.now();

  // Constitution §3 — audit-or-abort.
  await deps.recordRoutineRun({
    routine_name: 'spike_ac_001_1_cap_exempt',
    started_at: startedAt,
    ended_at: null,
    status: 'running',
  });

  const flagExists = await deps.flagExists();
  const verdict = evaluateSpike1({
    flagExists,
    before: deps.capUsageBefore,
    after: deps.capUsageAfter,
  });

  return {
    id: 'AC-001-1',
    name: 'Cap-exempt one-off scheduling',
    status: verdict.status,
    recorded_at: deps.now().toISOString(),
    details: {
      flag_exists: flagExists,
      cap_usage_before: deps.capUsageBefore,
      cap_usage_after: deps.capUsageAfter,
      cap_delta: verdict.delta,
    },
    notes:
      verdict.status === 'PASS'
        ? 'PASS — flag exists, cap delta = 0. One-off cap-exempt confirmed; ADR-002 default path (a) holds.'
        : verdict.status === 'PARTIAL'
          ? `PARTIAL — flag exists, cap delta = ${verdict.delta}. One-off counted; switch ADR-002 to fallback (b) /fire-API path.`
          : `FAIL — flag missing (delta ${verdict.delta}). One-off did not fire; ADR-002 must be re-evaluated.`,
  };
}
