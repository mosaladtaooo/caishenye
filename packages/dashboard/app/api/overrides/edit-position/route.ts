/**
 * POST /api/overrides/edit-position -- change SL and/or TP on an open MT5 position.
 *
 * AC-016-3 + AC-016-3-b. Body shape:
 *   {ticket: <positive integer>, sl?: number, tp?: number, csrf: string}
 *
 * Validation rules:
 *   - ticket > 0
 *   - sl, tp (if provided) are finite + non-negative
 *   - at least one of sl/tp must be provided
 *
 * v1.2 FR-025 D3: auth swept to lib/resolve-operator-auth.
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { buildOverrideDeps } from '@/lib/override-bind';
import { executeOverride } from '@/lib/override-handler';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

interface EditRequestBody {
  ticket?: unknown;
  sl?: unknown;
  tp?: unknown;
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

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
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

  let body: EditRequestBody;
  try {
    body = (await req.json()) as EditRequestBody;
  } catch {
    return jsonRes(400, { ok: false, error: 'invalid JSON body' });
  }

  const csrfCookie = readCsrfCookie(req);
  const submittedToken = typeof body.csrf === 'string' ? body.csrf : '';
  const csrfResult = validateCsrf({ submittedToken, cookieValue: csrfCookie, secret: authSecret });
  if (!csrfResult.valid) {
    return jsonRes(403, { ok: false, error: `csrf invalid: ${csrfResult.reason ?? 'unknown'}` });
  }

  // Body validation.
  const rawTicket = body.ticket;
  if (typeof rawTicket !== 'number' || !Number.isInteger(rawTicket) || rawTicket <= 0) {
    return jsonRes(400, { ok: false, error: 'ticket must be a positive integer' });
  }
  const ticket = rawTicket;

  const sl = body.sl;
  const tp = body.tp;
  const slProvided = sl !== undefined && sl !== null;
  const tpProvided = tp !== undefined && tp !== null;
  if (!slProvided && !tpProvided) {
    return jsonRes(400, { ok: false, error: 'at least one of sl, tp must be provided' });
  }
  if (slProvided && !isFiniteNonNeg(sl)) {
    return jsonRes(400, { ok: false, error: 'sl must be a finite non-negative number' });
  }
  if (tpProvided && !isFiniteNonNeg(tp)) {
    return jsonRes(400, { ok: false, error: 'tp must be a finite non-negative number' });
  }

  const slNum = slProvided ? (sl as number) : 0;
  const tpNum = tpProvided ? (tp as number) : 0;

  const deps = buildOverrideDeps({
    tenantId: operatorTenantId,
    shape: { type: 'edit_sl_tp', ticket: BigInt(ticket), sl: slNum, tp: tpNum },
  });

  try {
    const params: Record<string, number> = { ticket };
    if (slProvided) params.sl = slNum;
    if (tpProvided) params.tp = tpNum;

    const result = await executeOverride(
      {
        tenantId: operatorTenantId,
        operatorUserId,
        actionType: 'edit_sl_tp',
        targetTicket: BigInt(ticket),
        paramsJson: params,
        mt5WriteDescription: `edit-position ticket=${ticket} sl=${slProvided ? slNum : 'unchanged'} tp=${tpProvided ? tpNum : 'unchanged'}`,
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
    process.stderr.write(`[edit-position] unhandled error: ${msg}\n`);
    return jsonRes(500, { ok: false, error: msg });
  }
}
