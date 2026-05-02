/**
 * FR-001 AC-001-2 — Executor duration + math fidelity (combined per Q8).
 *
 * Verdict mapping:
 *   PASS  = ALL durations ≤ 12 min AND maxRelErr < 1e-3 → FR-013 SKIPPED
 *   PARTIAL = duration OK, math fails    → FR-013 BUILDS
 *   PARTIAL = duration fails, math OK    → ADR-003 fallback (Sonnet/split)
 *   FAIL    = both fail                   → escalate
 *
 * The math-fidelity gate (1e-3) is the FR-013 SKIP/BUILD trigger per the
 * contract's clarify Q8 answer.
 */

const TWELVE_MIN_MS = 12 * 60 * 1000;
const MATH_THRESHOLD = 1e-3;

/**
 * Compute the maximum relative error between two parallel arrays of numbers.
 * |a[i] - b[i]| / |b[i]| for each i; returns max.
 *
 * If b[i] = 0 and a[i] != 0, returns Infinity (caller must guard — there is
 * no sensible relative error against a zero reference).
 *
 * If both a[i] and b[i] are 0, that pair contributes 0.
 */
export function maxRelativeError(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`maxRelativeError: array length mismatch (${a.length} vs ${b.length})`);
  }
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av === 0 && bv === 0) continue;
    if (bv === 0) return Number.POSITIVE_INFINITY;
    const rel = Math.abs(av - bv) / Math.abs(bv);
    if (rel > max) max = rel;
  }
  return max;
}

export interface Spike2Verdict {
  status: 'PASS' | 'PARTIAL' | 'FAIL';
  duration_ok: boolean;
  math_ok: boolean;
  /** True iff FR-013 (compute_python MCP) should be SKIPPED in v1. */
  fr_013_skip: boolean;
}

export function evaluateSpike2(input: {
  durations_ms: readonly number[];
  max_relative_error: number;
}): Spike2Verdict {
  const duration_ok = input.durations_ms.every((d) => d <= TWELVE_MIN_MS);
  const math_ok = input.max_relative_error < MATH_THRESHOLD;
  const fr_013_skip = math_ok; // FR-013 only builds if math fails

  let status: Spike2Verdict['status'];
  if (duration_ok && math_ok) status = 'PASS';
  else if (!duration_ok && !math_ok) status = 'FAIL';
  else status = 'PARTIAL';

  return { status, duration_ok, math_ok, fr_013_skip };
}
