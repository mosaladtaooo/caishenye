/**
 * /api/overrides/replan — force re-plan POST handler.
 *
 * AC-018-1: kicks the Planner via POST /fire (Anthropic Routines API);
 *           operator can confirm low-cap via {confirm_low_cap: true}.
 * AC-018-2: in-flight pair_schedules rows for today are cancelled in Tx A;
 *           the new Planner one-off creates fresh rows in Tx B.
 * AC-018-2-b: a one-off scheduled to fire DURING the cleanup gap noops via
 *             the Executor pre-fire stale-check (verified separately in
 *             executor.test.ts).
 * AC-018-3: cap-confirm: when remaining slots <=2, the body must include
 *           {confirm_low_cap: true} (the dashboard surfaces a confirmation modal).
 *
 * R3-followup split-tx flow:
 *   Tx A — cancel old pair_schedules + insert in-flight routine_runs row
 *          (replan_orchestrator, success=null)
 *   External — POST to Planner routine /fire endpoint (NO DB tx open)
 *   Tx B — settle the audit row to status=completed + capture the new
 *          anthropic_one_off_id; on /fire failure, status=failed
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE_NAME } from '../../../lib/csrf';

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
  return new Request('https://app.local/api/overrides/replan', {
    method: 'POST',
    headers,
    body,
  });
}

let txASpy: ReturnType<typeof vi.fn>;
let firePlannerSpy: ReturnType<typeof vi.fn>;
let txBSpy: ReturnType<typeof vi.fn>;
let capRemainingSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AUTH_SECRET = TEST_AUTH_KEY;
  // Defaults — happy path
  txASpy = vi.fn(async () => ({ routineRunId: 333 }));
  firePlannerSpy = vi.fn(async () => ({
    ok: true as const,
    anthropicOneOffId: 'one-off-XYZ-123',
  }));
  txBSpy = vi.fn(async () => undefined);
  capRemainingSpy = vi.fn(async () => 5); // plenty of slots
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importRoute() {
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
  }));
  vi.doMock('../../../lib/replan-flow', () => ({
    txACancelAndAudit: txASpy,
    firePlannerRoutine: firePlannerSpy,
    txBSettleAudit: txBSpy,
    getCapRemainingSlots: capRemainingSpy,
  }));
  return await import('../../../app/api/overrides/replan/route');
}

describe('POST /api/overrides/replan — auth + CSRF gates', () => {
  it('returns 401 without session', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ body: {} }));
    expect(res.status).toBe(401);
    expect(txASpy).not.toHaveBeenCalled();
  });

  it('returns 403 without CSRF cookie', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ withSession: true, body: {} }));
    expect(res.status).toBe(403);
    expect(txASpy).not.toHaveBeenCalled();
  });

  it('returns 403 with mismatched CSRF', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: 'b'.repeat(64) },
      }),
    );
    expect(res.status).toBe(403);
    expect(txASpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/overrides/replan — AC-018-3 cap-confirm gate', () => {
  it('returns 409 when remaining cap slots <=2 and confirm_low_cap is missing', async () => {
    capRemainingSpy = vi.fn(async () => 2);
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string; capRemaining: number };
    expect(body.ok).toBe(false);
    expect(body.capRemaining).toBe(2);
    expect(body.error).toMatch(/confirm_low_cap|cap/i);
    expect(txASpy).not.toHaveBeenCalled();
  });

  it('returns 409 when cap=0 even with confirm_low_cap=true (out of slots is unconditional)', async () => {
    capRemainingSpy = vi.fn(async () => 0);
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken, confirm_low_cap: true },
      }),
    );
    expect(res.status).toBe(409);
    expect(txASpy).not.toHaveBeenCalled();
  });

  it('proceeds when remaining slots <=2 and confirm_low_cap is explicitly true', async () => {
    capRemainingSpy = vi.fn(async () => 2);
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken, confirm_low_cap: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(txASpy).toHaveBeenCalledTimes(1);
    expect(firePlannerSpy).toHaveBeenCalledTimes(1);
    expect(txBSpy).toHaveBeenCalledTimes(1);
  });

  it('proceeds without confirm when remaining slots > 2', async () => {
    capRemainingSpy = vi.fn(async () => 3);
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(txASpy).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/overrides/replan — R3 split-tx ordering (happy path)', () => {
  it('executes Tx A then external /fire then Tx B in that order', async () => {
    const order: string[] = [];
    txASpy = vi.fn(async () => {
      order.push('tx_a');
      return { routineRunId: 333 };
    });
    firePlannerSpy = vi.fn(async () => {
      order.push('fire');
      return { ok: true as const, anthropicOneOffId: 'one-off-XYZ-123' };
    });
    txBSpy = vi.fn(async () => {
      order.push('tx_b');
    });
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(order).toEqual(['tx_a', 'fire', 'tx_b']);
  });

  it('passes the Tx-A-returned routineRunId into Tx B and the /fire call', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    // Tx B receives the same routineRunId from Tx A + the anthropic id from /fire.
    const txBCallArg = txBSpy.mock.calls[0]?.[0];
    expect(txBCallArg).toEqual({
      routineRunId: 333,
      anthropicOneOffId: 'one-off-XYZ-123',
      success: true,
      errorMessage: null,
    });
  });

  it('returns 200 + JSON body with new anthropicOneOffId', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      routineRunId: number;
      anthropicOneOffId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.routineRunId).toBe(333);
    expect(body.anthropicOneOffId).toBe('one-off-XYZ-123');
  });
});

describe('POST /api/overrides/replan — failure modes', () => {
  it('Tx A fails → returns 500, /fire not called, Tx B not called', async () => {
    txASpy = vi.fn(async () => {
      throw new Error('postgres: connection refused (Tx A)');
    });
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(500);
    expect(firePlannerSpy).not.toHaveBeenCalled();
    expect(txBSpy).not.toHaveBeenCalled();
  });

  it('/fire fails → Tx B settles audit row to success=false; returns 502', async () => {
    firePlannerSpy = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'fire api 503',
    }));
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(502);
    // Tx B is still called — it settles the in-flight audit row to failed.
    expect(txBSpy).toHaveBeenCalledTimes(1);
    const txBCallArg = txBSpy.mock.calls[0]?.[0];
    expect(txBCallArg.success).toBe(false);
    expect(txBCallArg.errorMessage).toMatch(/fire api 503/);
    expect(txBCallArg.anthropicOneOffId ?? null).toBe(null);
  });

  it('/fire throws (network error) → Tx B settles audit to failed; returns 502', async () => {
    firePlannerSpy = vi.fn(async () => {
      throw new Error('fetch: ECONNRESET on /fire');
    });
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    expect(res.status).toBe(502);
    expect(txBSpy).toHaveBeenCalledTimes(1);
    const txBCallArg = txBSpy.mock.calls[0]?.[0];
    expect(txBCallArg.success).toBe(false);
    expect(txBCallArg.errorMessage).toMatch(/ECONNRESET/);
  });

  it('Tx B fails after successful /fire → response degrades to 500 but ok flag reflects /fire success', async () => {
    txBSpy = vi.fn(async () => {
      throw new Error('postgres: lost connection mid-Tx-B');
    });
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const res = await route.POST(
      buildReq({
        withSession: true,
        csrfCookie: signCookie(cookieToken, TEST_AUTH_KEY),
        body: { csrf: cookieToken },
      }),
    );
    // The /fire call DID succeed against Anthropic. But we couldn't update
    // our audit row. The orphan-detect cron will recover; we surface this
    // as a 500 to make the dashboard show a warning state.
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      anthropicOneOffId: string;
      stuckRowId: number;
    };
    expect(body.ok).toBe(false);
    // The /fire result is still surfaced so the dashboard can show "fire
    // succeeded but audit is stuck" — orphan-detect cron will reconcile.
    expect(body.anthropicOneOffId).toBe('one-off-XYZ-123');
    expect(body.stuckRowId).toBe(333);
  });
});

describe('POST /api/overrides/replan — body shape', () => {
  it('returns 400 on invalid JSON', async () => {
    const route = await importRoute();
    const cookieToken = 'a'.repeat(64);
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set(
      'cookie',
      `${SESSION_COOKIE_NAME}=${SESSION_VAL}; ${CSRF_COOKIE_NAME}=${signCookie(cookieToken, TEST_AUTH_KEY)}`,
    );
    const req = new Request('https://app.local/api/overrides/replan', {
      method: 'POST',
      headers,
      body: 'not json {{{',
    });
    const res = await route.POST(req);
    expect(res.status).toBe(400);
  });
});
