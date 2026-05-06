/**
 * POST /api/overrides/close-all -- close every open MT5 position.
 *
 * AC-016-2 + AC-016-2-b. Body REQUIRES the literal string "CLOSE-ALL" as
 * the confirmation key -- this is a typo guard so a fat-finger doesn't
 * close the whole portfolio. The dashboard UI will surface a separate
 * confirmation modal where the operator types CLOSE-ALL by hand.
 *
 * v1.2 FR-025 D3: auth swept to lib/resolve-operator-auth.
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { buildOverrideDeps } from '@/lib/override-bind';
import { executeOverride } from '@/lib/override-handler';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

const CONFIRMATION_LITERAL = 'CLOSE-ALL';

interface CloseAllRequestBody {
  confirmation?: unknown;
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

  let body: CloseAllRequestBody;
  try {
    body = (await req.json()) as CloseAllRequestBody;
  } catch {
    return jsonRes(400, { ok: false, error: 'invalid JSON body' });
  }

  const csrfCookie = readCsrfCookie(req);
  const submittedToken = typeof body.csrf === 'string' ? body.csrf : '';
  const csrfResult = validateCsrf({ submittedToken, cookieValue: csrfCookie, secret: authSecret });
  if (!csrfResult.valid) {
    return jsonRes(403, { ok: false, error: `csrf invalid: ${csrfResult.reason ?? 'unknown'}` });
  }

  // AC-016-2 confirmation literal -- case-sensitive exact match.
  if (body.confirmation !== CONFIRMATION_LITERAL) {
    return jsonRes(400, {
      ok: false,
      error: `confirmation must be the literal string "${CONFIRMATION_LITERAL}"`,
    });
  }

  const deps = buildOverrideDeps({ tenantId: operatorTenantId, shape: { type: 'close_all' } });
  try {
    const result = await executeOverride(
      {
        tenantId: operatorTenantId,
        operatorUserId,
        actionType: 'close_all',
        targetPair: null,
        paramsJson: { confirmation: CONFIRMATION_LITERAL },
        mt5WriteDescription: 'close-all positions',
      },
      deps,
    );
    if (!result.ok) {
      return jsonRes(502, {
        ok: false,
        overrideRowId: result.overrideRowId,
        error: result.errorMessage ?? 'mt5 write failed',
      });
    }
    return jsonRes(200, { ok: true, overrideRowId: result.overrideRowId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[close-all] unhandled error: ${msg}\n`);
    return jsonRes(500, { ok: false, error: msg });
  }
}
