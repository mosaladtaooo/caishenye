/**
 * /login — operator sign-in.
 *
 * v1.1 KI-005: Auth.js v5 WebAuthn beta is broken (see KI-005 in
 * progress/known-issues.md). The "Authenticate with passkey" button is
 * disabled and labeled DEFERRED; the actual login path is the
 * INITIAL_REGISTRATION_TOKEN form below it. Single-user, single-tenant —
 * the token IS the auth factor for v1.1.
 *
 * v1.2 replaces this with the proper SimpleWebAuthn passkey flow.
 */

import { OperatorTokenLoginForm } from './OperatorTokenLoginForm';

export default function LoginPage(): React.ReactElement {
  return (
    <main style={{ maxWidth: '40rem' }}>
      <div className="page-head">
        <h1>Sign in</h1>
        <span className="meta">v1.1 token · passkey deferred</span>
      </div>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Sign in with your <code>INITIAL_REGISTRATION_TOKEN</code> from <code>.env.local</code>.
      </p>
      <noscript>
        <p className="error">Sign-in requires JavaScript.</p>
      </noscript>

      <OperatorTokenLoginForm />

      <hr style={{ marginTop: '2.5rem', borderColor: '#222' }} />
      <details style={{ marginTop: '1rem' }}>
        <summary
          style={{
            cursor: 'pointer',
            color: '#888',
            fontSize: '0.875rem',
          }}
        >
          About passkey sign-in (deferred to v1.2)
        </summary>
        <p className="subtle" style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
          Auth.js v5 WebAuthn passkey integration is in beta and has known issues; see{' '}
          <code>progress/known-issues.md</code> KI-005. The v1.2 plan is to replace
          next-auth/webauthn with a direct SimpleWebAuthn implementation. Until then, the token form
          above is the working sign-in path.
        </p>
      </details>
    </main>
  );
}
