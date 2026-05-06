/**
 * POST /api/auth/operator-login — token-based operator login.
 *
 * v1.1 KI-005 workaround for the broken Auth.js v5 WebAuthn beta. The
 * operator POSTs { token: INITIAL_REGISTRATION_TOKEN } and receives a
 * signed session cookie. Single-user, single-tenant — the token IS the
 * authentication factor. v1.2 replaces this with SimpleWebAuthn passkeys.
 *
 * Body: { token: string }.
 * Response:
 *   - 200 { ok: true } with Set-Cookie on success
 *   - 401 { error } on token mismatch
 *   - 500 { error } on misconfig (AUTH_SECRET or INITIAL_REGISTRATION_TOKEN missing)
 *
 * Security:
 *   - Constant-time token compare (prevent timing attack)
 *   - Cookie is HttpOnly + Secure (HTTPS) + SameSite=Lax
 *   - 7-day expiration
 *   - HMAC-SHA256 signed using AUTH_SECRET — tampering detected at verify
 */

import { buildSetCookieHeader, constantTimeEq, mintOperatorCookie } from '@/lib/operator-session';

interface LoginBody {
  token?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const expectedToken = process.env.INITIAL_REGISTRATION_TOKEN ?? '';
  const authSecret = process.env.AUTH_SECRET ?? '';
  if (expectedToken.length === 0 || authSecret.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          'operator-login: server misconfigured (INITIAL_REGISTRATION_TOKEN or AUTH_SECRET missing)',
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const body = raw as LoginBody;
  const supplied = typeof body?.token === 'string' ? body.token : '';
  if (supplied.length === 0) {
    return new Response(JSON.stringify({ error: 'token field required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!constantTimeEq(supplied, expectedToken)) {
    return new Response(JSON.stringify({ error: 'token mismatch' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const cookieValue = await mintOperatorCookie();
  const isSecure = (req.headers.get('x-forwarded-proto') ?? 'https') === 'https';

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': buildSetCookieHeader(cookieValue, isSecure),
    },
  });
}
