/**
 * FR-006 + FR-015 + FR-017 — dashboard read-side query helpers.
 *
 * RED phase tests for `queries/overview.ts`:
 *   - getAgentState: paused state + when
 *   - getTodaySchedule: today's pair_schedules with computed countdown
 *   - getRecentTrades: latest N orders for the dashboard timeline
 *   - getRecentReports: latest N executor_reports for an at-a-glance feed
 *   - getCapUsageProgress: today's cap row (used + limit) for the bar widget
 *
 * Constitution §4 + §12: every query is tenant-scoped via the TenantDb
 * client factory.
 */

import { describe, expect, it } from 'vitest';
import {
  buildScheduleEntries,
  type CapProgress,
  computeCapBarTier,
  formatCountdown,
  type RecentReport,
  type RecentTrade,
  type ScheduleEntry,
} from '../../src/queries/overview';

describe('formatCountdown — pure', () => {
  it('returns "now" when start <= now', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const start = new Date('2026-05-04T11:55:00Z');
    expect(formatCountdown(now, start)).toBe('now');
  });

  it('returns minutes when < 1h away', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const start = new Date('2026-05-04T12:05:00Z');
    expect(formatCountdown(now, start)).toBe('in 5m');
  });

  it('returns hours+minutes when >= 1h away', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const start = new Date('2026-05-04T14:30:00Z');
    expect(formatCountdown(now, start)).toBe('in 2h 30m');
  });

  it('returns hours when >= 1h and 0m', () => {
    const now = new Date('2026-05-04T12:00:00Z');
    const start = new Date('2026-05-04T15:00:00Z');
    expect(formatCountdown(now, start)).toBe('in 3h');
  });
});

describe('buildScheduleEntries — pure', () => {
  it('attaches countdowns to scheduled rows + handles skipped/cancelled', () => {
    const now = new Date('2026-05-04T08:00:00Z');
    const rows = [
      {
        id: 1,
        pairCode: 'EUR/USD',
        sessionName: 'EUR',
        startTimeGmt: new Date('2026-05-04T07:00:00Z'),
        endTimeGmt: new Date('2026-05-04T11:00:00Z'),
        status: 'scheduled' as const,
        scheduledOneOffId: 'one-off-1',
      },
      {
        id: 2,
        pairCode: 'GBP/USD',
        sessionName: 'NY',
        startTimeGmt: new Date('2026-05-04T13:00:00Z'),
        endTimeGmt: new Date('2026-05-04T17:00:00Z'),
        status: 'scheduled' as const,
        scheduledOneOffId: 'one-off-2',
      },
      {
        id: 3,
        pairCode: 'AUD/USD',
        sessionName: 'EUR',
        startTimeGmt: null,
        endTimeGmt: null,
        status: 'skipped_no_window' as const,
        scheduledOneOffId: null,
      },
    ];
    const entries: ScheduleEntry[] = buildScheduleEntries(rows, now);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.countdown).toBe('now'); // started 1h ago, in window
    expect(entries[1]?.countdown).toBe('in 5h');
    expect(entries[2]?.countdown).toBe('—');
    expect(entries[2]?.status).toBe('skipped_no_window');
  });

  it('counts cancelled rows with countdown=cancelled', () => {
    const now = new Date('2026-05-04T08:00:00Z');
    const rows = [
      {
        id: 1,
        pairCode: 'EUR/USD',
        sessionName: 'EUR',
        startTimeGmt: new Date('2026-05-04T07:00:00Z'),
        endTimeGmt: new Date('2026-05-04T11:00:00Z'),
        status: 'cancelled' as const,
        scheduledOneOffId: 'one-off-1',
      },
    ];
    const entries = buildScheduleEntries(rows, now);
    expect(entries[0]?.countdown).toBe('cancelled');
  });
});

describe('computeCapBarTier — pure', () => {
  it('green when daily_used <= 11 / 15', () => {
    const result: CapProgress = computeCapBarTier({ dailyUsed: 8, dailyLimit: 15 });
    expect(result.tier).toBe('green');
    expect(result.percent).toBe(53);
  });

  it('yellow when 12 <= used < 14', () => {
    expect(computeCapBarTier({ dailyUsed: 12, dailyLimit: 15 }).tier).toBe('yellow');
    expect(computeCapBarTier({ dailyUsed: 13, dailyLimit: 15 }).tier).toBe('yellow');
  });

  it('red when used >= 14', () => {
    expect(computeCapBarTier({ dailyUsed: 14, dailyLimit: 15 }).tier).toBe('red');
    expect(computeCapBarTier({ dailyUsed: 15, dailyLimit: 15 }).tier).toBe('red');
  });

  it('returns 0 percent when limit=0 (defensive)', () => {
    expect(computeCapBarTier({ dailyUsed: 5, dailyLimit: 0 }).percent).toBe(0);
  });

  it('clamps percent to 100 when used > limit', () => {
    const r = computeCapBarTier({ dailyUsed: 18, dailyLimit: 15 });
    expect(r.percent).toBe(100);
    expect(r.tier).toBe('red');
  });
});

describe('overview type re-exports', () => {
  it('exports RecentTrade + RecentReport types as nominal interfaces', () => {
    // Smoke: ensure the named exports resolve. If overview.ts is missing
    // any export, tsc fails at compile-time before this test runs.
    const rt: RecentTrade | undefined = undefined;
    const rr: RecentReport | undefined = undefined;
    expect(rt).toBeUndefined();
    expect(rr).toBeUndefined();
  });
});
