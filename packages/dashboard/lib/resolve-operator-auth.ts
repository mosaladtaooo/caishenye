/**
 * resolve-operator-auth — shared auth resolver for the FR-025 cookie sweep
 * across the 9 operator-facing dashboard routes (D3).
 *
 * Replaces 9 routes' bespoke `resolveOperatorFromSession`-or-cookie patterns
 * with a single discriminated-union helper:
 *
 *   { ok: true,  operator: { id: string, source: 'operator-session' | 'auth-js' | 'internal-token' } }
 *   { ok: false, status: 401, reason: string }
 *
 * Resolution precedence (first hit wins):
 *   1. operator-session cookie  (existing v1.1 KI-005 token-flow path)
 *   2. Auth.js cookie           (existing v1.1 fallback path; resolves via
 *                                lib/override-bind.resolveOperatorFromSession)
 *   3. INTERNAL_API_TOKEN bearer (for non-cron internal callers ONLY)
 *
 * Operator wins over Auth.js. CRON_SECRET is OUTSIDE this helper's domain
 * — cron routes (/api/cron/*) use lib/cron-auth.ts. The helper rejects
 * requests carrying CRON_SECRET as a Bearer when CRON_SECRET differs from
 * INTERNAL_API_TOKEN per clarify-round-1 Q3 (token-domain pin: a leaked
 * CRON_SECRET MUST NOT authenticate against /api/overrides/*).
 *
 * EC-025-2 fail-fast policy (clarify Q7 — security-vs-UX tradeoff resolved
 * toward security): a structurally-valid operator-session cookie with a BAD
 * signature returns 401 immediately and does NOT fall through to Auth.js.
 * An audit row is written to `routine_runs` with event_type='auth_bad_signature'
 * for forensic clarity. Rotation flow becomes "rotate AUTH_SECRET, all
 * existing cookies fail loudly with 'please re-login', operator re-logs-in
 * cleanly via passkey or token-fallback".
 *
 * R11 column-shape pin: `auditWriteSpy.mock.calls[0][0]` asserts column-by-column
 * equality on the audit row shape. The shape IS the contract.
 *
 * Constitution §4 multi-tenant: tenant_id resolution defaults to 1 in v1
 * single-tenant; preserves the v1.1 audit-row pattern for forward compat
 * with multi-tenant rollout.
 */

import { timingSafeEqual } from 'node:crypto';

import { writeAuthAuditRow } from './auth-audit';
import { resolveOperatorFromSession } from './auth-js-session';
import { OPERATOR_COOKIE_NAME, verifyOperatorCookie } from './operator-session';

const AUTH_JS_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];
const SCHEME_PREFIX = 'Bearer ';

/** Single-tenant default for v1; matches v1.1 audit-row pattern. */
const DEFAULT_TENANT_ID = 1;

/** Operator-session cookie's fixed subject value (matches mintOperatorCookie). */
const OPERATOR_SUBJECT = 'caishen-operator-v1';

export type ResolveOperatorAuthResult =
  | {
      ok: true;
      operator: {
        id: string;
        tenantId: number;
        source: 'operator-session' | 'auth-js' | 'internal-token';
      };
    }
  | {
      ok: false;
      status: 401;
      reason: string;
    };

/**
 * Resolve a Request to a logged-in operator OR a 401 reason. Used by all
 * 9 operator-facing dashboard routes (FR-025 AC-025-2 enumeration). NOT
 * for cron routes — they use lib/cron-auth.ts.
 */
