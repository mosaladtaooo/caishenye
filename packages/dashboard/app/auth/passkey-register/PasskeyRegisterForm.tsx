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
import { useId, useState } from 'react';

export function PasskeyRegisterForm(): React.ReactElement {
  const emailInputId = useId();
  // Auth.js v5 Passkey provider requires a user identifier (email) at
  // registration time so the DrizzleAdapter can create the User row that
  // owns the new authenticator. v1 is single-user; default to a stable
  // local-realm email but let the operator type a real one if they prefer.
  const [email, setEmail] = useState('operator@caishen.v1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string | null>(null);

  const handleRegister = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDebug(`1/4 calling signIn(passkey, action=register, email=${email})...`);
    try {
      const result = await signIn('passkey', {
        action: 'register',
        email,
        redirectTo: '/',
      });
      setDebug(`done. result=${JSON.stringify(result).slice(0, 200)}`);
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <label
        htmlFor={emailInputId}
        style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: '#aaa' }}
      >
        Email (operator identity)
      </label>
      <input
        id={emailInputId}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
        style={{
          padding: '0.5rem 0.75rem',
          width: '100%',
          maxWidth: '24rem',
          background: '#0f1419',
          color: '#fff',
          border: '1px solid #2a5168',
          borderRadius: '4px',
          fontSize: '0.9rem',
          marginBottom: '1rem',
          fontFamily: 'monospace',
        }}
      />
      <br />
      <button
        type="button"
        onClick={handleRegister}
        disabled={busy || email.length === 0}
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
          ❌ {error}
        </p>
      )}
      {debug !== null && (
        <p
          style={{
            marginTop: '0.5rem',
            color: '#888',
            fontSize: '0.75rem',
            fontFamily: 'monospace',
          }}
        >
          {debug}
        </p>
      )}
    </div>
  );
}
