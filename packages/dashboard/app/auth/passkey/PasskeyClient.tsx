'use client';

/**
 * AC-023-3 -- shared client component used by both:
 *   /auth/passkey-register (mode='register')
 *   /auth/login            (mode='authenticate')
 *
 * Calls @simplewebauthn/browser v13's:
 *   - startRegistration({ optionsJSON })  -- v11+ argument shape
 *   - startAuthentication({ optionsJSON }) -- v11+ argument shape
 *
 * On success: redirects to /overview.
 * On failure: surfaces a structured error message (no Auth.js Configuration
 * opaqueness).
 *
 * The component fetches options from the corresponding /api/auth/webauthn/*
 * route, hands them to the browser SDK, and POSTs the SDK response back to
 * the matching verify endpoint. The verify endpoint sets the
 * caishen-operator-session cookie via Set-Cookie; the redirect is then
 * authenticated by the dashboard middleware.
 */

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type PasskeyMode = 'register' | 'authenticate';

interface PasskeyClientProps {
  mode: PasskeyMode;
}

const ROUTES = {
  register: {
    options: '/api/auth/webauthn/register-options',
    verify: '/api/auth/webauthn/register-verify',
    label: 'Register passkey',
    busyLabel: 'Waiting for device...',
  },
  authenticate: {
    options: '/api/auth/webauthn/authenticate-options',
    verify: '/api/auth/webauthn/authenticate-verify',
    label: 'Sign in with passkey',
    busyLabel: 'Waiting for device...',
  },
};

export function PasskeyClient({ mode }: PasskeyClientProps): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const optsRes = await fetch(ROUTES[mode].options, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!optsRes.ok) {
        const body = await safeJson(optsRes);
        throw new Error(body?.error ?? `options endpoint returned ${optsRes.status}`);
      }
      const options = await optsRes.json();

      const sdkResponse =
        mode === 'register'
          ? await startRegistration({ optionsJSON: options })
          : await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch(ROUTES[mode].verify, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sdkResponse),
      });
      if (!verifyRes.ok) {
        const body = await safeJson(verifyRes);
        throw new Error(body?.error ?? `verify endpoint returned ${verifyRes.status}`);
      }
      const verifyJson = (await verifyRes.json()) as { ok?: boolean; redirect?: string };
      const redirectTo =
        typeof verifyJson.redirect === 'string' && verifyJson.redirect.length > 0
          ? verifyJson.redirect
          : '/overview';
      router.push(redirectTo);
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <button
        type="button"
        onClick={handle}
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
        {busy ? ROUTES[mode].busyLabel : ROUTES[mode].label}
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

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
