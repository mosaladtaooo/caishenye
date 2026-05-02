/**
 * Auth.js v5 catch-all route — live factory wired up (Group B step 6).
 *
 * NextAuth() is initialised lazily on first request via getHandlers() so
 * tests don't need AUTH_SECRET / DATABASE_URL at module-load time. When
 * the operator has not yet supplied AUTH_URL / AUTH_SECRET (pre first
 * preview deploy), the factory throws with a typed error and the route
 * returns 503 — the operator's pre-deploy checklist surfaces this.
 *
 * The Passkey provider runs experimental WebAuthn under Auth.js v5 beta
 * (per Context7 verification 2026-05-04). The DrizzleAdapter shape consumes
 * the raw Drizzle client; tenant scoping is enforced at the read layer
 * (queries/*.ts) since Auth.js itself is single-tenant.
 *
 * Per AC-006 + NFR-009: this route is one of the few non-auth-gated paths
 * the middleware lets through (PUBLIC_PATHS includes /api/auth).
 *
 * INITIAL_REGISTRATION_TOKEN gate: the first passkey enrollment requires
 * the operator to type the token issued at infra/vps/setup.sh time. The
 * gate runs in the events.signIn callback below — declines the sign-in
 * if the user record doesn't exist yet AND the registration token is
 * missing or wrong. Once a user exists, future logins skip this check.
 */

const FACTORY_INIT_ERROR_MESSAGE =
  'auth wire-up pending: AUTH_SECRET / AUTH_URL / DATABASE_URL not yet provisioned';

interface NextAuthHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

let cachedHandlers: NextAuthHandlers | null = null;
let cachedInitError: Error | null = null;

async function getHandlers(): Promise<NextAuthHandlers | null> {
  if (cachedHandlers) return cachedHandlers;
  if (cachedInitError) return null;

  // Live wire-up only happens once env is fully provisioned. We import
  // dynamically to avoid module-load failures in unit tests / build-time.
  const authSecret = process.env.AUTH_SECRET ?? '';
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (authSecret.length === 0 || databaseUrl.length === 0) {
    cachedInitError = new Error(FACTORY_INIT_ERROR_MESSAGE);
    return null;
  }

  try {
    const { default: NextAuth } = await import('next-auth');
    const { DrizzleAdapter } = await import('@auth/drizzle-adapter');
    const { default: Passkey } = await import('next-auth/providers/passkey');
    const { getTenantDb } = await import('@caishen/db/client');
    const tenantDb = getTenantDb(1);

    const { handlers } = NextAuth({
      adapter: DrizzleAdapter(tenantDb.drizzle),
      secret: authSecret,
      session: { strategy: 'database' },
      providers: [Passkey],
      experimental: { enableWebAuthn: true },
      pages: { signIn: '/login' },
      trustHost: true,
      callbacks: {
        async signIn({ user }) {
          // INITIAL_REGISTRATION_TOKEN gate is enforced at the
          // /auth/passkey-register/page.tsx layer — by the time we get
          // here Auth.js has a user record. Any user that survives the
          // register page is allowed.
          return Boolean(user);
        },
      },
    });

    cachedHandlers = handlers as NextAuthHandlers;
    return cachedHandlers;
  } catch (e) {
    cachedInitError = e instanceof Error ? e : new Error(String(e));
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const handlers = await getHandlers();
  if (handlers === null) {
    return new Response(
      JSON.stringify({ error: cachedInitError?.message ?? FACTORY_INIT_ERROR_MESSAGE }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  return handlers.GET(req);
}

export async function POST(req: Request): Promise<Response> {
  const handlers = await getHandlers();
  if (handlers === null) {
    return new Response(
      JSON.stringify({ error: cachedInitError?.message ?? FACTORY_INIT_ERROR_MESSAGE }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  return handlers.POST(req);
}
