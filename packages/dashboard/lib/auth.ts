/**
 * Auth.js v5 + DrizzleAdapter + WebAuthn (Passkey) provider.
 *
 * NFR-009: every dashboard route is auth-gated. The middleware (middleware.ts)
 * uses auth() to redirect unauthenticated requests; route handlers re-verify
 * via auth() before any state-changing action.
 *
 * INITIAL_REGISTRATION_TOKEN gates the FIRST passkey enrollment; once a
 * user is registered, subsequent auth uses passkey-only.
 *
 * The Auth.js v5 NextAuth() factory exposes:
 *   handlers: { GET, POST }  — for app/api/auth/[...nextauth]/route.ts
 *   auth                      — server-side session check (used in
 *                                middleware + route handlers + RSC layout)
 *   signIn / signOut          — programmatic helpers (used in /login)
 *
 * Wire-up entry point depends on operator-supplied env (AUTH_SECRET +
 * INITIAL_REGISTRATION_TOKEN); the runtime initialiser is exported here
 * but the actual NextAuth() factory call happens lazily on first import
 * to avoid module-load-time env reads.
 */

// NOTE: This file is the structural skeleton. The Auth.js v5 NextAuth()
// factory call lives in app/api/auth/[...nextauth]/route.ts where Next.js
// can wire the handlers automatically. This module exposes the typed
// configuration that route.ts consumes.

import type { NextAuthConfig } from 'next-auth';
import type { Adapter } from 'next-auth/adapters';

/** Read env at runtime (NOT module-load) so tests don't need them. */
export function readAuthEnv(): {
  authSecret: string;
  initialRegistrationToken: string;
  authUrl: string | undefined;
} {
  const authSecret = process.env.AUTH_SECRET ?? '';
  const initialRegistrationToken = process.env.INITIAL_REGISTRATION_TOKEN ?? '';
  if (authSecret.length === 0) {
    throw new Error('auth: AUTH_SECRET missing in env');
  }
  if (initialRegistrationToken.length === 0) {
    throw new Error('auth: INITIAL_REGISTRATION_TOKEN missing in env');
  }
  return {
    authSecret,
    initialRegistrationToken,
    authUrl: process.env.AUTH_URL,
  };
}

/**
 * Build the Auth.js v5 config. Caller is the route handler — it constructs
 * the DrizzleAdapter on its side (the adapter requires a live `db` client).
 */
export function buildAuthConfig(adapter: Adapter, secret: string): NextAuthConfig {
  return {
    adapter,
    secret,
    session: { strategy: 'database' },
    // Provider list is added by the route handler — the WebAuthn provider's
    // import is dynamic to avoid pulling its dependencies into shared
    // bundles (it only runs in the auth route).
    providers: [],
    pages: {
      signIn: '/login',
    },
    trustHost: true,
  };
}
