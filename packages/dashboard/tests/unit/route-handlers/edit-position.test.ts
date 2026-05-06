/**
 * /api/overrides/edit-position — POST route handler tests.
 *
 * AC-016-3: Operator edits SL/TP on an open position by ticket → handler
 *           writes new SL/TP via MT5; R4 7-step flow.
 * AC-016-3-b (R6 CSRF): rejects without valid CSRF round-trip.
 *
 * Body shape: {ticket: number, sl: number, tp: number, csrf: string}
 *   - ticket is a positive integer (MT5 ticket ID)
 *   - sl + tp are non-negative numbers (price levels)
 *   - either or both may be sent; at least one must change vs current
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
  return new Request('https://app.local/api/overrides/edit-position', {
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
      overrideRowId: 7777,
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
  // FR-025 D3: auth resolver moved to lib/auth-js-session.
  vi.doMock('../../../lib/auth-js-session', () => ({
    resolveOperatorFromSession: vi.fn(async (sessionTok: string | undefined) => {
      if (sessionTok === undefined || sessionTok === '') return null;
      return { tenantId: 1, operatorUserId: 42 };
    }),
  }));
  vi.doMock('../../../lib/override-bind', () => ({
    resolveOperatorFromSession: vi.fn(async (sessionTok: string | undefined) => {
      if (sessionTok === undefined || sessionTok === '') return null;
      return { tenantId: 1, operatorUserId: 42 };
    }),
    buildOverrideDeps: vi.fn(
      (): ExecuteOverrideDeps => ({
        mt5ReadState: vi.fn(async () => ({ ticket: 12345, sl: 1.078, tp: 1.085 })),
        mt5Write: vi.fn(async () => ({
          ok: true as const,
          after: { ticket: 12345, sl: 1.07, tp: 1.09 },
        })),
        insertOverrideRow: vi.fn(async () => 999),
        updateOverrideRow: vi.fn(async () => undefined),
        sendTelegram: vi.fn(async () => undefined),
      }),
    ),
  }));
  return await import('../../../app/api/overrides/edit-position/route');
}

describe('POST /api/overrides/edit-position — auth + CSRF gates', () => {
  it('returns 401 when no session cookie', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ withSession: false, body: { ticket: 1, sl: 1, tp: 2 } }),
    );
    expect(res.status).toBe(401);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('AC-016-3-b: returns 403 with no CSRF cookie', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ withSession: true, body: { ticket: 1, sl: 1, tp: 2 } }),
    );
    expect(res.status).toBe(403);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('AC-016-3-b: returns 403 with wrong-secret HMAC', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const wrong = Buffer.alloc(32, 0x99).toString('hex');
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, wrong),
        body: { ticket: 1, sl: 1, tp: 2, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(403);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });

  it('AC-016-3-b: returns 403 when body csrf mismatches cookie token', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 1, sl: 1, tp: 2, csrf: 'b'.repeat(64) },
      }),
    );
    expect(res.status).toBe(403);
    expect(executeOverrideSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/overrides/edit-position — body validation', () => {
  it('returns 400 when ticket is missing', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { sl: 1, tp: 2, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when ticket is zero or negative', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 0, sl: 1, tp: 2, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when sl is a non-numeric string', async () => {
    // NaN serialises to null in JSON, so the only realistic over-the-wire
    // shape for a non-finite sl is a string that doesn't parse. The handler
    // must reject it.
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 12345, sl: 'oops', tp: 2, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when tp is negative', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 12345, sl: 1, tp: -2, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when both sl and tp are missing', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 12345, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/overrides/edit-position — happy path', () => {
  it('passes action_type=edit_sl_tp + targetTicket + paramsJson to executeOverride', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 12345, sl: 1.07, tp: 1.09, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(executeOverrideSpy).toHaveBeenCalledTimes(1);
    const callArg = executeOverrideSpy.mock.calls[0]?.[0] as ExecuteOverrideInput;
    expect(callArg.actionType).toBe('edit_sl_tp');
    expect(callArg.targetTicket).toBe(12345n);
    expect(callArg.paramsJson).toEqual({ ticket: 12345, sl: 1.07, tp: 1.09 });
  });

  it('accepts edit with only sl set', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 12345, sl: 1.07, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('accepts edit with only tp set', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { ticket: 12345, tp: 1.09, csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
  });
});
