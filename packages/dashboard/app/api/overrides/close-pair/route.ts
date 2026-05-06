/**
 * POST /api/overrides/close-pair -- close all open positions on a pair.
 *
 * AC-016-1: Operator clicks "Close pair X" -> R4 7-step flow runs.
 * AC-016-1-b (R6): rejects without valid CSRF round-trip.
 * AC-007-3-b: before_state_json captured from real MT5 read pre-write.
 *
 * v1.2 FR-025 D3: auth resolution swapped to lib/resolve-operator-auth's
 * shared helper. This route is one of the 9 swept (AC-025-2). The CSRF
 * gate (R6) still runs as a separate step AFTER auth resolution.
 *
 * Flow:
 *   1. resolveOperatorAuth(req) -- operator-session cookie OR Auth.js cookie
 *      OR INTERNAL_API_TOKEN bearer (FR-025).
 *   2. validateCsrf -- double-submit + HMAC-SHA256(AUTH_SECRET) check (R6).
 *   3. Parse + validate body shape: {pair: string, csrf: string}.
 *   4. Delegate to lib/override-handler.executeOverride with action_type
 *      = 'close_pair'; lib injects MT5 read/write closures via
 *      lib/override-bind.buildOverrideDeps.
 *   5. Map executeOverride result -> HTTP status:
 *        ok=true   -> 200 {ok:true, overrideRowId}
 *        ok=false  -> 502 {ok:false, error, overrideRowId}  (MT5 write failed)
 *        throws    -> 500 {ok:false, error}                  (audit / unhandled)
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { buildOverrideDeps } from '@/lib/override-bind';
import { executeOverride } from '@/lib/override-handler';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

interface CloseRequestBody {
  pair?: unknown;
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
  // Step 0 -- env precheck (loud failure on misconfig).
  const authSecret = process.env.AUTH_SECRET ?? '';
  if (authSecret.length === 0) {
    return jsonRes(500, { ok: false, error: 'server misconfigured: AUTH_SECRET missing' });
  }

  // Step 1 -- auth via shared helper (FR-025 D3).
  const auth = await resolveOperatorAuth(req);
  if (!auth.ok) {
    return jsonRes(auth.status, { ok: false, error: auth.reason });
  }
  const operatorTenantId = auth.operator.tenantId;
  const operatorUserId = Number(auth.operator.id);
  if (!Number.isFinite(operatorUserId) || operatorUserId <= 0) {
    // Internal-token caller has id='internal-api-token' (non-numeric); it's
    // explicitly excluded from operator-mutating actions per token-domain
    // rule (the helper accepts internal-token for read-only callers, NOT
    // for state-mutating override flows). Reject with 401.
    return jsonRes(401, { ok: false, error: 'internal-token not permitted for override actions' });
  }

  // Step 3 -- parse body BEFORE CSRF so we have the submitted token. We
  // intentionally parse-then-CSRF (rather than CSRF-then-parse) because the
  // CSRF token lives in the JSON body. A bad body still doesn't bypass CSRF
  // -- we validate shape after the CSRF gate.
  let body: CloseRequestBody;
  try {
    body = (await req.json()) as CloseRequestBody;
  } catch {
    return jsonRes(400, { ok: false, error: 'invalid JSON body' });
  }

  // Step 2 -- CSRF gate (R6).
  const csrfCookie = readCsrfCookie(req);
  const submittedToken = typeof body.csrf === 'string' ? body.csrf : '';
  const csrfResult = validateCsrf({
    submittedToken,
    cookieValue: csrfCookie,
    secret: authSecret,
  });
  if (!csrfResult.valid) {
    return jsonRes(403, { ok: false, error: `csrf invalid: ${csrfResult.reason ?? 'unknown'}` });
  }

  // Step 3 (cont) -- body shape validation.
  if (typeof body.pair !== 'string' || body.pair.length === 0) {
    return jsonRes(400, { ok: false, error: 'body.pair must be a non-empty string' });
  }
  const pair = body.pair;

  // Step 4 -- delegate to the R4 7-step engine.
  const deps = buildOverrideDeps({
    tenantId: operatorTenantId,
    shape: { type: 'close_pair', pair },
  });
  try {
    const result = await executeOverride(
      {
        tenantId: operatorTenantId,
        operatorUserId,
        actionType: 'close_pair',
        targetPair: pair,
        paramsJson: { pair },
        mt5WriteDescription: `close-pair ${pair}`,
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
    process.stderr.write(`[close-pair] unhandled error: ${msg}\n`);
    return jsonRes(500, { ok: false, error: msg });
  }
}
