/**
 * POST /api/overrides/close-pair — close all open positions on a pair.
 *
 * AC-016-1: Operator clicks "Close pair X" → R4 7-step flow runs.
 * AC-016-1-b (R6): rejects without valid CSRF round-trip.
 * AC-007-3-b: before_state_json captured from real MT5 read pre-write.
 *
 * Flow:
 *   1. auth() — Auth.js session re-verify (route-side defense even though
 *      middleware also gates).
 *   2. validateCsrf — double-submit + HMAC-SHA256(AUTH_SECRET) check (R6).
 *   3. Parse + validate body shape: {pair: string, csrf: string}.
 *   4. Delegate to lib/override-handler.executeOverride with action_type
 *      = 'close_pair'; lib injects MT5 read/write closures via
 *      lib/override-bind.buildOverrideDeps.
 *   5. Map executeOverride result → HTTP status:
 *        ok=true   → 200 {ok:true, overrideRowId}
 *        ok=false  → 502 {ok:false, error, overrideRowId}  (MT5 write failed)
 *        throws    → 500 {ok:false, error}                  (audit / unhandled)
 */

import { CSRF_COOKIE_NAME, validateCsrf } from '@/lib/csrf';
import { buildOverrideDeps, resolveOperatorFromSession } from '@/lib/override-bind';
import { executeOverride } from '@/lib/override-handler';

const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];

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

/**
 * Read the session-cookie value from a Request, picking the first match in
 * SESSION_COOKIE_NAMES (Auth.js sets `__Secure-` over HTTPS, plain over HTTP).
 */
function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  // Naive cookie parse — sufficient for the documented cookie shape.
  const parts = raw.split(';').map((p) => p.trim());
  for (const name of SESSION_COOKIE_NAMES) {
    const match = parts.find((p) => p.startsWith(`${name}=`));
    if (match !== undefined) {
      return match.slice(name.length + 1);
    }
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
  // Step 0 — env precheck (loud failure on misconfig).
  const authSecret = process.env.AUTH_SECRET ?? '';
  if (authSecret.length === 0) {
    return jsonRes(500, { ok: false, error: 'server misconfigured: AUTH_SECRET missing' });
  }

  // Step 1 — auth re-verify.
  const sessionTok = readSessionCookie(req);
  const operator = await resolveOperatorFromSession(sessionTok);
  if (operator === null) {
    return jsonRes(401, { ok: false, error: 'unauthenticated' });
  }

  // Step 3 — parse body BEFORE CSRF so we have the submitted token. We
  // intentionally parse-then-CSRF (rather than CSRF-then-parse) because the
  // CSRF token lives in the JSON body. A bad body still doesn't bypass CSRF
  // — we validate shape after the CSRF gate.
  let body: CloseRequestBody;
  try {
    body = (await req.json()) as CloseRequestBody;
  } catch {
    return jsonRes(400, { ok: false, error: 'invalid JSON body' });
  }

  // Step 2 — CSRF gate (R6).
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

  // Step 3 (cont) — body shape validation.
  if (typeof body.pair !== 'string' || body.pair.length === 0) {
    return jsonRes(400, { ok: false, error: 'body.pair must be a non-empty string' });
  }
  const pair = body.pair;

  // Step 4 — delegate to the R4 7-step engine.
  const deps = buildOverrideDeps({
    tenantId: operator.tenantId,
    shape: { type: 'close_pair', pair },
  });
  try {
    const result = await executeOverride(
      {
        tenantId: operator.tenantId,
        operatorUserId: operator.operatorUserId,
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
