/**
 * FR-001 AC-001-2 — Executor duration + math fidelity (combined per Q8).
 *
 * Per the contract (proposal Round 3 + Q8 answer):
 *   - PASS criteria: duration ≤ 12 min on 2 consecutive runs AND
 *                    max relative error vs Python reference < 1e-3
 *   - !duration ∧ math   → ADR-003 fallback (Sonnet 4.6 OR split-Executor)
 *   - duration ∧ !math   → FR-013 BUILDS (Vercel Sandbox compute_python)
 *   - !duration ∧ !math  → escalate
 *
 * The math-fidelity check is what gates FR-013 (skip vs build). Per the
 * contract: if max relative error < 1e-3, FR-013 is SKIPPED.
 *
 * This unit test exercises the verdict mapping. The live run depends on
 * Opus 4.7 1M API + a 958-bar OHLC fixture + ta-lib reference numbers.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSpike2, maxRelativeError } from '../../src/spike/ac-001-2-duration-and-math';

describe('Spike 2 (AC-001-2) — maxRelativeError helper', () => {
  it('returns 0 when arrays are equal', () => {
    expect(maxRelativeError([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('returns relative error correctly for small numbers', () => {
    // |10 - 9.99| / |9.99| ≈ 0.001001
    expect(maxRelativeError([10], [9.99])).toBeCloseTo(0.001001, 6);
  });

  it('returns the MAX relative error across pairs', () => {
    // pair 1: |1 - 1| / 1 = 0
    // pair 2: |2 - 2.1| / 2.1 ≈ 0.0476
    // pair 3: |3 - 3.001| / 3.001 ≈ 0.000333
    // → max = 0.0476
    expect(maxRelativeError([1, 2, 3], [1, 2.1, 3.001])).toBeCloseTo(0.0476, 4);
  });

  it('throws when arrays have different lengths', () => {
    expect(() => maxRelativeError([1, 2], [1, 2, 3])).toThrow(/length/i);
  });

  it('handles a Python-reference value of 0 by returning Infinity (caller must guard)', () => {
    // Symmetry: |x - 0| / |0| = ∞. Caller should never pass 0 as a reference;
    // we surface the impossible case loudly rather than swallow it.
    expect(maxRelativeError([1], [0])).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns 0 when both values are 0 (vacuously equal)', () => {
    expect(maxRelativeError([0, 0], [0, 0])).toBe(0);
  });
});

describe('Spike 2 (AC-001-2) — verdict mapping', () => {
  const min12 = 12 * 60 * 1000; // 12 minutes in ms

  it('PASS when both runs ≤ 12 min AND maxRelErr < 1e-3', () => {
    expect(
      evaluateSpike2({
        durations_ms: [min12 - 1000, min12 - 500],
        max_relative_error: 1e-4,
      }),
    ).toEqual({ status: 'PASS', duration_ok: true, math_ok: true, fr_013_skip: true });
  });

  it('PARTIAL → FR-013 BUILD when duration OK but math fails', () => {
    expect(
      evaluateSpike2({
        durations_ms: [min12 - 1000, min12 - 500],
        max_relative_error: 5e-3,
      }),
    ).toEqual({ status: 'PARTIAL', duration_ok: true, math_ok: false, fr_013_skip: false });
  });

  it('PARTIAL → ADR-003 fallback when duration fails but math OK', () => {
    expect(
      evaluateSpike2({
        durations_ms: [min12 + 1, min12 + 1000],
        max_relative_error: 1e-4,
      }),
    ).toEqual({ status: 'PARTIAL', duration_ok: false, math_ok: true, fr_013_skip: true });
  });

  it('FAIL → escalate when both fail', () => {
    expect(
      evaluateSpike2({
        durations_ms: [min12 + 1000, min12 + 2000],
        max_relative_error: 0.01,
      }),
    ).toEqual({ status: 'FAIL', duration_ok: false, math_ok: false, fr_013_skip: false });
  });

  it('PARTIAL → ADR-003 when ONE of the two runs exceeds 12 min', () => {
    // Per the spec: "≤ 12 min on 2 consecutive runs" — one over busts duration.
    expect(
      evaluateSpike2({
        durations_ms: [min12 - 5000, min12 + 5000],
        max_relative_error: 1e-4,
      }),
    ).toMatchObject({ duration_ok: false });
  });
});
