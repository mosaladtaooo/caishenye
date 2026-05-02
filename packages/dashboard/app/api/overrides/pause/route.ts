/**
 * POST /api/overrides/pause — pause the trading agent.
 *
 * AC-017-1: sets agent_state.paused_bool=true.
 * AC-017-3: cancels every not-yet-fired pair_schedules row for today.
 *
 * The MT5-side verb is logical (no real MT5 mutation — pause is a control
 * flag). The override-bind buildOverrideDeps for shape.type='pause' uses
 * a transaction that flips agent_state + cancels schedules.
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { buildOverrideDeps, resolveOperatorFromSession } from '@/lib/override-bind';
import { executeOverride } from '@/lib/override-handler';

const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];

interface PauseRequestBody {
  csrf?: unknown;
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

export async function POST(req: Request): Promise<Response> {
  const authSecret = process.env.AUTH_SECRET ?? '';
  if (authSecret.length === 0) {
    return jsonRes(500, { ok: false, error: 'server misconfigured: AUTH_SECRET missing' });
  }

  const operator = await resolveOperatorFromSession(readSessionCookie(req));
  if (operator === null) {
    return jsonRes(401, { ok: false, error: 'unauthenticated' });
  }

  let body: PauseRequestBody;
  try {
    body = (await req.json()) as PauseRequestBody;
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

  const deps = buildOverrideDeps({ tenantId: operator.tenantId, shape: { type: 'pause' } });
  try {
    const result = await executeOverride(
      {
        tenantId: operator.tenantId,
        operatorUserId: operator.operatorUserId,
        actionType: 'pause',
        paramsJson: { ts: new Date().toISOString() },
        mt5WriteDescription: 'pause agent + cancel today not-yet-fired schedules',
      },
      deps,
    );
    if (!result.ok) {
      return jsonRes(502, {
        ok: false,
        overrideRowId: result.overrideRowId,
        error: result.errorMessage ?? 'pause failed',
      });
    }
    return jsonRes(200, { ok: true, overrideRowId: result.overrideRowId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pause] unhandled error: ${msg}\n`);
    return jsonRes(500, { ok: false, error: msg });
  }
}
