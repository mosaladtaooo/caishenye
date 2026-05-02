/**
 * FR-001 AC-001-4 — combined Routines + Channels token soak.
 *
 * Per the contract:
 *   PASS    = projected weekly cap ≤ 80%
 *   PARTIAL = 80–95%
 *   FAIL    = > 95%
 *
 * The spike measures over 24h: 14 Executor-shaped fires + 1 Planner +
 * 50 Telegram messages. Projected weekly = 24h delta × 7 × oversampling
 * adjustment 1/0.71 (since we packed 24h with peak load).
 *
 * This unit test covers the projection math + verdict mapping. Live soak
 * requires operator-supplied bearer tokens + 24h elapsed time.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSpike4, projectWeeklyPct } from '../../src/spike/ac-001-4-token-soak';

describe('Spike 4 (AC-001-4) — projectWeeklyPct', () => {
  it('projects 24h delta × 7 / 0.71 ≈ 9.86 × delta', () => {
    expect(projectWeeklyPct(0)).toBeCloseTo(0, 5);
    expect(projectWeeklyPct(1)).toBeCloseTo(7 / 0.71, 4);
    expect(projectWeeklyPct(5)).toBeCloseTo((5 * 7) / 0.71, 4);
  });

  it('handles negative delta by clamping to 0 (impossible for usage to decrease)', () => {
    expect(projectWeeklyPct(-1)).toBe(0);
  });
});

describe('Spike 4 (AC-001-4) — verdict mapping', () => {
  it('PASS when projected weekly ≤ 80%', () => {
    expect(evaluateSpike4({ pre_pct: 10, post_pct: 15 })).toMatchObject({
      status: 'PASS',
      projected_weekly_pct: expect.closeTo((5 * 7) / 0.71, 1),
    });
  });

  it('PARTIAL when projected weekly is 80–95%', () => {
    // delta of 9 → 9*7/0.71 ≈ 88.7
    expect(evaluateSpike4({ pre_pct: 10, post_pct: 19 })).toMatchObject({
      status: 'PARTIAL',
      projected_weekly_pct: expect.closeTo(88.7, 1),
    });
  });

  it('FAIL when projected weekly > 95%', () => {
    // delta of 10 → 10*7/0.71 ≈ 98.6
    expect(evaluateSpike4({ pre_pct: 10, post_pct: 20 })).toMatchObject({
      status: 'FAIL',
      projected_weekly_pct: expect.closeTo(98.6, 1),
    });
  });

  it('rounds the boundary case (delta = 8.114) to PASS-side via projection', () => {
    // 8.114 * 7 / 0.71 ≈ 79.99 → still PASS
    expect(evaluateSpike4({ pre_pct: 0, post_pct: 8.114 })).toMatchObject({
      status: 'PASS',
    });
  });
});
