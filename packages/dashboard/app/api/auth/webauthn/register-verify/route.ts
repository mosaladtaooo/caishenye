/**
 * POST /api/auth/webauthn/register-verify -- FR-023 D4 AC-023-2 step 2.
 *
 * Body: the browser's startRegistration response (RegistrationResponseJSON).
 * Reads the most-recent unconsumed register challenge for tenant 1, calls
 * verifyRegistrationResponse, on verified=true persists the credential row
 * + marks challenge consumed + mints the operator-session cookie. On
 * verified=false returns 400 with structured error.message.
 *
 * Node runtime (SimpleWebAuthn uses node:crypto).
 */

export const runtime = 'nodejs';

import { buildSetCookieHeader, mintOperatorCookie } from '@/lib/operator-session';
import { resolveRpId } from '@/lib/resolve-rp-id';
import { webauthnVerifyReg } from '@/lib/webauthn-server';
import {
  consumeChallenge,
  findLatestUnconsumedChallenge,
  insertCredential,
} from '@/lib/webauthn-store';

const TENANT_ID = 1;

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

  // Read challenge BEFORE calling SimpleWebAuthn so a missing / expired
  // / consumed challenge gives a clean 400 without a server-side throw.
  const now = new Date();
  const challengeRow = await findLatestUnconsumedChallenge(TENANT_ID, 'register', now);
  if (!challengeRow) {
    return jsonError(400, 'no matching challenge: register flow not initiated or expired');
  }
  if (challengeRow.expiresAt.getTime() < now.getTime()) {
    return jsonError(400, 'expired_challenge: please restart the registration flow');
  }
  if (challengeRow.consumedAt !== null) {
    return jsonError(400, 'consumed_challenge: please restart the registration flow');
  }

  let verification: Awaited<ReturnType<typeof webauthnVerifyReg>>;
  try {
    verification = await webauthnVerifyReg({
      response: body as Parameters<typeof webauthnVerifyReg>[0]['response'],
      expectedChallenge: challengeRow.challenge,
      expectedOrigin,
      expectedRPID: rpID,
    });
  } catch (e) {
    process.stderr.write(
      `[webauthn:register-verify] verify threw: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return jsonError(400, e instanceof Error ? e.message : 'verification failed');
  }

  if (!verification.verified || !verification.registrationInfo) {
    return jsonError(400, 'verification failed');
  }

  const { credential } = verification.registrationInfo;
  const transports = Array.isArray(
    (body as { response?: { transports?: unknown } }).response?.transports,
  )
    ? ((body as { response: { transports: string[] } }).response.transports as string[])
    : [];

  await insertCredential({
    tenantId: TENANT_ID,
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports,
  });
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
