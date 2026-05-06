/**
 * resolve-operator-auth — shared helper for the FR-025 cookie sweep (D3).
 *
 * Replaces 9 routes' bespoke `resolveOperatorFromSession`-or-cookie patterns
 * with a single discriminated-union helper:
 *
 *   { ok: true,  operator: { id: string, source: ... } }
 *   { ok: false, status: 401, reason: string }
 *
 * Resolution precedence (first hit wins):
 *   1. operator-session cookie  (existing v1.1 KI-005 token-flow path)
 *   2. Auth.js cookie           (existing v1.1 fallback path)
 *   3. INTERNAL_API_TOKEN bearer (for non-cron internal callers ONLY)
 *
 * Operator wins over Auth.js. CRON_SECRET is OUTSIDE this helper's domain
 * — cron routes use lib/cron-auth.ts. The helper rejects requests carrying
 * CRON_SECRET as a Bearer when CRON_SECRET differs from INTERNAL_API_TOKEN.
 *
 * EC-025-2 fail-fast policy: a structurally-valid operator-session cookie
 * with a BAD signature returns 401 immediately (does NOT fall through to
 * Auth.js). An audit row is written to `routine_runs` with
 * event_type='auth_bad_signature' for forensic clarity. This is the
 * security-vs-UX tradeoff resolved toward security per clarify Q7.
 *
 * R11 column-shape pin: case 2 below asserts `auditWriteSpy.mock.calls[0][0]`
 * column-by-column equality, NOT just `toHaveBeenCalled()`. The audit row
 * shape is the contract.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintOperatorCookie } from '@/lib/operator-session';

const internalToken = randomBytes(32).toString('hex');
const cronToken = randomBytes(32).toString('hex');
const authHmacKey = randomBytes(32).toString('hex');

let auditWriteSpy: ReturnType<typeof vi.fn>;
let resolveAuthJsSpy: ReturnType<typeof vi.fn>;

let originalAuthHmacKey: string | undefined;
let originalInternalToken: string | undefined;
let originalCronSecret: string | undefined;
let originalAuthUrl: string | undefined;

beforeEach(() => {
  originalAuthHmacKey = process.env.AUTH_SECRET;
  originalInternalToken = process.env.INTERNAL_API_TOKEN;
  originalCronSecret = process.env.CRON_SECRET;
  originalAuthUrl = process.env.AUTH_URL;
  process.env.AUTH_SECRET = authHmacKey;
  process.env.INTERNAL_API_TOKEN = internalToken;
  process.env.CRON_SECRET = cronToken;
  process.env.AUTH_URL = 'https://test.local';
  auditWriteSpy = vi.fn(async () => undefined);
  resolveAuthJsSpy = vi.fn(async () => null);
  vi.resetModules();
});

afterEach(() => {
  if (originalAuthHmacKey === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthHmacKey;
  if (originalInternalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalInternalToken;
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
  vi.restoreAllMocks();
});

async function importHelper() {
  // The helper has TWO injected deps — the audit writer (for EC-025-2 row)
  // and the Auth.js resolver (existing override-bind.resolveOperatorFromSession).
  // We mock the audit writer module + override-bind module so the unit test
  // never touches Postgres.
  vi.doMock('@/lib/auth-audit', () => ({
    writeAuthAuditRow: auditWriteSpy,
  }));
  vi.doMock('@/lib/auth-js-session', () => ({
    resolveOperatorFromSession: resolveAuthJsSpy,
  }));
  return await import('../../../lib/resolve-operator-auth');
}

function buildReq(opts: {
  operatorCookie?: string;
  authJsCookie?: string;
  bearer?: string;
  path?: string;
}): Request {
  const headers = new Headers();
  const cookieParts: string[] = [];
  if (opts.operatorCookie) cookieParts.push(`caishen-operator-session=${opts.operatorCookie}`);
  if (opts.authJsCookie) cookieParts.push(`__Secure-authjs.session-token=${opts.authJsCookie}`);
  if (cookieParts.length > 0) headers.set('cookie', cookieParts.join('; '));
  if (opts.bearer !== undefined) headers.set('authorization', `Bearer ${opts.bearer}`);
  return new Request(`https://app.local${opts.path ?? '/api/overrides/close-pair'}`, {
    method: 'POST',
    headers,
  });
}

describe('resolveOperatorAuth — case 1: valid operator-session cookie', () => {
  it('returns ok with source=operator-session', async () => {
    const helper = await importHelper();
    const cookie = await mintOperatorCookie();
    const req = buildReq({ operatorCookie: cookie });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operator.source).toBe('operator-session');
      expect(typeof result.operator.id).toBe('string');
      expect(result.operator.id.length).toBeGreaterThan(0);
    }
    // Auth.js path NOT consulted when operator cookie wins.
    expect(resolveAuthJsSpy).not.toHaveBeenCalled();
    // No audit row written for the success path.
    expect(auditWriteSpy).not.toHaveBeenCalled();
  });
});

describe('resolveOperatorAuth — case 2: operator cookie present but signature invalid (EC-025-2 + R11)', () => {
  it('returns 401 with fail-fast reason; writes routine_runs row with column-shape audit (R11)', async () => {
    const helper = await importHelper();
    // Build a syntactically valid 2-part cookie that fails HMAC verify.
    const realCookie = await mintOperatorCookie();
    const tampered = `${realCookie.slice(0, -3)}AAA`;
    const req = buildReq({
      operatorCookie: tampered,
      path: '/api/overrides/close-pair',
    });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toMatch(/operator-session signature invalid/);
    }
    // EC-025-2 + R11: do NOT fall through to Auth.js.
    expect(resolveAuthJsSpy).not.toHaveBeenCalled();
    // R11 column-by-column audit row assertion. Optional chaining on the
    // outer `[0]` accommodates `noUncheckedIndexedAccess: true` from
    // tsconfig.base.json — `mock.calls[0]` is `T[0] | undefined` even after
    // `toHaveBeenCalledTimes(1)` narrows the runtime invariant. If the call
    // were ever absent at runtime, `?.[0]` returns undefined and `.toEqual`
    // fails with a clear "expected object, received undefined" — same loud
    // failure as the prior `mock.calls[0][0]` access, just type-clean.
    expect(auditWriteSpy).toHaveBeenCalledTimes(1);
    expect(auditWriteSpy.mock.calls[0]?.[0]).toEqual({
      event_type: 'auth_bad_signature',
      tenant_id: 1,
      details_json: {
        source_cookie_present: true,
        request_path: '/api/overrides/close-pair',
      },
    });
  });
});

describe('resolveOperatorAuth — case 3: valid Auth.js session cookie (no operator cookie)', () => {
  it('returns ok with source=auth-js when override-bind resolves a session', async () => {
    resolveAuthJsSpy.mockResolvedValueOnce({ tenantId: 1, operatorUserId: 42 });
    const helper = await importHelper();
    const req = buildReq({ authJsCookie: 'fake-authjs-cookie-value' });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operator.source).toBe('auth-js');
      expect(result.operator.id).toBe('42');
    }
    expect(resolveAuthJsSpy).toHaveBeenCalledTimes(1);
    expect(auditWriteSpy).not.toHaveBeenCalled();
  });
});

describe('resolveOperatorAuth — case 4: both operator + Auth.js cookies present', () => {
  it('operator wins (source=operator-session); does NOT consult Auth.js path', async () => {
    const helper = await importHelper();
    const cookie = await mintOperatorCookie();
    const req = buildReq({
      operatorCookie: cookie,
      authJsCookie: 'fake-authjs-cookie-value',
    });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operator.source).toBe('operator-session');
    }
    expect(resolveAuthJsSpy).not.toHaveBeenCalled();
  });
});

describe('resolveOperatorAuth — case 5: neither cookie nor token', () => {
  it('returns 401 with no-auth reason', async () => {
    const helper = await importHelper();
    const req = buildReq({});
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe('no auth cookie or token');
    }
  });
});

describe('resolveOperatorAuth — case 6: CRON_SECRET as Bearer (clarify Q3 token-domain pin)', () => {
  it('rejects CRON_SECRET as Bearer when CRON_SECRET differs from INTERNAL_API_TOKEN (returns 401)', async () => {
    // The two tokens are different per beforeEach() setup.
    expect(cronToken).not.toBe(internalToken);
    const helper = await importHelper();
    const req = buildReq({ bearer: cronToken });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe('no auth cookie or token');
    }
  });

  it('accepts INTERNAL_API_TOKEN as Bearer (returns ok with source=internal-token)', async () => {
    const helper = await importHelper();
    const req = buildReq({ bearer: internalToken });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operator.source).toBe('internal-token');
    }
  });
});

describe('resolveOperatorAuth — EC-025-3: INTERNAL_API_TOKEN missing', () => {
  it('does not crash when env unset; falls through gracefully', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const helper = await importHelper();
    const req = buildReq({ bearer: internalToken });
    const result = await helper.resolveOperatorAuth(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      // No crash; reason explains lack of token.
      expect(result.reason).toBe('no auth cookie or token');
    }
  });
});
