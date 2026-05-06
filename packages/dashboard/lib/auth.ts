/**
 * v1.2 FR-023 D4: Auth.js v5 reduced to a Credentials stub.
 *
 * Passkey provider DROPPED. The four /api/auth/webauthn/* routes built on
 * @simplewebauthn v13 are now the canonical passkey path. Token fallback
 * lives at /api/auth/operator-login behind EMERGENCY_TOKEN_LOGIN_ENABLED.
 *
 * NFR-009: middleware still routes through verifyOperatorCookie + the
 * shared resolveOperatorAuth helper; this module is purely the shape
 * helper that the surviving [...nextauth] route consumes.
 *
 * INITIAL_REGISTRATION_TOKEN: now consumed by /api/auth/operator-login.
 *
 * The Auth.js v5 NextAuth() factory still exposes:
 *   handlers: { GET, POST }  -- for app/api/auth/[...nextauth]/route.ts
 *   auth                      -- server-side session check (kept for shape)
 *
 * Wire-up entry point still depends on operator-supplied env (AUTH_SECRET);
 * runtime initialiser is exported here, factory call happens lazily on
 * first import.
 */

// NOTE: structural skeleton only. The actual NextAuth() factory call lives
// in app/api/auth/[...nextauth]/route.ts. v1.2 reduces the providers list
// to a single Credentials stub that always returns null -- middleware
// still works because resolveOperatorAuth handles the operator-cookie path
// independently.

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
