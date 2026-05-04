/**
 * Resolve a routine name to its (id, bearer) pair from env vars.
 *
 * Routine name "planner" → PLANNER_ROUTINE_ID + PLANNER_ROUTINE_BEARER.
 * Routine name "spike-noop" → SPIKE_NOOP_ROUTINE_ID + SPIKE_NOOP_ROUTINE_BEARER.
 * Routine name X (anything else) → EXECUTOR_ROUTINE_IDS["X" or "default"]
 *                                  + EXECUTOR_ROUTINE_BEARERS["X" or "default"].
 *
 * Used by both /api/internal/anthropic/fire and .../schedule. Throws on
 * missing env so callers can map to a 500 LOUD response.
 */

export interface ResolvedRoutine {
  id: string;
  bearer: string;
}

export function resolveRoutine(name: string): ResolvedRoutine {
  if (name === 'planner') {
    const id = process.env.PLANNER_ROUTINE_ID ?? '';
    const bearer = process.env.PLANNER_ROUTINE_BEARER ?? '';
    if (id.length === 0 || bearer.length === 0) {
      throw new Error('PLANNER_ROUTINE_ID or PLANNER_ROUTINE_BEARER missing in env');
    }
    return { id, bearer };
  }
  if (name === 'spike-noop') {
    const id = process.env.SPIKE_NOOP_ROUTINE_ID ?? '';
    const bearer = process.env.SPIKE_NOOP_ROUTINE_BEARER ?? '';
    if (id.length === 0 || bearer.length === 0) {
      throw new Error('SPIKE_NOOP_ROUTINE_ID or SPIKE_NOOP_ROUTINE_BEARER missing in env');
    }
    return { id, bearer };
  }
  // Executor map: try exact match first, fall back to "default".
  const idsRaw = process.env.EXECUTOR_ROUTINE_IDS ?? '{}';
  const bearersRaw = process.env.EXECUTOR_ROUTINE_BEARERS ?? '{}';
  let ids: Record<string, string>;
  let bearers: Record<string, string>;
  try {
    ids = JSON.parse(idsRaw) as Record<string, string>;
    bearers = JSON.parse(bearersRaw) as Record<string, string>;
  } catch {
    throw new Error('EXECUTOR_ROUTINE_IDS or EXECUTOR_ROUTINE_BEARERS not valid JSON in env');
  }
  const id = ids[name] ?? ids.default ?? '';
  const bearer = bearers[name] ?? bearers.default ?? '';
  if (id.length === 0 || bearer.length === 0) {
    throw new Error(
      `EXECUTOR_ROUTINE_IDS or EXECUTOR_ROUTINE_BEARERS missing entry for "${name}" (and no "default" fallback) in env`,
    );
  }
  return { id, bearer };
}

const KNOWN_ROUTINES = new Set(['planner', 'spike-noop', 'executor']);

/**
 * Validate the request body's routine name against the known set. We reject
 * unknown names at the route level to make the routine namespace explicit
 * and auditable; the executor map can be expanded by adding a new key to
 * the env JSON.
 */
export function isKnownRoutineName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (KNOWN_ROUTINES.has(name)) return true;
  // Per-pair executor names like "executor-XAUUSD" also pass — they resolve
  // via the executor map's key match.
  if (name.startsWith('executor-')) return true;
  return false;
}
