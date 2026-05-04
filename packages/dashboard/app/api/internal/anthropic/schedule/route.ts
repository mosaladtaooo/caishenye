/**
 * POST /api/internal/anthropic/schedule — schedule a Routine one-off.
 *
 * Body: { routine, fire_at_iso, body? }. Same routine-resolver as fire route.
 * Calls /v1/routines/${id}/schedule with { fire_at, body? } payload.
 */

import { isKnownRoutineName, resolveRoutine } from '@/lib/anthropic-routine-resolve';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const SCHEDULE_TIMEOUT_MS = 30_000;
// Strict ISO-8601 UTC pattern; YYYY-MM-DDTHH:MM:SS(.sss)?Z (constitution §5).
const ISO_GMT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

interface ScheduleBody {
  routine: string;
  fire_at_iso: string;
  body?: unknown;
}

function validateBody(raw: unknown): ScheduleBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isKnownRoutineName(r.routine)) return null;
  if (typeof r.fire_at_iso !== 'string' || !ISO_GMT_PATTERN.test(r.fire_at_iso)) return null;
  // Defensive: also reject ISO that fails Date parsing (e.g., 2026-13-99).
  if (Number.isNaN(Date.parse(r.fire_at_iso))) return null;
  const out: ScheduleBody = { routine: r.routine, fire_at_iso: r.fire_at_iso };
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
      error: 'invalid body: require { routine, fire_at_iso (YYYY-MM-DDTHH:MM:SSZ), body? }',
    });
  }

  let resolved: { id: string; bearer: string };
  try {
    resolved = resolveRoutine(body.routine);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `anthropic/schedule: server misconfigured (${msg})` });
  }

  const baseUrl = process.env.ANTHROPIC_ROUTINES_BASE_URL ?? 'https://api.anthropic.com';
  const beta = process.env.ROUTINE_BETA_HEADER ?? 'experimental-cc-routine-2026-04-01';
  const url = `${baseUrl.replace(/\/$/, '')}/v1/routines/${resolved.id}/schedule`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCHEDULE_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${resolved.bearer}`,
        'anthropic-beta': beta,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ fire_at: body.fire_at_iso, body: body.body ?? {} }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return jsonRes(502, {
        error: `anthropic/schedule: upstream ${upstream.status}: ${text.slice(0, 256)}`,
      });
    }
    const json = (await upstream.json()) as { scheduled_one_off_id?: unknown };
    if (typeof json.scheduled_one_off_id !== 'string' || json.scheduled_one_off_id.length === 0) {
      return jsonRes(502, {
        error: 'anthropic/schedule: upstream response missing scheduled_one_off_id',
      });
    }
    return jsonRes(200, { ok: true, scheduledOneOffId: json.scheduled_one_off_id });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(502, { error: `anthropic/schedule: ${msg.slice(0, 256)}` });
  }
}
