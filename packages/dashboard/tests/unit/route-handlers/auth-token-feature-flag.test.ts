/**
 * AC-023-5 -- EMERGENCY_TOKEN_LOGIN_ENABLED feature-flag tests for the
 * v1.1 token-cookie fallback (POST /api/auth/operator-login).
 *
 * Lifecycle (clarify Q5):
 *   - default 'true' (or unset) -> route accepts requests as before
 *   - explicit 'false'          -> route returns 404 Not Found
 *
 * The contract is the env var, NOT the request body. We assert on each
 * env state regardless of body shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let originalAuthSecret: string | undefined;
let originalRegistrationToken: string | undefined;
let originalFlag: string | undefined;

beforeEach(() => {
  originalAuthSecret = process.env.AUTH_SECRET;
  originalRegistrationToken = process.env.INITIAL_REGISTRATION_TOKEN;
  originalFlag = process.env.EMERGENCY_TOKEN_LOGIN_ENABLED;

  process.env.AUTH_SECRET = 'a'.repeat(64);
  process.env.INITIAL_REGISTRATION_TOKEN = 'tok-' + 'b'.repeat(60);
});

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
  if (originalRegistrationToken === undefined) delete process.env.INITIAL_REGISTRATION_TOKEN;
  else process.env.INITIAL_REGISTRATION_TOKEN = originalRegistrationToken;
  if (originalFlag === undefined) delete process.env.EMERGENCY_TOKEN_LOGIN_ENABLED;
  else process.env.EMERGENCY_TOKEN_LOGIN_ENABLED = originalFlag;
});

function buildLoginReq(body: unknown): Request {
  return new Request('https://test.local/api/auth/operator-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/operator-login — EMERGENCY_TOKEN_LOGIN_ENABLED', () => {
  it("flag='true' -> route accepts request (200 on token match)", async () => {
    process.env.EMERGENCY_TOKEN_LOGIN_ENABLED = 'true';
    const { POST } = await import('../../../app/api/auth/operator-login/route');
    const res = await POST(buildLoginReq({ token: process.env.INITIAL_REGISTRATION_TOKEN }));
    expect(res.status).toBe(200);
  });

  it("flag unset -> safe-default 'true' -> route accepts request (200 on token match)", async () => {
    delete process.env.EMERGENCY_TOKEN_LOGIN_ENABLED;
    const { POST } = await import('../../../app/api/auth/operator-login/route');
    const res = await POST(buildLoginReq({ token: process.env.INITIAL_REGISTRATION_TOKEN }));
    expect(res.status).toBe(200);
  });

  it("flag='false' -> route returns 404 regardless of body / token correctness", async () => {
    process.env.EMERGENCY_TOKEN_LOGIN_ENABLED = 'false';
    const { POST } = await import('../../../app/api/auth/operator-login/route');
    const res = await POST(buildLoginReq({ token: process.env.INITIAL_REGISTRATION_TOKEN }));
    expect(res.status).toBe(404);
  });

  it("flag='false' -> 404 even with wrong token (route is gone, not denying)", async () => {
    process.env.EMERGENCY_TOKEN_LOGIN_ENABLED = 'false';
    const { POST } = await import('../../../app/api/auth/operator-login/route');
    const res = await POST(buildLoginReq({ token: 'wrong' }));
    expect(res.status).toBe(404);
  });
});
