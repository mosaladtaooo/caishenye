/**
 * POST /api/auth/webauthn/register-options -- FR-023 D4 AC-023-2 step 1.
 *
 * Generates the PublicKeyCredentialCreationOptionsJSON the browser feeds
 * into navigator.credentials.create(...). Persists the challenge so the
 * subsequent register-verify call can retrieve and consume it.
 *
 * Node runtime (NOT Edge) -- SimpleWebAuthn server uses node:crypto.
 *
 * NFR-009: this route is INTENTIONALLY pre-auth (no resolveOperatorAuth).
 * It's how the operator becomes authenticated in the first place.
 *
 * CSRF: NOT applied. The challenge IS the anti-replay; the cookie isn't
 * minted until verify succeeds. See AC-023-2 contract text.
 */

export const runtime = 'nodejs';

import { resolveRpId } from '@/lib/resolve-rp-id';
import { webauthnGenerateRegOptions } from '@/lib/webauthn-server';
import { insertChallenge, listCredentialsForTenant } from '@/lib/webauthn-store';

const TENANT_ID = 1; // v1 single-tenant
const RP_NAME = '财神爷';
const USER_NAME = 'tao@belcort.com';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function POST(req: Request): Promise<Response> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return jsonError(415, 'unsupported_media_type: expected application/json');
  }

  try {
    let rpID: string;
    try {
      rpID = resolveRpId();
    } catch (e) {
      return jsonError(500, e instanceof Error ? e.message : String(e));
    }

    const existing = await listCredentialsForTenant(TENANT_ID);
    const excludeCredentials = existing.map((c) => ({
      id: c.credentialId,
      transports: (c.transports ?? []) as Array<
        'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'
      >,
    }));

    const options = await webauthnGenerateRegOptions({
      rpName: RP_NAME,
      rpID,
      userName: USER_NAME,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      excludeCredentials,
    });

    const now = new Date();
    await insertChallenge({
      tenantId: TENANT_ID,
      challenge: options.challenge,
      purpose: 'register',
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    });

    return new Response(JSON.stringify(options), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    process.stderr.write(
      `[webauthn:register-options] error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return jsonError(500, e instanceof Error ? e.message : 'internal error');
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
