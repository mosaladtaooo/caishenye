/**
 * POST /api/internal/anthropic/schedule — DEPRECATED (returns 501).
 *
 * v1.1 (ADR-013) — Architectural pivot. Anthropic exposes NO programmatic
 * `/schedule` API per their official docs (`docs.code.claude.com/routines`).
 * The CLI's `/schedule tomorrow at 9am, ...` command is web-UI mediated;
 * only `/fire` is HTTP-callable. This Vercel-proxy route was speculative
 * and 502'd with upstream 404 not_found_error.
 *
 * Resolution: Planner persists `pair_schedules` rows in `status='scheduled'`;
 * the every-minute cron tick at `/api/cron/fire-due-executors` polls due
 * rows, atomically claims each, fires the Executor via `/api/internal/
 * anthropic/fire`, and settles the row to `status='fired'` with the
 * returned session_id.
 *
 * This route stays in place (rather than being deleted) so any lingering
 * operator system-prompt revisions or test fixtures get a clear 501 with
 * a pointer to the cron pivot, instead of a vague 502 from the dead
 * Anthropic upstream.
 *
 * Removal safe-window: when the v1.2 retrospective confirms no caller is
 * still hitting this path (telemetry on the Vercel logs), the route file
 * can be deleted.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const DEPRECATION_MESSAGE =
  'anthropic/schedule deprecated (v1.1 ADR-013) — Anthropic has no programmatic /schedule API. ' +
  'Planner: persist pair_schedules rows in status=scheduled only. Cron tick at ' +
  '/api/cron/fire-due-executors polls due rows and fires via /api/internal/anthropic/fire. ' +
  'See .harness/progress/decisions.md ADR-013 for the architecture rationale.';

export async function POST(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  return jsonRes(501, { error: DEPRECATION_MESSAGE });
}
