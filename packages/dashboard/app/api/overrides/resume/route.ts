/**
 * POST /api/overrides/resume -- resume the trading agent.
 *
 * AC-017-1: sets agent_state.paused_bool=false.
 * AC-017-4: resume only re-enables Planner/Executor pre-fire stale-checks;
 *           today's already-cancelled schedules stay cancelled. The
 *           operator must `/api/overrides/replan` to schedule a fresh day.
 *
 * v1.2 FR-025 D3: auth swept to lib/resolve-operator-auth.
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { buildOverrideDeps } from '@/lib/override-bind';
import { executeOverride } from '@/lib/override-handler';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

interface ResumeRequestBody {
  csrf?: unknown;
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readCsrfCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  const match = parts.find((p) => p.startsWith(`${CSRF_COOKIE_NAME}=`));
  if (match === undefined) return undefined;
  return match.slice(CSRF_COOKIE_NAME.length + 1);
}

export async function POST(req: Request): Promise<Response> {
  const authSecret = process.env.AUTH_SECRET ?? '';
  if (authSecret.length === 0) {
    return jsonRes(500, { ok: false, error: 'server misconfigured: AUTH_SECRET missing' });
  }

  const auth = await resolveOperatorAuth(req);
  if (!auth.ok) {
    return jsonRes(auth.status, { ok: false, error: auth.reason });
  }
  const operatorTenantId = auth.operator.tenantId;
  const operatorUserId = Number(auth.operator.id);
  if (!Number.isFinite(operatorUserId) || operatorUserId <= 0) {
    return jsonRes(401, { ok: false, error: 'internal-token not permitted for override actions' });
  }

  let body: ResumeRequestBody;
  try {
    body = (await req.json()) as ResumeRequestBody;
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

  const deps = buildOverrideDeps({ tenantId: operatorTenantId, shape: { type: 'resume' } });
  try {
    const result = await executeOverride(
      {
        tenantId: operatorTenantId,
        operatorUserId,
        actionType: 'resume',
        paramsJson: { ts: new Date().toISOString() },
        mt5WriteDescription: 'resume agent',
      },
      deps,
    );
    if (!result.ok) {
      return jsonRes(502, {
        ok: false,
        overrideRowId: result.overrideRowId,
        error: result.errorMessage ?? 'resume failed',
      });
    }
    return jsonRes(200, { ok: true, overrideRowId: result.overrideRowId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[resume] unhandled error: ${msg}\n`);
    return jsonRes(500, { ok: false, error: msg });
  }
}
