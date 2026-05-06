/**
 * POST /api/auth/webauthn/authenticate-verify -- FR-023 D4 AC-023-2 step 4.
 *
 * Body: browser's startAuthentication response (AuthenticationResponseJSON).
 * Reads the most-recent unconsumed authenticate challenge for tenant 1,
 * looks up the credential row, calls verifyAuthenticationResponse, on
 * verified=true bumps the counter + sets last_used_at + marks challenge
 * consumed + mints the operator-session cookie.
 *
 * EC-023-2 (R10): newCounter < stored.counter -> 401 + writeAuthAuditRow
 * with event_type='auth_counter_regression' and the column shape pinned by
 * the test (credential_id, stored_counter, attempted_counter, request_path).
 *
 * Node runtime.
 */

export const runtime = 'nodejs';

import { writeAuthAuditRow } from '@/lib/auth-audit';
import { buildSetCookieHeader, mintOperatorCookie } from '@/lib/operator-session';
import { resolveRpId } from '@/lib/resolve-rp-id';
import { webauthnVerifyAuth } from '@/lib/webauthn-server';
import {
  bumpCredentialCounter,
  consumeChallenge,
  findCredentialById,
  findLatestUnconsumedChallenge,
} from '@/lib/webauthn-store';

const TENANT_ID = 1;
const REQUEST_PATH = '/api/auth/webauthn/authenticate-verify';

export async function POST(req: Request): Promise<Response> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return jsonError(415, 'unsupported_media_type: expected application/json');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const credentialIdInBody =
    typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : '';
  if (credentialIdInBody.length === 0) {
    return jsonError(400, 'missing credential id in body');
  }

  let rpID: string;
  try {
    rpID = resolveRpId();
  } catch (e) {
    return jsonError(500, e instanceof Error ? e.message : String(e));
  }
  const expectedOrigin = process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN ?? '';
  if (expectedOrigin.length === 0) {
    return jsonError(500, 'NEXT_PUBLIC_DASHBOARD_ORIGIN missing');
  }

  const now = new Date();
  const challengeRow = await findLatestUnconsumedChallenge(TENANT_ID, 'authenticate', now);
  if (!challengeRow) {
    return jsonError(400, 'no matching challenge: authenticate flow not initiated or expired');
  }
  if (challengeRow.expiresAt.getTime() < now.getTime()) {
    return jsonError(400, 'expired_challenge: please restart the authentication flow');
  }
  if (challengeRow.consumedAt !== null) {
    return jsonError(400, 'consumed_challenge: please restart the authentication flow');
  }

  const storedCred = await findCredentialById(TENANT_ID, credentialIdInBody);
  if (!storedCred) {
    return jsonError(401, 'credential not registered for this tenant');
  }
  // EC-023-2 cousin: cross-tenant lookup defence (defence-in-depth on top of
  // the WHERE tenant_id in findCredentialById -- if the row somehow comes
  // back with a different tenant_id, refuse).
  if (storedCred.tenantId !== TENANT_ID) {
    return jsonError(401, 'tenant mismatch on credential lookup');
  }

  let verification: Awaited<ReturnType<typeof webauthnVerifyAuth>>;
  try {
    verification = await webauthnVerifyAuth({
      response: body as Parameters<typeof webauthnVerifyAuth>[0]['response'],
      expectedChallenge: challengeRow.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: storedCred.credentialId,
        // v13 typed publicKey as Uint8Array<ArrayBuffer>; coerce explicitly
        // since drizzle bytea returns generic Uint8Array<ArrayBufferLike>.
        publicKey: new Uint8Array(storedCred.publicKey),
        counter: storedCred.counter,
        transports: storedCred.transports as Array<
          'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'
        >,
      },
    });
  } catch (e) {
    process.stderr.write(
      `[webauthn:authenticate-verify] verify threw: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return jsonError(400, e instanceof Error ? e.message : 'verification failed');
  }

  if (!verification.verified || !verification.authenticationInfo) {
    return jsonError(400, 'verification failed');
  }

  const { newCounter } = verification.authenticationInfo;

  // EC-023-2 R10: counter regression check + audit row.
  if (newCounter < storedCred.counter) {
    await writeAuthAuditRow({
      event_type: 'auth_counter_regression',
      tenant_id: TENANT_ID,
      details_json: {
        credential_id: storedCred.credentialId,
        stored_counter: storedCred.counter,
        attempted_counter: newCounter,
        request_path: REQUEST_PATH,
      },
    });
    return jsonError(401, 'Counter regression detected -- possible replay attack');
  }

  await bumpCredentialCounter(storedCred.id, newCounter, now);
  await consumeChallenge(challengeRow.id);

  const cookieValue = await mintOperatorCookie();
  const isSecure = (req.headers.get('x-forwarded-proto') ?? 'https') === 'https';

  return new Response(JSON.stringify({ ok: true, redirect: '/overview' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': buildSetCookieHeader(cookieValue, isSecure),
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
