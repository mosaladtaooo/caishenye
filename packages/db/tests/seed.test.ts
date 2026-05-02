/**
 * FR-012 — V1 pair list seed.
 *
 * AC-012-1: 7 specific pairs seeded.
 * AC-012-2: GBP/JPY explicitly NOT seeded.
 * AC-012-3: Per-day fire count math derived from this seed.
 * AC-003-3: XAU/USD's mt5_symbol = "XAUUSD" exactly (not XAUUSDF).
 */

import { describe, expect, it } from 'vitest';
import { V1_PAIR_SEED } from '../src/seed';

describe('FR-012 AC-012-1: V1_PAIR_SEED contains exactly the 7 contracted pairs', () => {
  it('seed has exactly 7 entries', () => {
    expect(V1_PAIR_SEED).toHaveLength(7);
  });

  it.each([
    ['EUR/USD', 'EURUSD'],
    ['EUR/JPY', 'EURJPY'],
    ['EUR/GBP', 'EURGBP'],
    ['USD/JPY', 'USDJPY'],
    ['GBP/USD', 'GBPUSD'],
    ['USD/CAD', 'USDCAD'],
    ['XAU/USD', 'XAUUSD'],
  ])('contains %s with mt5_symbol %s', (pairCode, mt5Symbol) => {
    const row = V1_PAIR_SEED.find((p) => p.pairCode === pairCode);
    expect(row).toBeDefined();
    expect(row?.mt5Symbol).toBe(mt5Symbol);
  });
});

describe('FR-012 AC-012-2: GBP/JPY is NOT seeded', () => {
  it('does not contain GBP/JPY', () => {
    expect(V1_PAIR_SEED.find((p) => p.pairCode === 'GBP/JPY')).toBeUndefined();
  });
  it('does not contain GBPJPY mt5_symbol either', () => {
    expect(V1_PAIR_SEED.find((p) => p.mt5Symbol === 'GBPJPY')).toBeUndefined();
  });
});

describe('FR-003 AC-003-3: XAU/USD mt5_symbol is exactly "XAUUSD" (NOT XAUUSDF)', () => {
  it('XAU/USD row uses XAUUSD', () => {
    const xau = V1_PAIR_SEED.find((p) => p.pairCode === 'XAU/USD');
    expect(xau).toBeDefined();
    expect(xau?.mt5Symbol).toBe('XAUUSD');
    // Hard test — the substring assertion would pass for XAUUSDF too.
    // We assert exact equality.
    expect(xau?.mt5Symbol === 'XAUUSDF').toBe(false);
  });
});

describe('FR-012 AC-012-1: session schedules', () => {
  it('USD/CAD has only NY session', () => {
    const row = V1_PAIR_SEED.find((p) => p.pairCode === 'USD/CAD');
    expect(row?.sessionsJson).toEqual(['NY']);
  });

  it('Most pairs have both EUR + NY sessions', () => {
    const both = V1_PAIR_SEED.filter(
      (p) => p.sessionsJson.includes('EUR') && p.sessionsJson.includes('NY'),
    );
    // EUR/USD, EUR/JPY, EUR/GBP, USD/JPY, GBP/USD, XAU/USD = 6 pairs
    expect(both).toHaveLength(6);
  });
});

describe('FR-012 AC-012-3: per-day fire count math (cap-budget validation)', () => {
  it('total session count across all pairs = 13 (allowing 1 buffer slot)', () => {
    const totalSessions = V1_PAIR_SEED.reduce((sum, p) => sum + p.sessionsJson.length, 0);
    // 6 pairs × 2 sessions = 12, plus USD/CAD × 1 = 13 total Executor fires per day max.
    // Plus 1 Planner fire = 14, leaving 1 buffer in the daily 15 cap.
    expect(totalSessions).toBe(13);
  });
});
