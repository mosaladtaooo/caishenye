'use client';

/**
 * v1.2 FR-023 D4 -- PasskeyRegisterForm rewritten for SimpleWebAuthn direct.
 *
 * Auth.js v5 path is dropped; the form now consumes the shared PasskeyClient
 * with mode='register'. The page (page.tsx) still gates on
 * INITIAL_REGISTRATION_TOKEN ?token= match before this client component
 * renders; the actual passkey registration goes through:
 *   POST /api/auth/webauthn/register-options  -> PublicKeyCredentialCreationOptionsJSON
 *   navigator.credentials.create(...)
 *   POST /api/auth/webauthn/register-verify   -> Set-Cookie + 200 + redirect /overview
 *
 * On success, the verify endpoint sets caishen-operator-session and the
 * client navigates to /overview.
 */

import { PasskeyClient } from '../passkey/PasskeyClient';

export function PasskeyRegisterForm(): React.ReactElement {
  return <PasskeyClient mode="register" />;
}
