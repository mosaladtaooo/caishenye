'use client';

/**
 * PasskeyRegisterForm — client component that triggers Auth.js v5 Passkey
 * provider registration flow.
 *
 * The server page (page.tsx) gates on INITIAL_REGISTRATION_TOKEN match and
 * only renders this form when the token is correct. This component then
 * calls Auth.js's `signIn('passkey', { action: 'register' })` which:
 *   1. Server-side: generates a WebAuthn challenge via the Passkey provider's
 *      challenge endpoint (/api/auth/webauthn-options/passkey)
 *   2. Client-side: calls navigator.credentials.create() with that challenge
 *      (the OS surfaces Windows Hello / Touch ID / hardware-key prompt)
 *   3. POST the resulting credential back to /api/auth/callback/passkey
 *   4. Auth.js creates the User + Authenticator records via the
 *      DrizzleAdapter, sets a session cookie, redirects to callbackUrl
 *
 * On success → redirect to / (dashboard root).
 * On error → show the error inline (most common: user cancelled the OS
 * prompt → "The operation either timed out or was not allowed").
 */

import { signIn } from 'next-auth/webauthn';
import { useState } from 'react';

export function PasskeyRegisterForm(): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Auth.js v5 Passkey provider: action='register' creates a new
      // credential. Without this flag, the default action is 'authenticate'
      // (which would fail since no passkey exists yet).
      await signIn('passkey', { action: 'register', redirectTo: '/' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <button
        type="button"
        onClick={handleRegister}
        disabled={busy}
        style={{
          padding: '0.6rem 1.4rem',
          background: busy ? '#444' : '#1d3a4a',
          color: '#fff',
          border: '1px solid #2a5168',
          borderRadius: '4px',
          cursor: busy ? 'wait' : 'pointer',
          fontSize: '1rem',
        }}
      >
        {busy ? 'Waiting for device…' : 'Register passkey'}
      </button>
      {error !== null && (
        <p
          style={{
            marginTop: '1rem',
            color: '#e88',
            fontSize: '0.875rem',
            fontFamily: 'monospace',
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
