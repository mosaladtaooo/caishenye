/**
 * R6 CSRF helper — HMAC-SHA256 double-submit-cookie pattern.
 *
 * Why double-submit-cookie + HMAC and not just an opaque cookie?
 *   - The Auth.js v5 session cookie is `__Host-` httpOnly + signed; we don't
 *     want CSRF to require parsing or trusting that cookie's session-id.
 *   - Double-submit + HMAC means: server issues a random token, signs it
 *     into the `__Host-csrf` cookie. The client also gets the raw token in
 *     the JSON response of GET /api/csrf and submits it back in the POST
 *     body. The server validates BOTH that the body token matches the cookie
 *     token AND that the cookie's HMAC verifies under AUTH_SECRET.
 *   - HMAC over a random token > sha256(concat) — concat-hash is vulnerable
 *     to length-extension on Merkle-Damgård constructions when the secret
 *     is prepended.
 *
 * Public API:
 *   issueCsrfToken(secret) → {token, cookieValue}    (called by GET /api/csrf)
 *   validateCsrf({submittedToken, cookieValue, secret}) → {valid, reason?}
 *
 * The cookie format is `${token}.${hmac_hex}`. Caller (route handler)
 * sets it via `cookieStore.set('__Host-csrf', cookieValue, {
 *   httpOnly: true, secure: true, sameSite: 'strict', path: '/' })`.
 *
 * `__Host-` prefix is required by browsers to: (a) only accept the cookie
 * over HTTPS, (b) require `path=/`, (c) forbid `domain=` so it's bound to
 * the exact origin.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface IssuedCsrf {
  /** Raw token (returned to the client to embed in POST body). */
  token: string;
  /** Signed cookie value: `${token}.${hmac_hex}`. */
  cookieValue: string;
}

export interface ValidateCsrfInput {
  submittedToken: string;
  cookieValue: string | undefined;
  secret: string;
}

export interface ValidateCsrfResult {
  valid: boolean;
  reason?: string;
}

/**
 * Issue a fresh token + the corresponding signed cookie value.
 *
 * Pure crypto — caller writes the cookie via next/headers' cookieStore.set
 * with `__Host-` prefix + httpOnly + secure + sameSite=strict + path=/.
 */
export function issueCsrfToken(secret: string): IssuedCsrf {
  if (!secret || secret.length === 0) {
    throw new Error('csrf: AUTH_SECRET missing — refusing to issue token');
  }
  // 32 bytes (256 bits) of token entropy. Any narrowing is a step backwards.
  const token = randomBytes(32).toString('hex');
  const sig = createHmac('sha256', secret).update(token, 'utf8').digest('hex');
  return { token, cookieValue: `${token}.${sig}` };
}

/**
 * Validate a submitted token against its cookie counterpart.
 *
 * Returns `{valid: true}` only if all three conditions hold:
 *   1. cookieValue is defined and contains exactly one '.' delimiter
 *   2. submittedToken === the token embedded in cookieValue (double-submit)
 *   3. HMAC-SHA256(secret, embeddedToken) === embeddedSig (algorithm-pinned)
 *
 * Comparisons use `timingSafeEqual` for the HMAC step to avoid timing
 * oracles. The double-submit step is a string equality on a random opaque
 * token — no timing concern there.
 */
export function validateCsrf(input: ValidateCsrfInput): ValidateCsrfResult {
  if (!input.secret || input.secret.length === 0) {
    throw new Error('csrf: AUTH_SECRET missing — refusing to validate');
  }
  if (input.cookieValue === undefined || input.cookieValue.length === 0) {
    return { valid: false, reason: 'missing cookie' };
  }
  if (!input.submittedToken || input.submittedToken.length === 0) {
    return { valid: false, reason: 'empty submitted token' };
  }
  const dotIdx = input.cookieValue.indexOf('.');
  if (dotIdx <= 0 || dotIdx === input.cookieValue.length - 1) {
    return { valid: false, reason: 'malformed cookie format (no signature delimiter)' };
  }
  const embeddedToken = input.cookieValue.slice(0, dotIdx);
  const embeddedSig = input.cookieValue.slice(dotIdx + 1);

  // Step 2: double-submit consistency.
  if (embeddedToken !== input.submittedToken) {
    return { valid: false, reason: 'submitted token does not match cookie token (mismatch)' };
  }

  // Step 3: algorithm-pinned HMAC verification.
  const expectedSig = createHmac('sha256', input.secret)
    .update(embeddedToken, 'utf8')
    .digest('hex');

  if (expectedSig.length !== embeddedSig.length) {
    return { valid: false, reason: 'invalid signature length (hmac verify)' };
  }
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(expectedSig, 'hex');
    bufB = Buffer.from(embeddedSig, 'hex');
  } catch {
    return { valid: false, reason: 'invalid signature encoding (hmac verify)' };
  }
  if (bufA.length !== bufB.length) {
    return { valid: false, reason: 'invalid signature length (hmac verify)' };
  }
  if (!timingSafeEqual(bufA, bufB)) {
    return { valid: false, reason: 'signature does not verify (hmac)' };
  }

  return { valid: true };
}

/** Cookie name used by the route handler when setting the cookie. */
export const CSRF_COOKIE_NAME = '__Host-csrf';
