/**
 * FR-001 — Architecture-spike verification of LOAD-BEARING ASSUMPTIONS
 *
 * Shared types for the four spike modules. Each spike returns a
 * `SpikeOutcome` which the runner aggregates into
 * `.harness/data/spike-fr-001-outcomes.json` (committed) and into
 * `docs/spike-report-fr-001.md` (committed).
 */

/**
 * A single spike's verdict. The outcomes JSON is the source of truth that
 * downstream tests read (e.g., Tier 2 prompt-preserve in AC-002-1-b).
 */
export type SpikeStatus = 'PENDING' | 'PASS' | 'PARTIAL' | 'FAIL';

export type SpikeId = 'AC-001-1' | 'AC-001-2' | 'AC-001-3' | 'AC-001-4';

export interface SpikeOutcome {
  /** Stable identifier — lines up with the AC ID in the contract. */
  id: SpikeId;
  /** Human-readable name. */
  name: string;
  /** PENDING until the live run completes; then PASS / PARTIAL / FAIL. */
  status: SpikeStatus;
  /** ISO timestamp when this outcome was recorded. */
  recorded_at: string | null;
  /** Free-form numeric / structural details specific to the spike. */
  details: Record<string, unknown>;
  /** Human notes — what we observed, fallback chosen, ADR updates. */
  notes: string;
}

/**
 * The shape of `.harness/data/spike-fr-001-outcomes.json`.
 *
 * `deployed_prompt_endpoint` is the cross-cutting field driving Tier 2
 * prompt-preservation (AC-002-1-b / AC-003-1-b — proposal R1):
 *   - null         → no GET endpoint found; Tier 2 test SKIPS in CI;
 *                    operator pre-deploy checklist covers it manually.
 *   - { url, ... } → endpoint discovered; Tier 2 test runs in CI.
 */
export interface SpikeOutcomesFile {
  feature: '001-foundation-routines-channels-dashboard';
  spec_version: 1;
  recorded_at: string | null;
  spikes: {
    'AC-001-1': SpikeOutcome;
    'AC-001-2': SpikeOutcome;
    'AC-001-3': SpikeOutcome;
    'AC-001-4': SpikeOutcome;
  };
  /** Set by Spike 3 step 6 (R1 driver). */
  deployed_prompt_endpoint: {
    url_pattern: string;
    method: 'GET';
    bearer_env_var: string;
  } | null;
  /** Set by Spike 4 step 6 (ADR-008 driver). */
  v1_usage_endpoint_available: boolean | null;
}

/**
 * Dependencies any spike module accepts via injection — keeps the actual
 * `runSpikeN` functions testable by stubbing fetch + clock + audit writer.
 */
export interface SpikeDeps {
  fetch: typeof fetch;
  now: () => Date;
  /** Audit-row writer; throws on insert failure per constitution §3. */
  recordRoutineRun: (row: {
    routine_name: string;
    started_at: Date;
    ended_at: Date | null;
    status: 'running' | 'completed' | 'failed' | 'degraded';
    failure_reason?: string;
    output_json?: unknown;
  }) => Promise<{ id: number }>;
  /** Bearer token + URL pulled from env (validated by runner before calling). */
  env: SpikeEnv;
}

export interface SpikeEnv {
  PLANNER_ROUTINE_ID: string;
  PLANNER_ROUTINE_BEARER: string;
  SPIKE_NOOP_ROUTINE_ID: string;
  SPIKE_NOOP_ROUTINE_BEARER: string;
  ROUTINE_BETA_HEADER: string;
}

/**
 * Anthropic /fire response shape (per
 * https://code.claude.com/docs/en/routines).
 */
export interface FireApiResponse {
  type: 'routine_fire';
  claude_code_session_id: string;
  claude_code_session_url: string;
}
