/**
 * Auth.js v5 catch-all route -- v1.2 FR-023 D4: Passkey provider DROPPED.
 *
 * v1.1 design used Auth.js v5 + the experimental Passkey (WebAuthn) provider,
 * which never worked end-to-end (KI-005). v1.2 replaces it with the four
 * /api/auth/webauthn/* routes built on @simplewebauthn v13 directly.
 *
 * This route is preserved (not deleted) because middleware imports the
 * Auth.js handler shape; removing the file would cascade through too many
 * places. It now:
 *   - keeps a Credentials provider stub that ALWAYS rejects
 *   - keeps DrizzleAdapter wired (existing user/account/session tables stay
 *     in v1.2 as zero-write dead-weight per clarify Q10; KI-011 tracks the
 *     v1.3 Drizzle drop)
 *   - returns the same 503 misconfig shape until env is provisioned
 *
 * Per AC-006 + NFR-009: still one of the few non-auth-gated paths the
 * middleware lets through (PUBLIC_PATHS includes /api/auth).
 *
 * INITIAL_REGISTRATION_TOKEN: now consumed by /api/auth/operator-login (the
 * EMERGENCY_TOKEN_LOGIN_ENABLED-flagged token-fallback path). The new
 * passkey flow has no equivalent gate -- the device IS the gate.
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
    const Credentials = (await import('next-auth/providers/credentials')).default;
    const { getTenantDb } = await import('@caishen/db/client');
    const tenantDb = getTenantDb(1);

    // v1.2 FR-023 D4: Passkey provider dropped. Credentials stub is kept
    // ONLY so middleware's import of the auth() handler doesn't break;
    // the authorize callback always returns null -> auth always fails
    // through this provider. Real auth flows through:
    //   /api/auth/webauthn/* (passkey)  AND
    //   /api/auth/operator-login (token fallback, AC-023-5 flagged)
    const { handlers } = NextAuth({
      adapter: DrizzleAdapter(tenantDb.drizzle),
      secret: authSecret,
      session: { strategy: 'database' },
      providers: [
        Credentials({
          name: 'caishen-disabled',
          credentials: {},
          async authorize() {
            return null;
          },
        }),
      ],
      pages: { signIn: '/login' },
      trustHost: true,
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
