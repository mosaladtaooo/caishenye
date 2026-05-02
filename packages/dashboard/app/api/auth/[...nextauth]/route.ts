/**
 * Auth.js v5 catch-all route handler.
 *
 * NextAuth() factory call wires the GET + POST handlers automatically. The
 * provider list (WebAuthn/Passkey) is added here because the WebAuthn
 * provider's deps are heavy and we want the bundle isolated to this route.
 *
 * Note: this is the structural skeleton — the full provider list (Passkey
 * with operator's INITIAL_REGISTRATION_TOKEN gate) is wired in M3 step 18
 * when the design bundle ships and we can render the registration flow.
 */

// The actual factory call lives in lib/auth.ts → buildAuthConfig. Here we
// expose the handlers Next.js looks for (GET + POST). For the M3 scaffold
// we ship a minimal pass-through that lets the dashboard build but defers
// the live Auth.js wire-up to step 18 (post Spike 3 — the operator needs
// AUTH_URL after the first Vercel preview deploy).

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ error: 'auth wire-up pending Spike 3' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(): Promise<Response> {
  return new Response(JSON.stringify({ error: 'auth wire-up pending Spike 3' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}
