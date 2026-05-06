/**
 * webauthn-server -- thin v13 wrapper around @simplewebauthn/server.
 *
 * Mirrors the lib/mt5-server.ts shape: a small set of verb-named exports
 * the route handlers consume and the unit tests mock via vi.doMock. The
 * wrapper does NOT add business logic -- routes own challenge persistence,
 * tenant scoping, and audit-row shape. The wrapper IS the seam that lets
 * us pin the v13 argument shape in one place (per the v11 break we
 * upgraded past in package.json: 9.x -> 13.2.x).
 *
 * v13 reference (Context7 verified 2026-05-06):
 *   generateRegistrationOptions({ rpName, rpID, userName, userID?,
 *     residentKey, userVerification, attestationType, excludeCredentials })
 *   verifyRegistrationResponse({ response, expectedChallenge,
 *     expectedOrigin, expectedRPID })
 *   generateAuthenticationOptions({ rpID, allowCredentials, userVerification })
 *   verifyAuthenticationResponse({ response, expectedChallenge,
 *     expectedOrigin, expectedRPID, credential })  <-- 'credential', not
 *   'authenticator' (renamed in v11+; see WebAuthnCredential type).
 */

import {
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

export async function webauthnGenerateRegOptions(
  opts: GenerateRegistrationOptionsOpts,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions(opts);
}

export async function webauthnVerifyReg(
  opts: VerifyRegistrationResponseOpts,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse(opts);
}

export async function webauthnGenerateAuthOptions(
  opts: GenerateAuthenticationOptionsOpts,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions(opts);
}

export async function webauthnVerifyAuth(
  opts: VerifyAuthenticationResponseOpts,
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse(opts);
}
