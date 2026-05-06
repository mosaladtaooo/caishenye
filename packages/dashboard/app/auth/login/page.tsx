/**
 * /auth/login -- v1.2 FR-023 D4 SimpleWebAuthn login page.
 *
 * Drives navigator.credentials.get(...) via the shared PasskeyClient with
 * mode='authenticate'. On success, the verify endpoint sets the
 * caishen-operator-session cookie and the client redirects to /overview.
 *
 * Distinct from /login (which is the v1.1 token-fallback page) -- the
 * v1.1 page survives behind EMERGENCY_TOKEN_LOGIN_ENABLED and the
 * dashboard banner suggests flipping it once both passkeys are stable.
 */

import { PasskeyLoginForm } from './PasskeyLoginForm';

export default function PasskeyLoginPage(): React.ReactElement {
  return (
    <main style={{ padding: '2rem', maxWidth: '32rem' }}>
      <h1>Sign in with passkey</h1>
      <p>Use the device you registered to authenticate.</p>
      <PasskeyLoginForm />
    </main>
  );
}
