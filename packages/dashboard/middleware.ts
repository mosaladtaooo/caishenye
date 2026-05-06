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

export function middleware(req: NextRequest): NextResponse | undefined {
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

  // Auth check: read the session cookie. Auth.js v5 sets `__Secure-` or
  // `authjs.session-token` depending on protocol. We check both. If absent,
  // redirect to /login.
  const sessionCookie =
    req.cookies.get('__Secure-authjs.session-token')?.value ??
    req.cookies.get('authjs.session-token')?.value;
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Match all paths except static / image-optimization / Next internals.
  // The matcher is intentionally permissive so /api/* IS matched and we
  // can selectively exempt /api/auth + /api/cron in the body above.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
