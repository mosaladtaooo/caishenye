/**
 * /login — Auth.js v5 + WebAuthn passkey sign-in.
 *
 * Bare terminal-style. The actual passkey ceremony renders client-side
 * because navigator.credentials.get is required; for the server-rendered
 * route we present the prompt + a button that the client-component
 * replaces post-hydration.
 */

export default function LoginPage(): React.ReactElement {
  return (
    <main style={{ maxWidth: '32rem' }}>
      <div className="page-head">
        <h1>Sign in</h1>
        <span className="meta">passkey · webauthn</span>
      </div>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Tap your device to authenticate.
      </p>
      <noscript>
        <p className="error">Passkey sign-in requires JavaScript.</p>
      </noscript>
      {/* Client passkey form replaces this stub on hydration. */}
      <button type="button" className="btn btn-primary" disabled>
        Authenticate with passkey
      </button>
      <p className="subtle" style={{ marginTop: '2rem' }}>
        First-time setup uses /auth/passkey-register with the operator-issued
        INITIAL_REGISTRATION_TOKEN.
      </p>
    </main>
  );
}
