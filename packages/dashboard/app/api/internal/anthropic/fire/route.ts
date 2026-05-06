/**
 * POST /api/internal/anthropic/fire — fire an Anthropic Routine.
 *
 * Body: { routine: "planner"|"executor"|"spike-noop"|"executor-XYZ", body? }
 *
 * Resolves the routine to (id, bearer) via lib/anthropic-routine-resolve,
 * then POSTs to /v1/routines/${id}/fire with the experimental beta header.
 * Returns the upstream's one_off_id.
 */

import { isKnownRoutineName, resolveRoutine } from '@/lib/anthropic-routine-resolve';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const FIRE_TIMEOUT_MS = 30_000;

interface FireBody {
  routine: string;
  body?: unknown;
}

function validateBody(raw: unknown): FireBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isKnownRoutineName(r.routine)) return null;
  const out: FireBody = { routine: r.routine };
  if (r.body !== undefined) out.body = r.body;
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRes(400, { error: 'invalid JSON body' });
  }
  const body = validateBody(raw);
  if (!body) {
    return jsonRes(400, {
      error: 'invalid body: require { routine: planner|executor|spike-noop|executor-XYZ }',
    });
  }

  let resolved: { id: string; bearer: string };
  try {
    resolved = resolveRoutine(body.routine);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `anthropic/fire: server misconfigured (${msg})` });
  }

  const baseUrl = process.env.ANTHROPIC_ROUTINES_BASE_URL ?? 'https://api.anthropic.com';
  const beta = process.env.ROUTINE_BETA_HEADER ?? 'experimental-cc-routine-2026-04-01';
  // Per docs.code.claude.com/routines (verified 2026-05-05), canonical fire
  // path is /v1/claude_code/routines/{id}/fire. The legacy /v1/routines/{id}/fire
  // path returned 200 in earlier sessions but now returns 404 — either deprecated
  // or never officially supported. The cron route at /api/cron/fire-due-executors
  // already uses the canonical path.
  const url = `${baseUrl.replace(/\/$/, '')}/v1/claude_code/routines/${resolved.id}/fire`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${resolved.bearer}`,
        'anthropic-beta': beta,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body.body ?? {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return jsonRes(502, {
        error: `anthropic/fire: upstream ${res.status}: ${text.slice(0, 256)}`,
      });
    }
    const json = (await res.json()) as { one_off_id?: unknown; session_id?: unknown };
    if (typeof json.one_off_id !== 'string' || json.one_off_id.length === 0) {
      return jsonRes(502, { error: 'anthropic/fire: upstream response missing one_off_id' });
    }
    return jsonRes(200, {
      ok: true,
      anthropicOneOffId: json.one_off_id,
      claudeCodeSessionId: typeof json.session_id === 'string' ? json.session_id : null,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(502, { error: `anthropic/fire: ${msg.slice(0, 256)}` });
  }
}
