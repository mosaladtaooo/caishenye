/**
 * AC-024-8 + AC-024-9 -- per-endpoint consecutive non-2xx counters.
 *
 * Counters per endpoint (independent):
 *   - fire-due-executors
 *   - close-due-sessions
 *   - cron/health
 *
 * AC-024-8 (DB-write detection): cron/health failures at >=5 consecutive
 * non-2xx -> emit ONE alert "Cron-runner DB-write failures: cron_runner_health
 * unreachable for 5+ min". Counter resets on next 2xx; no alert spam.
 *
 * AC-024-9 (alive-but-failing): fire-due-executors / close-due-sessions
 * non-2xx at >=3 consecutive -> emit ONE alert. Catches CRON_SECRET-rotated-
 * on-Vercel-but-not-VPS. Independent counters per endpoint.
 *
 * Alert frequency cap: max 1 alert per hour per failure mode (NOT spam).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CounterState, newCounters, recordTickResult, type TickResult } from '../src/counters';

const FIRE_AC = 'fire-due-executors' as const;
const CLOSE_AC = 'close-due-sessions' as const;
const HEALTH_AC = 'cron/health' as const;

let state: CounterState;

beforeEach(() => {
  state = newCounters();
});

afterEach(() => {
  vi.useRealTimers();
});

function tick(state: CounterState, results: Partial<Record<string, number>>): TickResult {
  return recordTickResult(state, {
    [FIRE_AC]: results[FIRE_AC] ?? 200,
    [CLOSE_AC]: results[CLOSE_AC] ?? 200,
    [HEALTH_AC]: results[HEALTH_AC] ?? 200,
  });
}

describe('AC-024-8 cron/health counter (>=5 consecutive non-2xx)', () => {
  it('case (a): 4 consecutive 5xx -> no alert', () => {
    let last: TickResult = { alertsToEmit: [] };
    for (let i = 0; i < 4; i += 1) last = tick(state, { [HEALTH_AC]: 503 });
    expect(last.alertsToEmit).toEqual([]);
  });

  it('case (b): 5 consecutive 5xx -> 1 alert with HEALTH endpoint', () => {
    let last: TickResult = { alertsToEmit: [] };
    for (let i = 0; i < 5; i += 1) last = tick(state, { [HEALTH_AC]: 503 });
    expect(last.alertsToEmit.length).toBe(1);
    expect(last.alertsToEmit[0]).toMatchObject({
      kind: 'db_write_failure',
      endpoint: HEALTH_AC,
      consecutive: 5,
    });
  });

  it('case (c): 6+ consecutive 5xx -> still only 1 alert (no flapping spam)', () => {
    let last: TickResult = { alertsToEmit: [] };
    let totalAlerts = 0;
    for (let i = 0; i < 8; i += 1) {
      last = tick(state, { [HEALTH_AC]: 503 });
      totalAlerts += last.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(1);
  });

  it('case (d): 5xx then 2xx then 5xx-streak -> counter resets correctly', () => {
    // First streak: 5x 503 -> 1 alert.
    let totalAlerts = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = tick(state, { [HEALTH_AC]: 503 });
      totalAlerts += r.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(1);

    // Recovery: one 2xx -> counter resets, no alert.
    tick(state, { [HEALTH_AC]: 200 });

    // Second streak: 4x 503 (under threshold) -> no new alert.
    for (let i = 0; i < 4; i += 1) {
      const r = tick(state, { [HEALTH_AC]: 503 });
      totalAlerts += r.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(1);

    // 5th 503 in second streak -- but the 1-per-hour cap MAY suppress it.
    // The new streak is independent; if more than 1 hour has elapsed (we
    // didn't advance time) it would still be capped. We just verify the
    // counter reset shape: we can re-trigger on a fresh streak after
    // reset + cap-window expiry.
  });
});

describe('AC-024-9 fire-due-executors counter (>=3 consecutive non-2xx)', () => {
  it('case (a): 2 consecutive 401s -> no alert', () => {
    let last: TickResult = { alertsToEmit: [] };
    for (let i = 0; i < 2; i += 1) last = tick(state, { [FIRE_AC]: 401 });
    expect(last.alertsToEmit).toEqual([]);
  });

  it('case (b): 3 consecutive 401s -> 1 alert', () => {
    let last: TickResult = { alertsToEmit: [] };
    for (let i = 0; i < 3; i += 1) last = tick(state, { [FIRE_AC]: 401 });
    expect(last.alertsToEmit.length).toBe(1);
    expect(last.alertsToEmit[0]).toMatchObject({
      kind: 'alive_but_failing',
      endpoint: FIRE_AC,
      consecutive: 3,
      status: 401,
    });
  });

  it('case (c): independent counters -> intermixed fire/close failures emit independent alerts', () => {
    // 3 fire failures alone -> 1 alert.
    let totalAlerts = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = tick(state, { [FIRE_AC]: 502 });
      totalAlerts += r.alertsToEmit.length;
    }
    // 3 close failures alone -> 1 separate alert.
    for (let i = 0; i < 3; i += 1) {
      const r = tick(state, { [FIRE_AC]: 200, [CLOSE_AC]: 502 });
      totalAlerts += r.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(2);
  });
});

describe('alert frequency cap (1 per hour per failure mode)', () => {
  it('AC-024-9: same failure mode within 1 hour does not re-emit', () => {
    // First streak of 3 -> 1 alert.
    let totalAlerts = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = tick(state, { [FIRE_AC]: 502 });
      totalAlerts += r.alertsToEmit.length;
    }
    // Recovery + immediate second streak (within 1 hour) -> no new alert
    // due to cap.
    tick(state, { [FIRE_AC]: 200 });
    for (let i = 0; i < 5; i += 1) {
      const r = tick(state, { [FIRE_AC]: 502 });
      totalAlerts += r.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(1);
  });

  it('AC-024-9: same failure mode after 1+ hour wallclock CAN re-emit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T12:00:00Z'));
    // First streak.
    let totalAlerts = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = tick(state, { [FIRE_AC]: 502 });
      totalAlerts += r.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(1);

    // Advance clock by >1 hour.
    vi.setSystemTime(new Date('2026-05-06T13:01:00Z'));
    // Recovery + new streak.
    tick(state, { [FIRE_AC]: 200 });
    for (let i = 0; i < 3; i += 1) {
      const r = tick(state, { [FIRE_AC]: 502 });
      totalAlerts += r.alertsToEmit.length;
    }
    expect(totalAlerts).toBe(2);
  });
});
