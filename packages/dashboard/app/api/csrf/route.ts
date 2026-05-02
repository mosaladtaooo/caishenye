/**
 * GET /api/csrf — issues a CSRF token + signed cookie pair (R6).
 *
 * The client (override forms) calls this BEFORE every state-changing POST,
 * embeds the returned `token` in the request body, and the cookie ships
 * via the browser. The corresponding `/api/overrides/*` handlers run
 * `validateCsrf` to enforce the double-submit + HMAC primitive.
 *
 * Authenticated only — anonymous callers get 401 (the CSRF cookie is
 * meaningless without a session).
 *
 * Cookie attributes:
 *   __Host- prefix      → HTTPS-only, exact-origin, path=/
 *   httpOnly: true      → script can't read the cookie
 *   secure: true        → required by __Host- prefix
 *   sameSite: 'strict'  → defense-in-depth on top of CSRF token
 *   path: '/'           → required by __Host- prefix
 */

import { cookies } from 'next/headers';
import { CSRF_COOKIE_NAME, issueCsrfToken } from '@/lib/csrf';

export async function GET(): Promise<Response> {
  // Auth check — anonymous = 401. Wired against auth() once the auth
  // route handler initialises the NextAuth() factory; the scaffold's
  // session-cookie presence check mirrors what middleware.ts does.
  const cookieStore = await cookies();
  const sessionCookie =
    cookieStore.get('__Secure-authjs.session-token')?.value ??
    cookieStore.get('authjs.session-token')?.value;
  if (!sessionCookie) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const secret = process.env.AUTH_SECRET ?? '';
  if (secret.length === 0) {
    return new Response(JSON.stringify({ error: 'server misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { token, cookieValue } = issueCsrfToken(secret);

  cookieStore.set(CSRF_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  });

  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
