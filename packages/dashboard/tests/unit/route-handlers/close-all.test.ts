/**
 * /api/overrides/close-all — POST route handler tests.
 *
 * AC-016-2: Operator types "CLOSE-ALL" confirmation → handler closes
 *           every open position via MT5; R4 7-step flow.
 * AC-016-2-b (R6 CSRF): rejects without valid CSRF round-trip.
 *
 * Distinct from close-pair:
 *   - body shape: {confirmation: "CLOSE-ALL", csrf}  (literal "CLOSE-ALL")
 *   - 400 if confirmation !== "CLOSE-ALL" (typo guard — AC-016-2 explicitly
 *     names the literal so a fat-finger doesn't yeet your portfolio)
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE_NAME } from '../../../lib/csrf';
import type {
  ExecuteOverrideDeps,
  ExecuteOverrideInput,
  ExecuteOverrideResult,
} from '../../../lib/override-handler';

const TEST_AUTH_KEY = Buffer.alloc(32, 0x11).toString('hex');
const SESSION_COOKIE_NAME = '__Secure-authjs.session-token';
const SESSION_VAL = 'sess-abc-123';

function signCookie(token: string, key: string): string {
  const sig = createHmac('sha256', key).update(token, 'utf8').digest('hex');
  return `${token}.${sig}`;
}

function buildReq(opts: { body?: unknown; csrfCookie?: string; withSession?: boolean }): Request {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : '{}';
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  const cookieParts: string[] = [];
  if (opts.withSession) cookieParts.push(`${SESSION_COOKIE_NAME}=${SESSION_VAL}`);
  if (opts.csrfCookie !== undefined) cookieParts.push(`${CSRF_COOKIE_NAME}=${opts.csrfCookie}`);
  if (cookieParts.length > 0) headers.set('cookie', cookieParts.join('; '));
  return new Request('https://app.local/api/overrides/close-all', {
    method: 'POST',
    headers,
    body,
  });
}

let executeOverrideSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_AUTH_KEY;
  executeOverrideSpy = vi.fn(
    async (
      _input: ExecuteOverrideInput,
      _deps: ExecuteOverrideDeps,
    ): Promise<ExecuteOverrideResult> => ({
      ok: true,
      overrideRowId: 5678,
    }),
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importRoute() {
  vi.doMock('../../../lib/override-handler', async () => {
    const actual = await vi.importActual<typeof import('../../../lib/override-handler')>(
      '../../../lib/override-handler',
    );
    return { ...actual, executeOverride: executeOverrideSpy };
  });
  vi.doMock('../../../lib/override-bind', () => ({
    resolveOperatorFromSession: vi.fn(async (sessionTok: string | undefined) => {
      if (sessionTok === undefined || sessionTok === '') return null;
      return { tenantId: 1, operatorUserId: 42 };
    }),
    buildOverrideDeps: vi.fn(
      (): ExecuteOverrideDeps => ({
        mt5ReadState: vi.fn(async () => ({ tickets: [{ ticket: 1 }] })),
        mt5Write: vi.fn(async () => ({ ok: true as const, after: { tickets: [] } })),
        insertOverrideRow: vi.fn(async () => 999),
        updateOverrideRow: vi.fn(async () => undefined),
        sendTelegram: vi.fn(async () => undefined),
      }),
    ),
  }));
  return await import('../../../app/api/overrides/close-all/route');
}

describe('POST /api/overrides/close-all — auth + CSRF gates', () => {
  it('returns 401 when no session cookie', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ withSession: false, body: { confirmation: 'CLOSE-ALL' } }),
    );
    expect(res.status).toBe(401);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('AC-016-2-b: returns 403 with no CSRF cookie', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({
        withSession: true,
        body: { confirmation: 'CLOSE-ALL' },
      }),
    );
    expect(res.status).toBe(403);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('AC-016-2-b: returns 403 when body csrf mismatches cookie token', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { confirmation: 'CLOSE-ALL', csrf: 'b'.repeat(64) },
      }),
    );
    expect(res.status).toBe(403);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('AC-016-2-b: returns 403 with wrong-secret HMAC', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const wrong = Buffer.alloc(32, 0x99).toString('hex');
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, wrong),
        body: { confirmation: 'CLOSE-ALL', csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(403);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/overrides/close-all — confirmation literal guard', () => {
  it('returns 400 when confirmation is missing', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when confirmation is the wrong literal', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { confirmation: 'close-all', csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when confirmation is "yes"', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { confirmation: 'yes', csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/overrides/close-all — happy path', () => {
  it('passes action_type=close_all + targetPair=null to executeOverride', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { confirmation: 'CLOSE-ALL', csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(executeOverrideSpy).toHaveBeenCalledTimes(1);
    const callArg = executeOverrideSpy.mock.calls[0]?.[0] as ExecuteOverrideInput;
    expect(callArg.actionType).toBe('close_all');
    expect(callArg.targetPair ?? null).toBe(null);
    expect(callArg.tenantId).toBe(1);
    expect(callArg.operatorUserId).toBe(42);
  });

  it('returns 200 with override_row_id', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { confirmation: 'CLOSE-ALL', csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; overrideRowId: number };
    expect(body.ok).toBe(true);
    expect(body.overrideRowId).toBe(5678);
  });
});
