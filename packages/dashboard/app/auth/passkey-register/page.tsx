/**
 * /auth/passkey-register — first-time passkey enrollment, gated by
 * INITIAL_REGISTRATION_TOKEN.
 *
 * Per FR-006 + ADR-004: the operator runs `infra/vps/setup.sh` which
 * generates an INITIAL_REGISTRATION_TOKEN env var (one-time-use; rotated
 * after the first user enrolls). Visiting this page without a matching
 * `?token=...` query param OR with a wrong token shows a 403-equivalent
 * "registration closed" message.
 *
 * Once the token matches, the page surfaces the passkey enrollment form
 * (a client component that calls `navigator.credentials.create` via the
 * Auth.js Passkey provider's challenge endpoint).
 *
 * After the first user is enrolled, the operator MUST rotate
 * INITIAL_REGISTRATION_TOKEN (or set it to a value that will never be
 * supplied) so subsequent visits to this page can no longer enroll. The
 * dashboard's User Management page (out of v1 scope) is the path for
 * adding more users post first-enrollment.
 */

import { PasskeyRegisterForm } from './PasskeyRegisterForm';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function PasskeyRegisterPage(props: PageProps): Promise<React.ReactElement> {
  const params = await props.searchParams;
  const supplied = typeof params.token === 'string' ? params.token : '';
  const expected = process.env.INITIAL_REGISTRATION_TOKEN ?? '';

  // Loud failure for misconfig (no token in env).
  if (expected.length === 0) {
    return (
      <main style={{ padding: '2rem', maxWidth: '32rem' }}>
        <h1>Registration closed</h1>
        <p style={{ color: '#888' }}>
          INITIAL_REGISTRATION_TOKEN is not set. Run <code>infra/vps/setup.sh</code> on the VPS to
          generate one.
        </p>
      </main>
    );
  }

  // Constant-time-ish compare. Equal length first, then byte-equal.
  if (supplied.length !== expected.length || supplied !== expected) {
    return (
      <main style={{ padding: '2rem', maxWidth: '32rem' }}>
        <h1>Registration closed</h1>
        <p style={{ color: '#888' }}>
          This URL requires a one-time registration token. If you are the operator, retrieve it from
          the output of <code>infra/vps/setup.sh</code>.
        </p>
      </main>
    );
  }

  // Token matches — show enrollment form.
  return (
    <main style={{ padding: '2rem', maxWidth: '32rem' }}>
      <h1>Register your passkey</h1>
      <p>
        Use the device you want to authenticate with. After this enrolment, the registration token
        becomes single-use; rotate it via <code>infra/vps/setup.sh</code> for subsequent users.
      </p>
      <PasskeyRegisterForm />
    </main>
  );
}
