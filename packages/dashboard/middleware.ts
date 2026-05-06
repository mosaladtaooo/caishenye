/**
 * Auth-gating middleware. NFR-009: every dashboard route is auth-protected.
 *
 * Public exceptions:
 *   - /login (Auth.js sign-in page)
 *   - /auth/passkey-register (FIRST-TIME passkey enrollment; INITIAL_REGISTRATION_TOKEN-gated;
 *     pre-auth by definition — operator has no session yet)
 *   - /api/auth/* (Auth.js handlers, including the WebAuthn challenge endpoints
 *     called by /auth/passkey-register's client component)
 *   - /api/cron/* (CRON_SECRET-gated; auth() does not apply)
 *   - /api/internal/* (INTERNAL_API_TOKEN-gated per ADR-012; auth() does not apply)
 *
 * The middleware redirects unauthenticated requests to /login; route
 * handlers re-verify via auth() (or validateInternalAuth / validateCronAuth)
 * before any state-changing action so a tampered cookie can't slip through
 * if the middleware is bypassed.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { OPERATOR_COOKIE_NAME, verifyOperatorCookie } from './lib/operator-session';

const PUBLIC_PATHS = [
  '/login',
  '/auth/passkey-register',
  '/api/auth',
  '/api/cron',
  '/api/internal',
  // Static next assets — implicit, but listing for clarity.
  '/_next',
  '/favicon.ico',
];

export async function middleware(req: NextRequest): Promise<NextResponse | undefined> {
  const { pathname } = req.nextUrl;

  // Public paths: pass through.
  for (const p of PUBLIC_PATHS) {
    if (pathname === p || pathname.startsWith(`${p}/`)) {
      return NextResponse.next();
    }
  }

  // Cron secret enforcement happens INSIDE each /api/cron/* handler — we
  // don't gate at middleware because Vercel's cron infra hits the route
  // directly with its bearer.

  // Auth check: try v1.1 operator-session cookie first (KI-005 workaround
  // for broken Auth.js v5 WebAuthn beta). Fall back to legacy Auth.js cookie
  // if v1.2 ships the proper SimpleWebAuthn flow on top of Auth.js again.
  const operatorCookie = req.cookies.get(OPERATOR_COOKIE_NAME)?.value;
  if (typeof operatorCookie === 'string' && (await verifyOperatorCookie(operatorCookie))) {
    return NextResponse.next();
  }

  const authJsCookie =
    req.cookies.get('__Secure-authjs.session-token')?.value ??
    req.cookies.get('authjs.session-token')?.value;
  if (typeof authJsCookie === 'string' && authJsCookie.length > 0) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Match all paths except static / image-optimization / Next internals.
  // The matcher is intentionally permissive so /api/* IS matched and we
  // can selectively exempt /api/auth + /api/cron in the body above.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
