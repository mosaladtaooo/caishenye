/**
 * FR-021 cap counter — RED.
 *
 * Two compute primitives, both pure:
 *
 *   - rollupDaily: takes cap_usage_local rows + a date → daily_used count;
 *     used by the cap-rollup cron AND by getCapRemainingSlots.
 *   - tierFromUsage: maps daily_used to alert tier 'green'/'warning'/'hard'
 *     (per AC-021-3: 12/15 warning, 14/15 hard).
 *
 * Plus an async DB writer:
 *   - insertCapUsageLocal: writes one cap_usage_local row per cap-burn event.
 *     Tested separately via integration suite; here we test the pure helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  type CapUsageLocalRow,
  rollupDailyTotal,
  tierFromUsage,
} from '../../src/queries/cap-counter';

describe('rollupDailyTotal — pure', () => {
  it('counts only rows on the given date (inclusive)', () => {
    const rows: CapUsageLocalRow[] = [
      { id: 1, at: new Date('2026-05-04T05:00:00Z'), capKind: 'planner_recurring' },
      { id: 2, at: new Date('2026-05-04T08:00:00Z'), capKind: 'executor_one_off_cap_counted' },
      { id: 3, at: new Date('2026-05-03T23:00:00Z'), capKind: 'planner_recurring' }, // prior day
      { id: 4, at: new Date('2026-05-05T01:00:00Z'), capKind: 'planner_recurring' }, // next day
    ];
    expect(rollupDailyTotal(rows, '2026-05-04')).toBe(2);
  });

  it('returns 0 when no rows match', () => {
    expect(rollupDailyTotal([], '2026-05-04')).toBe(0);
  });

  it('counts cap-exempt one-offs as 0 cap usage (Spike 1 PASS path)', () => {
    const rows: CapUsageLocalRow[] = [
      { id: 1, at: new Date('2026-05-04T05:00:00Z'), capKind: 'executor_one_off_cap_exempt' },
      { id: 2, at: new Date('2026-05-04T08:00:00Z'), capKind: 'executor_one_off_cap_exempt' },
    ];
    expect(rollupDailyTotal(rows, '2026-05-04')).toBe(0);
  });

  it('counts cap_status_cron rows (cron itself burns a slot per ADR-008)', () => {
    const rows: CapUsageLocalRow[] = [
      { id: 1, at: new Date('2026-05-04T12:00:00Z'), capKind: 'cap_status_cron' },
      { id: 2, at: new Date('2026-05-04T05:00:00Z'), capKind: 'planner_recurring' },
    ];
    expect(rollupDailyTotal(rows, '2026-05-04')).toBe(2);
  });

  it('counts replan_fire rows', () => {
    const rows: CapUsageLocalRow[] = [
      { id: 1, at: new Date('2026-05-04T07:00:00Z'), capKind: 'replan_fire' },
    ];
    expect(rollupDailyTotal(rows, '2026-05-04')).toBe(1);
  });
});

describe('tierFromUsage — pure', () => {
  it('green when used < 12', () => {
    expect(tierFromUsage(0).tier).toBe('green');
    expect(tierFromUsage(8).tier).toBe('green');
    expect(tierFromUsage(11).tier).toBe('green');
  });

  it('warning at 12 and 13', () => {
    expect(tierFromUsage(12).tier).toBe('warning');
    expect(tierFromUsage(13).tier).toBe('warning');
  });

  it('hard at 14, 15, and beyond', () => {
    expect(tierFromUsage(14).tier).toBe('hard');
    expect(tierFromUsage(15).tier).toBe('hard');
    expect(tierFromUsage(20).tier).toBe('hard');
  });

  it('returns alertText only at warning + hard', () => {
    expect(tierFromUsage(11).alertText).toBeNull();
    expect(tierFromUsage(12).alertText).toMatch(/cap warning|12 \/ 15/);
    expect(tierFromUsage(14).alertText).toMatch(/cap hard|14 \/ 15/);
  });

  it('exposes shouldAlertOnTransition flag (true at exactly 12 or 14)', () => {
    expect(tierFromUsage(12).shouldAlertOnTransition).toBe(true);
    expect(tierFromUsage(13).shouldAlertOnTransition).toBe(false);
    expect(tierFromUsage(14).shouldAlertOnTransition).toBe(true);
    expect(tierFromUsage(15).shouldAlertOnTransition).toBe(false);
  });
});