export async function resolveOperatorAuth(req: Request): Promise<ResolveOperatorAuthResult> {
  const operatorCookie = readCookieByName(req, OPERATOR_COOKIE_NAME);

  // Step 1 — operator-session cookie path (highest precedence).
  if (typeof operatorCookie === 'string' && operatorCookie.length > 0) {
    // Distinguish "structurally invalid cookie" (no '.' / wrong shape)
    // from "structurally valid but signature fails". The first is just
    // a missing-cookie equivalent (fall through). The second is EC-025-2
    // fail-fast.
    const looksStructured = isStructuralOperatorCookie(operatorCookie);
    const verified = await verifyOperatorCookie(operatorCookie);
    if (verified) {
      // Success.
      return {
        ok: true,
        operator: {
          id: OPERATOR_SUBJECT,
          tenantId: DEFAULT_TENANT_ID,
          source: 'operator-session',
        },
      };
    }
    if (looksStructured) {
      // EC-025-2 fail-fast: bad signature on structurally valid cookie.
      // Write audit row + return 401 without consulting Auth.js path.
      const requestPath = readRequestPath(req);
      await writeAuthAuditRow({
        event_type: 'auth_bad_signature',
        tenant_id: DEFAULT_TENANT_ID,
        details_json: {
          source_cookie_present: true,
          request_path: requestPath,
        },
      });
      return {
        ok: false,
        status: 401,
        reason:
          'operator-session signature invalid — possible tampering OR signing secret rotation; please re-login',
      };
    }
    // Cookie present but malformed shape — treat as no-cookie and fall through.
  }

  // Step 2 — Auth.js cookie path.
  const authJsCookie = readAuthJsCookie(req);
  if (typeof authJsCookie === 'string' && authJsCookie.length > 0) {
    try {
      const resolved = await resolveOperatorFromSession(authJsCookie);
      if (resolved !== null) {
        return {
          ok: true,
          operator: {
            id: String(resolved.operatorUserId),
            tenantId: resolved.tenantId,
            source: 'auth-js',
          },
        };
      }
    } catch (e) {
      // Constitution §17 — log boundary error; fall through to bearer/401
      // rather than 500-ing the whole route. Failure here means Auth.js
      // env is misconfigured (e.g., AUTH_URL missing); the operator's
      // operator-session path or bearer path is still allowed to succeed.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[resolve-operator-auth] auth-js fallback exception: ${msg}\n`);
    }
  }

  // Step 3 — INTERNAL_API_TOKEN bearer path. EXCLUDES CRON_SECRET per
  // clarify Q3 (token-domain pin).
  const auth = req.headers.get('authorization') ?? '';
  if (auth.length > 0 && auth.startsWith(SCHEME_PREFIX)) {
    const supplied = auth.slice(SCHEME_PREFIX.length);
    const expected = process.env.INTERNAL_API_TOKEN ?? '';
    // Length-then-content timing-safe compare. Empty `expected` short-circuits
    // (graceful EC-025-3 path: env unset → 401, never crash).
    if (expected.length > 0 && supplied.length === expected.length) {
      const a = Buffer.from(supplied);
      const b = Buffer.from(expected);
      if (timingSafeEqual(a, b)) {
        return {
          ok: true,
          operator: {
            id: 'internal-api-token',
            tenantId: DEFAULT_TENANT_ID,
            source: 'internal-token',
          },
        };
      }
    }
  }

  return { ok: false, status: 401, reason: 'no auth cookie or token' };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function readAuthJsCookie(req: Request): string | undefined {
  for (const name of AUTH_JS_COOKIE_NAMES) {
    const v = readCookieByName(req, name);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function readCookieByName(req: Request, name: string): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  const match = parts.find((p) => p.startsWith(`${name}=`));
  return match === undefined ? undefined : match.slice(name.length + 1);
}

function isStructuralOperatorCookie(value: string): boolean {
  // mintOperatorCookie returns `${payloadB64}.${sigB64}` — exactly 2 dot-segments.
  if (typeof value !== 'string' || value.length === 0) return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  // Both parts must be non-empty for the cookie to be "structurally valid".
  if (typeof payload !== 'string' || typeof sig !== 'string') return false;
  if (payload.length === 0 || sig.length === 0) return false;
  return true;
}

function readRequestPath(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return '<unparseable>';
  }
}
