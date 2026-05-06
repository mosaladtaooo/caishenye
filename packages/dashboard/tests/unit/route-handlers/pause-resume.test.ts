/**
 * /api/overrides/pause + /api/overrides/resume — POST handlers.
 *
 * AC-017-1: agent_state row has paused_bool=true after pause; false after resume.
 * AC-017-2: Planner + Executor pre-fire stale-checks see paused_bool=true and noop.
 * AC-017-3: Pause cancels not-yet-fired one-offs (sets pair_schedules.status='cancelled').
 * AC-017-4: Resume re-enables; if today's window has not yet been Planned,
 *           the next /api/overrides/replan is the way back.
 *
 * Tests focus on the route handler's flow (auth + CSRF + R4 7-step delegation).
 * Behavior of pause cancelling pair_schedules + setting agent_state lives in
 * the override-bind verb closures (mt5Write); we verify the route passes
 * the right action_type ('pause' | 'resume') to the engine.
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

function buildReq(opts: {
  url: string;
  body?: unknown;
  csrfCookie?: string;
  withSession?: boolean;
}): Request {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : '{}';
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  const cookieParts: string[] = [];
  if (opts.withSession) cookieParts.push(`${SESSION_COOKIE_NAME}=${SESSION_VAL}`);
  if (opts.csrfCookie !== undefined) cookieParts.push(`${CSRF_COOKIE_NAME}=${opts.csrfCookie}`);
  if (cookieParts.length > 0) headers.set('cookie', cookieParts.join('; '));
  return new Request(opts.url, { method: 'POST', headers, body });
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
      overrideRowId: 4242,
    }),
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importPause() {
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
        mt5ReadState: vi.fn(async () => ({ paused: false })),
        mt5Write: vi.fn(async () => ({ ok: true as const, after: { paused: true } })),
        insertOverrideRow: vi.fn(async () => 999),
        updateOverrideRow: vi.fn(async () => undefined),
        sendTelegram: vi.fn(async () => undefined),
      }),
    ),
  }));
  return await import('../../../app/api/overrides/pause/route');
}

async function importResume() {
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
        mt5ReadState: vi.fn(async () => ({ paused: true })),
        mt5Write: vi.fn(async () => ({ ok: true as const, after: { paused: false } })),
        insertOverrideRow: vi.fn(async () => 999),
        updateOverrideRow: vi.fn(async () => undefined),
        sendTelegram: vi.fn(async () => undefined),
      }),
    ),
  }));
  return await import('../../../app/api/overrides/resume/route');
}

const PAUSE_URL = 'https://app.local/api/overrides/pause';
const RESUME_URL = 'https://app.local/api/overrides/resume';

describe('POST /api/overrides/pause — auth + CSRF gates', () => {
  it('returns 401 without session', async () => {
    const route = await importPause();
    const res = await route.POST(buildReq({ url: PAUSE_URL, body: {} }));
    expect(res.status).toBe(401);
  });

  it('returns 403 without CSRF cookie', async () => {
    const route = await importPause();
    const res = await route.POST(buildReq({ url: PAUSE_URL, withSession: true, body: {} }));
    expect(res.status).toBe(403);
  });

  it('returns 403 with mismatched CSRF', async () => {
    const route = await importPause();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        url: PAUSE_URL,
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: 'b'.repeat(64) },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/overrides/pause — happy path', () => {
  it('passes action_type=pause to executeOverride and returns 200', async () => {
    const route = await importPause();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        url: PAUSE_URL,
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(executeOverrideSpy).toHaveBeenCalledTimes(1);
    const callArg = executeOverrideSpy.mock.calls[0]?.[0] as ExecuteOverrideInput;
    expect(callArg.actionType).toBe('pause');
    expect(callArg.targetPair ?? null).toBe(null);
  });
});

describe('POST /api/overrides/resume — auth + CSRF gates', () => {
  it('returns 401 without session', async () => {
    const route = await importResume();
    const res = await route.POST(buildReq({ url: RESUME_URL, body: {} }));
    expect(res.status).toBe(401);
  });

  it('returns 403 without CSRF cookie', async () => {
    const route = await importResume();
    const res = await route.POST(buildReq({ url: RESUME_URL, withSession: true, body: {} }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/overrides/resume — happy path', () => {
  it('passes action_type=resume to executeOverride and returns 200', async () => {
    const route = await importResume();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        url: RESUME_URL,
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(executeOverrideSpy).toHaveBeenCalledTimes(1);
    const callArg = executeOverrideSpy.mock.calls[0]?.[0] as ExecuteOverrideInput;
    expect(callArg.actionType).toBe('resume');
  });
});
