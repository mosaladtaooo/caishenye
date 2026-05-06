/**
 * AC-023-6 -- Playwright virtualAuthenticator e2e for the FR-023 D4
 * SimpleWebAuthn register flow.
 *
 * The spec walks:
 *   1. Visit /auth/passkey-register?token=<INITIAL_REGISTRATION_TOKEN>
 *   2. Click "Register passkey"
 *   3. Chromium's CDP virtualAuthenticator handles
 *      navigator.credentials.create(...)
 *   4. /api/auth/webauthn/register-verify lands a webauthn_credentials row
 *   5. Set-Cookie sets caishen-operator-session
 *   6. Client redirects to /overview
 *
 * Run modes:
 *   - LOCAL: `bun --filter @caishen/dashboard run dev` then
 *            `bun --filter @caishen/dashboard run test:e2e`
 *            (uses E2E_BASE_URL=http://localhost:3000 default)
 *   - PREVIEW: set E2E_BASE_URL=https://preview-branch.vercel.app then
 *              `bun --filter @caishen/dashboard run test:e2e`
 *
 * Required env var at run time: E2E_REGISTRATION_TOKEN (the value the
 * dashboard accepts on the passkey-register gate). The spec FAILS HARD
 * if the env is missing rather than silently skipping -- you cannot
 * pretend a passkey flow worked without the gate token.
 */

import { expect, test } from '@playwright/test';

test.describe('FR-023 SimpleWebAuthn register e2e', () => {
  test('virtualAuthenticator -> credential row -> redirect /overview', async ({
    page,
    context,
  }) => {
    const registrationToken = process.env.E2E_REGISTRATION_TOKEN ?? '';
    if (registrationToken.length === 0) {
      throw new Error(
        'E2E_REGISTRATION_TOKEN is required for the passkey e2e spec. ' +
          'Export it from .env.local before running playwright test.',
      );
    }

    // Use Chrome DevTools Protocol to add a virtual authenticator. This
    // emulates a platform authenticator (e.g., laptop's Touch ID) so
    // navigator.credentials.create resolves with a real public-key cred.
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });

    await page.goto(`/auth/passkey-register?token=${encodeURIComponent(registrationToken)}`);
    await expect(page.getByRole('heading', { name: /register your passkey/i })).toBeVisible();

    const registerButton = page.getByRole('button', { name: /register passkey/i });
    await expect(registerButton).toBeEnabled();
    await registerButton.click();

    // After verify, the client navigates to /overview. Wait for the URL
    // change rather than a specific selector (overview content varies).
    await page.waitForURL(/\/overview/, { timeout: 15_000 });

    // Operator-session cookie should be present.
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'caishen-operator-session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
  });
});
