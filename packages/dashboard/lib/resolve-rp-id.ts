/**
 * resolve-rp-id — per-env WebAuthn rpID resolver (FR-023 AC-023-2 / clarify Q6).
 *
 * Reads `process.env.VERCEL_ENV` to switch between three rpID values:
 *
 *   - 'production'  -> WEBAUTHN_RP_ID_PROD     (LOUD-fail per §15 if unset)
 *   - 'preview'     -> WEBAUTHN_RP_ID_PREVIEW  (LOUD-fail per §15 if unset)
 *   - 'development' -> WEBAUTHN_RP_ID_DEV      (default 'localhost')
 *   - undefined     -> treated as 'development' (matches `bun run dev` locally)
 *
 * The §15 LOUD-fail discipline (constitution): when an env var that is
 * required for security or correctness is missing in a deployed environment,
 * THROW with a message that names the env var AND a remediation path. The
 * preview-without-WEBAUTHN_RP_ID_PREVIEW case names BOTH the env var to set
 * AND the alternative `EMERGENCY_TOKEN_LOGIN_ENABLED` operator escape hatch.
 *
 * SimpleWebAuthn accepts 'localhost' without TLS per WebAuthn spec; that's
 * why dev defaults to localhost without erroring.
 *
 * No module-load-time env reads — env is read inside the function so unit
 * tests can stub VERCEL_ENV and friends per case without re-import.
 */

const PROD_RP_ID_ENV = 'WEBAUTHN_RP_ID_PROD';
const PREVIEW_RP_ID_ENV = 'WEBAUTHN_RP_ID_PREVIEW';
const DEV_RP_ID_ENV = 'WEBAUTHN_RP_ID_DEV';
const DEV_DEFAULT = 'localhost';

/**
 * Resolve the rpID string for SimpleWebAuthn options + verify calls.
 * Throws (LOUD §15) if a required env var is missing in prod / preview.
 */
export function resolveRpId(): string {
  const env = process.env.VERCEL_ENV ?? 'development';

  if (env === 'production') {
    const v = process.env[PROD_RP_ID_ENV] ?? '';
    if (v.length === 0) {
      throw new Error(
        `resolve-rp-id: ${PROD_RP_ID_ENV} is not set in production. ` +
          `Set it via 'vercel env add ${PROD_RP_ID_ENV} production' to the bare hostname (no protocol, no path).`,
      );
    }
    return v;
  }

  if (env === 'preview') {
    const v = process.env[PREVIEW_RP_ID_ENV] ?? '';
    if (v.length === 0) {
      throw new Error(
        `resolve-rp-id: ${PREVIEW_RP_ID_ENV} is not set in preview. ` +
          `Set it per-branch via 'vercel env add ${PREVIEW_RP_ID_ENV} preview', OR ` +
          `disable passkeys in preview by setting EMERGENCY_TOKEN_LOGIN_ENABLED=true ` +
          `(operator falls back to token login).`,
      );
    }
    return v;
  }

  // development (or unset) — default to localhost so local `bun run dev` works.
  const v = process.env[DEV_RP_ID_ENV] ?? '';
  return v.length === 0 ? DEV_DEFAULT : v;
}
