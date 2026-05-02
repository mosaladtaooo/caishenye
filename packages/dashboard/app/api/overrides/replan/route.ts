/**
 * POST /api/overrides/replan — force a fresh Planner fire.
 *
 * R3-followup split-tx flow:
 *   Tx A (cancel + audit insert) → external /fire (no DB tx) → Tx B (settle)
 *
 * AC-018-1: a successful response returns the new one_off_id.
 * AC-018-2: in-flight pair_schedules cancelled in Tx A.
 * AC-018-2-b: race-window covered by Executor pre-fire stale-check (the
 *             "stale plan noop" path in executor.ts; verified in
 *             routines/tests/executor.test.ts).
 * AC-018-3: when remaining slots <= 2, body must include
 *           {confirm_low_cap: true}; out-of-slots is unconditional.
 *
 * Failure mapping:
 *   Tx A throws       → 500
 *   /fire fails       → 502 (Tx B still settles audit to failed)
 *   Tx B throws       → 500 with stuckRowId surfaced for orphan-detect
 *   /fire succeeds + Tx B succeeds → 200 with anthropicOneOffId
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { resolveOperatorFromSession } from '@/lib/override-bind';
import {
  firePlannerRoutine,
  getCapRemainingSlots,
  txACancelAndAudit,
  txBSettleAudit,
} from '@/lib/replan-flow';

const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];
const LOW_CAP_THRESHOLD = 2;

interface ReplanRequestBody {
  csrf?: unknown;
  confirm_low_cap?: unknown;
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  for (const name of SESSION_COOKIE_NAMES) {
    const match = parts.find((p) => p.startsWith(`${name}=`));
    if (match !== undefined) return match.slice(name.length + 1);
  }
  return undefined;
}

function readCsrfCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  const match = parts.find((p) => p.startsWith(`${CSRF_COOKIE_NAME}=`));
  if (match === undefined) return undefined;
  return match.slice(CSRF_COOKIE_NAME.length + 1);
}

function currentDateGmt(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function POST(req: Request): Promise<Response> {
  const authSecret = process.env.AUTH_SECRET ?? '';
  if (authSecret.length === 0) {
    return jsonRes(500, { ok: false, error: 'server misconfigured: AUTH_SECRET missing' });
  }

  const operator = await resolveOperatorFromSession(readSessionCookie(req));
  if (operator === null) {
    return jsonRes(401, { ok: false, error: 'unauthenticated' });
  }

  let body: ReplanRequestBody;
  try {
    body = (await req.json()) as ReplanRequestBody;
  } catch {
    return jsonRes(400, { ok: false, error: 'invalid JSON body' });
  }

  const csrfResult = validateCsrf({
    submittedToken: typeof body.csrf === 'string' ? body.csrf : '',
    cookieValue: readCsrfCookie(req),
    secret: authSecret,
  });
  if (!csrfResult.valid) {
    return jsonRes(403, { ok: false, error: `csrf invalid: ${csrfResult.reason ?? 'unknown'}` });
  }

  // AC-018-3 — cap-confirm gate. confirm_low_cap MUST be exactly true; out
  // of slots is unconditional regardless of confirm.
  const capRemaining = await getCapRemainingSlots(operator.tenantId);
  const confirmLowCap = body.confirm_low_cap === true;
  if (capRemaining <= 0) {
    return jsonRes(409, {
      ok: false,
      error: 'cap exhausted — daily limit reached',
      capRemaining,
    });
  }
  if (capRemaining <= LOW_CAP_THRESHOLD && !confirmLowCap) {
    return jsonRes(409, {
      ok: false,
      error: `low cap (${capRemaining} slot(s) remaining); resubmit with confirm_low_cap: true`,
      capRemaining,
    });
  }

  // ===== Tx A — cancel + audit insert =====
  let txA: { routineRunId: number };
  try {
    txA = await txACancelAndAudit({
      tenantId: operator.tenantId,
      operatorUserId: operator.operatorUserId,
      date: currentDateGmt(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[replan] Tx A failed: ${msg}\n`);
    return jsonRes(500, { ok: false, error: `Tx A failed: ${msg}` });
  }

  // ===== External /fire — NO DB tx open here (R3 invariant) =====
  let fireResult: Awaited<ReturnType<typeof firePlannerRoutine>>;
  try {
    fireResult = await firePlannerRoutine();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fireResult = { ok: false, errorMessage: msg };
  }

  // ===== Tx B — settle audit row =====
  try {
    await txBSettleAudit({
      routineRunId: txA.routineRunId,
      anthropicOneOffId: fireResult.ok ? fireResult.anthropicOneOffId : null,
      success: fireResult.ok,
      errorMessage: fireResult.ok ? null : fireResult.errorMessage,
    });
  } catch (e) {
    // /fire may have succeeded against Anthropic but our audit settle
    // failed. Surface the stuck row for orphan-detect cron + show the
    // anthropic id so the dashboard can warn the operator.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[replan] Tx B failed: ${msg} — orphan-detect will recover\n`);
    return jsonRes(500, {
      ok: false,
      error: `Tx B settle failed: ${msg}`,
      stuckRowId: txA.routineRunId,
      anthropicOneOffId: fireResult.ok ? fireResult.anthropicOneOffId : null,
    });
  }

  if (!fireResult.ok) {
    return jsonRes(502, {
      ok: false,
      error: fireResult.errorMessage,
      routineRunId: txA.routineRunId,
    });
  }

  return jsonRes(200, {
    ok: true,
    routineRunId: txA.routineRunId,
    anthropicOneOffId: fireResult.anthropicOneOffId,
  });
}
