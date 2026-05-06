/**
 * POST /api/auth/webauthn/authenticate-options -- FR-023 D4 AC-023-2 step 3.
 *
 * Generates PublicKeyCredentialRequestOptionsJSON for navigator.credentials.get.
 * Persists the challenge with purpose='authenticate' so the verify call can
 * retrieve and consume it.
 */

export const runtime = 'nodejs';

import { resolveRpId } from '@/lib/resolve-rp-id';
import { webauthnGenerateAuthOptions } from '@/lib/webauthn-server';
import { insertChallenge, listCredentialsForTenant } from '@/lib/webauthn-store';

const TENANT_ID = 1;
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

    const credentials = await listCredentialsForTenant(TENANT_ID);
    const allowCredentials = credentials.map((c) => ({
      id: c.credentialId,
      transports: (c.transports ?? []) as Array<
        'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'
      >,
    }));

    const options = await webauthnGenerateAuthOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
    });

    const now = new Date();
    await insertChallenge({
      tenantId: TENANT_ID,
      challenge: options.challenge,
      purpose: 'authenticate',
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    });

    return new Response(JSON.stringify(options), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    process.stderr.write(
      `[webauthn:authenticate-options] error: ${e instanceof Error ? e.message : String(e)}\n`,
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
