/**
 * NFR-008 — Timezone correctness with DST transition days.
 *
 * Constitution §5: every datetime stored / transmitted / displayed is GMT/UTC.
 * Local-time conversion only happens in the dashboard view layer.
 *
 * DST transition days in 2026:
 *   - March 30 (UTC offset shifts in some regions; GMT itself does NOT shift —
 *     this test verifies our helpers don't accidentally use a TZ-aware Date
 *     constructor and silently apply DST).
 *   - October 26 (same).
 *
 * The trading sessions ("EUR" 07:00-12:00 GMT, "NY" 12:00-17:00 GMT, "ASIA"
 * 22:00-04:00 GMT) are GMT-anchored. They MUST NOT shift on DST days.
 */

import { describe, expect, it } from 'vitest';
import {
  formatGmtTimestamp,
  isGmtSessionWindow,
  parseGmtIsoString,
  todayGmtIsoDate,
} from '../src/time';

describe('NFR-008 + Constitution §5: time helpers stay in GMT/UTC', () => {
  it('parseGmtIsoString returns a Date whose UTC components match the input', () => {
    const d = parseGmtIsoString('2026-05-03T12:00:00Z');
    expect(d.getUTCHours()).toBe(12);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(4); // May = 4 (zero-indexed)
    expect(d.getUTCDate()).toBe(3);
  });

  it('throws on a string that lacks the Z (UTC) suffix', () => {
    expect(() => parseGmtIsoString('2026-05-03T12:00:00')).toThrow(/UTC|Z|GMT/i);
  });

  it('formatGmtTimestamp emits ISO 8601 with Z suffix', () => {
    const d = new Date('2026-05-03T12:00:00Z');
    expect(formatGmtTimestamp(d)).toBe('2026-05-03T12:00:00.000Z');
  });

  it('todayGmtIsoDate returns YYYY-MM-DD in GMT (not local TZ)', () => {
    const d = new Date('2026-05-03T23:30:00Z');
    expect(todayGmtIsoDate(d)).toBe('2026-05-03');
  });

  it('todayGmtIsoDate handles late-night UTC correctly even when local TZ rolls to next day', () => {
    // 23:30 UTC on May 3 = 7:30 next-day-morning AEST. Helper must use UTC.
    const d = new Date('2026-05-03T23:30:00Z');
    const result = todayGmtIsoDate(d);
    expect(result).toBe('2026-05-03');
    expect(result).not.toBe('2026-05-04');
  });
});

describe('NFR-008: DST spring-forward (Mar 30, 2026 — fictional EU DST)', () => {
  it('GMT 02:00 on Mar 30, 2026 stays GMT 02:00 (no auto-shift)', () => {
    // EU DST springs forward at 01:00 UTC → 02:00 BST. We're stored in GMT,
    // so 02:00 UTC on Mar 30 is 02:00 UTC, not 03:00 BST. Anyone displaying
    // BST converts in the view layer.
    const d = parseGmtIsoString('2026-03-30T02:00:00Z');
    expect(d.getUTCHours()).toBe(2);
    expect(d.getUTCMonth()).toBe(2); // March = 2
    expect(d.getUTCDate()).toBe(30);
  });

  it('round-trip preserves UTC across DST boundary', () => {
    const original = '2026-03-30T02:30:00.000Z';
    const d = parseGmtIsoString(original);
    expect(formatGmtTimestamp(d)).toBe(original);
  });

  it('isGmtSessionWindow correctly identifies EUR session at 09:00 UTC on DST day', () => {
    // Trading session "EUR" = 07:00-12:00 GMT. Must include 09:00 GMT
    // regardless of whether local clocks have sprung forward.
    const d = parseGmtIsoString('2026-03-30T09:00:00Z');
    expect(isGmtSessionWindow(d, 'EUR')).toBe(true);
  });

  it('isGmtSessionWindow rejects 06:30 UTC for EUR session (before window)', () => {
    const d = parseGmtIsoString('2026-03-30T06:30:00Z');
    expect(isGmtSessionWindow(d, 'EUR')).toBe(false);
  });
});

describe('NFR-008: DST fall-back (Oct 26, 2026 — fictional EU DST)', () => {
  it('GMT 02:00 on Oct 26, 2026 stays GMT 02:00 (no auto-shift)', () => {
    const d = parseGmtIsoString('2026-10-26T02:00:00Z');
    expect(d.getUTCHours()).toBe(2);
    expect(d.getUTCMonth()).toBe(9); // October = 9
    expect(d.getUTCDate()).toBe(26);
  });

  it('NY session 14:00 UTC on Oct 26 still in window', () => {
    // NY session = 12:00-17:00 GMT. Operator may have local TZ swap on Oct 26
    // but the GMT anchor is unaffected.
    const d = parseGmtIsoString('2026-10-26T14:00:00Z');
    expect(isGmtSessionWindow(d, 'NY')).toBe(true);
  });
});

describe('isGmtSessionWindow: EUR/NY/ASIA windows', () => {
  it('EUR window: 07:00–12:00 GMT inclusive', () => {
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T07:00:00Z'), 'EUR')).toBe(true);
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T11:59:00Z'), 'EUR')).toBe(true);
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T12:00:00Z'), 'EUR')).toBe(false);
  });

  it('NY window: 12:00–17:00 GMT inclusive', () => {
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T12:00:00Z'), 'NY')).toBe(true);
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T16:59:00Z'), 'NY')).toBe(true);
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T17:00:00Z'), 'NY')).toBe(false);
  });

  it('ASIA window: 22:00–04:00 GMT (wraps midnight)', () => {
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T22:30:00Z'), 'ASIA')).toBe(true);
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T03:30:00Z'), 'ASIA')).toBe(true);
    expect(isGmtSessionWindow(parseGmtIsoString('2026-05-03T05:00:00Z'), 'ASIA')).toBe(false);
  });

  it('throws on unknown session name', () => {
    const d = new Date('2026-05-03T12:00:00Z');
    expect(() => (isGmtSessionWindow as (d: Date, s: string) => boolean)(d, 'SYDNEY')).toThrow(
      /session|unknown/i,
    );
  });
});
