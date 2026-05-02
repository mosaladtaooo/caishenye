/**
 * FR-001 AC-001-4 — combined Routines + Channels token soak.
 *
 * 24h soak with synthetic load:
 *   - 14 Executor-shaped fires (max daily Executor count from AC-012-3 math)
 *   - 1 daily Planner fire
 *   - 50 Telegram messages spaced through 24h
 *
 * Projection: weekly_pct = (post_pct - pre_pct) × 7 / 0.71
 *   The 0.71 oversampling adjustment accounts for packing 24h with peak load
 *   when a real day is ~71% of peak. Per the contract spec.
 *
 * Verdict:
 *   PASS    = projected ≤ 80%
 *   PARTIAL = 80–95%   → FR-021 hard-stop alert at 12/15 daily
 *   FAIL    = > 95%    → degrade Channels session to slash-only
 */

const OVERSAMPLING_ADJUST = 0.71;

export function projectWeeklyPct(deltaPct: number): number {
  if (deltaPct <= 0) return 0;
  return (deltaPct * 7) / OVERSAMPLING_ADJUST;
}

export interface Spike4Verdict {
  status: 'PASS' | 'PARTIAL' | 'FAIL';
  projected_weekly_pct: number;
}

export function evaluateSpike4(input: { pre_pct: number; post_pct: number }): Spike4Verdict {
  const delta = input.post_pct - input.pre_pct;
  const projected = projectWeeklyPct(delta);

  let status: Spike4Verdict['status'];
  if (projected <= 80) status = 'PASS';
  else if (projected <= 95) status = 'PARTIAL';
  else status = 'FAIL';

  return { status, projected_weekly_pct: projected };
}
