/**
 * /login — Auth.js v5 + WebAuthn passkey sign-in.
 *
 * The actual sign-in form lives client-side because passkey ceremony
 * requires `navigator.credentials`. This file is the route container; the
 * form component renders after hydration.
 */

export default function LoginPage(): React.ReactElement {
  return (
    <main style={{ padding: '2rem', maxWidth: '32rem' }}>
      <h1>Sign in</h1>
      <p>Tap your device to authenticate with your passkey.</p>
      <noscript>
        <p style={{ color: 'red' }}>Passkey sign-in requires JavaScript.</p>
      </noscript>
      {/* PasskeySignInForm placeholder — full client component lands in
          M3 step 18 once the design bundle ships. */}
    </main>
  );
}
