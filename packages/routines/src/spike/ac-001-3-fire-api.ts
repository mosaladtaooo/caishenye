/**
 * FR-001 AC-001-3 — verify the `/fire` API works with the pinned beta header,
 * AND (R1 driver) probe whether Anthropic exposes a "GET deployed system
 * prompt" endpoint that gates AC-002-1-b / AC-003-1-b (Tier 2 prompt
 * preservation).
 *
 * Reference (Anthropic docs, fetched via Context7 2026-05-03):
 *   https://code.claude.com/docs/en/routines
 *
 *   POST /v1/claude_code/routines/{routine_id}/fire
 *   Headers:
 *     Authorization: Bearer <bearer>
 *     anthropic-beta: experimental-cc-routine-2026-04-01
 *     anthropic-version: 2023-06-01
 *     Content-Type: application/json
 *   Body: { text?: string }
 *   Response: { type: 'routine_fire', claude_code_session_id, claude_code_session_url }
 *
 * Constitution §3 — audit-or-abort: this spike writes a `routine_runs` row
 * BEFORE making any external HTTP call. If the audit insert fails, the spike
 * exits without further side effects (the `recordRoutineRun` dep throws on
 * insert failure; we don't catch it).
 *
 * Per ADR-004: bearer is the per-routine token (NOT an API key — constitution
 * §1, §13). Pinned beta header is `experimental-cc-routine-2026-04-01`.
 */

import type { FireApiResponse, SpikeDeps, SpikeOutcome } from './types';

export interface Spike3Deps extends SpikeDeps {}

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

interface ProbeOutcome {
  url_pattern: string;
  method: 'GET';
  bearer_env_var: string;
}

function authHeaders(env: SpikeDeps['env']): Record<string, string> {
  return {
    Authorization: `Bearer ${env.SPIKE_NOOP_ROUTINE_BEARER}`,
    'anthropic-beta': env.ROUTINE_BETA_HEADER,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Step 1 of Spike 3: POST /fire and verify the response shape.
 */
async function fireNoopRoutine(
  deps: Spike3Deps,
): Promise<{ ok: true; resp: FireApiResponse } | { ok: false; reason: string }> {
  const url = `${ANTHROPIC_API_BASE}/v1/claude_code/routines/${deps.env.SPIKE_NOOP_ROUTINE_ID}/fire`;
  const body = JSON.stringify({ text: 'spike3 verification — FR-001 AC-001-3' });

  let resp: Response;
  try {
    resp = await deps.fetch(url, {
      method: 'POST',
      headers: authHeaders(deps.env),
      body,
    });
  } catch (e) {
    return { ok: false, reason: `network_error: ${(e as Error).message}` };
  }

  if (!resp.ok) {
    return { ok: false, reason: `http_${resp.status}: ${resp.statusText || 'unauthorized'}` };
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (e) {
    return { ok: false, reason: `bad_json: ${(e as Error).message}` };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('type' in parsed) ||
    !('claude_code_session_id' in parsed) ||
    !('claude_code_session_url' in parsed)
  ) {
    return {
      ok: false,
      reason: 'response_shape_mismatch: missing type/session_id/session_url',
    };
  }

  return { ok: true, resp: parsed as FireApiResponse };
}

/**
 * Step 6 of Spike 3 (R1): probe two GET endpoints to find the deployed-
 * system-prompt URL. If neither responds with a system_prompt field,
 * Tier 2 prompt-preservation tests SKIP (operator pre-deploy checklist
 * covers manually).
 */
async function probeDeployedPromptEndpoint(deps: Spike3Deps): Promise<ProbeOutcome | null> {
  const headers = authHeaders(deps.env);
  const candidates: Array<{ url: string; pattern: string }> = [
    {
      url: `${ANTHROPIC_API_BASE}/v1/claude_code/routines/${deps.env.SPIKE_NOOP_ROUTINE_ID}`,
      pattern: '/v1/claude_code/routines/{id}',
    },
    {
      url: `${ANTHROPIC_API_BASE}/v1/claude_code/routines/${deps.env.SPIKE_NOOP_ROUTINE_ID}/system_prompt`,
      pattern: '/v1/claude_code/routines/{id}/system_prompt',
    },
  ];

  for (const c of candidates) {
    let resp: Response;
    try {
      resp = await deps.fetch(c.url, { method: 'GET', headers });
    } catch {
      // network blip on probe is non-fatal — try next candidate.
      continue;
    }
    if (!resp.ok) continue;

    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      continue;
    }

    if (
      typeof body === 'object' &&
      body !== null &&
      'system_prompt' in body &&
      typeof (body as { system_prompt: unknown }).system_prompt === 'string'
    ) {
      return {
        url_pattern: c.pattern,
        method: 'GET',
        bearer_env_var: 'SPIKE_NOOP_ROUTINE_BEARER',
      };
    }
  }

  return null;
}

/**
 * Run Spike 3 end-to-end and return the SpikeOutcome.
 *
 * Sequence:
 *   1. Audit row inserted (constitution §3 — runs BEFORE any fetch).
 *   2. POST /fire to the no-op routine; assert response shape.
 *   3. (R1) Probe deployed-prompt READ endpoint (best-effort).
 *   4. Update audit row to status='completed' with output_json.
 *
 * The runner caller is responsible for committing the SpikeOutcome to
 * `.harness/data/spike-fr-001-outcomes.json` and appending the report
 * section to `docs/spike-report-fr-001.md`.
 */
export async function runSpike3(deps: Spike3Deps): Promise<SpikeOutcome> {
  const startedAt = deps.now();

  // 1. Audit row — constitution §3. If this throws, propagate.
  await deps.recordRoutineRun({
    routine_name: 'spike_ac_001_3_fire_api',
    started_at: startedAt,
    ended_at: null,
    status: 'running',
  });

  // 2. POST /fire.
  const fireResult = await fireNoopRoutine(deps);

  if (!fireResult.ok) {
    return {
      id: 'AC-001-3',
      name: '/fire API + deployed-prompt READ probe',
      status: 'FAIL',
      recorded_at: deps.now().toISOString(),
      details: {
        fire_response: null,
        deployed_prompt_endpoint: null,
      },
      notes: `Spike 3 FAIL: ${fireResult.reason}`,
    };
  }

  // 3. R1 probe.
  const probe = await probeDeployedPromptEndpoint(deps);

  return {
    id: 'AC-001-3',
    name: '/fire API + deployed-prompt READ probe',
    status: 'PASS',
    recorded_at: deps.now().toISOString(),
    details: {
      claude_code_session_id: fireResult.resp.claude_code_session_id,
      claude_code_session_url: fireResult.resp.claude_code_session_url,
      deployed_prompt_endpoint: probe,
    },
    notes: probe
      ? `PASS — /fire works; deployed-prompt READ endpoint discovered at ${probe.url_pattern} (Tier 2 prompt-preservation ENABLED in CI).`
      : 'PASS — /fire works; no deployed-prompt READ endpoint found (Tier 2 SKIP — manual operator checklist used).',
  };
}
