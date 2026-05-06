'use client';

/**
 * OperatorTokenLoginForm — v1.1 KI-005 workaround login form.
 *
 * The operator pastes their INITIAL_REGISTRATION_TOKEN; we POST to
 * /api/auth/operator-login which validates + sets a signed session cookie.
 * On success, redirect to the operator's intended destination (?next=...)
 * or fallback to /.
 *
 * v1.2 replaces this with the proper SimpleWebAuthn passkey flow.
 */

import { useEffect, useId, useState } from 'react';

export function OperatorTokenLoginForm(): React.ReactElement {
  const tokenInputId = useId();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState('/');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const n = params.get('next');
    if (typeof n === 'string' && n.length > 0 && n.startsWith('/')) {
      setNext(n);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (token.trim().length === 0) {
      setError('Token required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/operator-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `login failed (HTTP ${r.status})`);
        setBusy(false);
        return;
      }
      // Cookie is set; navigate to the destination. Use full reload so the
      // server middleware re-evaluates with the new cookie present.
      window.location.href = next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: '1.5rem' }}>
      <label
        htmlFor={tokenInputId}
        style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.875rem', color: '#aaa' }}
      >
        INITIAL_REGISTRATION_TOKEN
      </label>
      <input
        id={tokenInputId}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        disabled={busy}
        autoComplete="current-password"
        style={{
          padding: '0.5rem 0.75rem',
          width: '100%',
          maxWidth: '32rem',
          background: '#0f1419',
          color: '#fff',
          border: '1px solid #2a5168',
          borderRadius: '4px',
          fontSize: '0.9rem',
          marginBottom: '1rem',
          fontFamily: 'monospace',
        }}
        placeholder="Paste from your .env.local INITIAL_REGISTRATION_TOKEN"
      />
      <br />
      <button
        type="submit"
        disabled={busy || token.trim().length === 0}
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
        {busy ? 'Signing in…' : 'Sign in with token'}
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
    </form>
  );
}
