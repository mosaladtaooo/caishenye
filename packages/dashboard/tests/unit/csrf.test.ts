/**
 * R6 CSRF helper — unit tests with algorithm-pinning fixtures.
 *
 * Constraint per contract negotiation Round 3:
 *   primitive = HMAC-SHA256(AUTH_SECRET, token)
 *   transport = `__Host-` prefixed cookie with the signed token; submitted
 *               token comes back in the JSON body of the POST request.
 *   double-submit pattern: cookie token === body token === HMAC-verifiable
 *
 * AC-016-1-b / -2-b / -3-b cover the route-handler integration in Playwright.
 * THIS file pins the cryptographic primitive itself: any contributor who
 * substitutes a weaker scheme (e.g., concat-hash, MD5, or a wrong secret)
 * fails this gate.
 *
 * The 8 cases cover:
 *   1. issueCsrfToken returns a token + signed-cookie-value pair
 *   2. validateCsrf accepts a valid (token, cookieValue) pair
 *   3. validateCsrf REJECTS a wrong AUTH_SECRET
 *   4. validateCsrf REJECTS a Round-2 broken `sha256(secret + token)` concat
 *      signature (algorithm-pinning)
 *   5. validateCsrf REJECTS a body-token / cookie-token mismatch
 *   6. validateCsrf REJECTS a missing cookie (undefined input)
 *   7. validateCsrf REJECTS a malformed cookie (no signature delimiter)
 *   8. issueCsrfToken returns at least 32 bytes of token entropy
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueCsrfToken, validateCsrf } from '../../lib/csrf';

const SECRET_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SECRET_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('R6 CSRF — issueCsrfToken', () => {
  it('returns a {token, cookieValue} pair', () => {
    const out = issueCsrfToken(SECRET_A);
    expect(typeof out.token).toBe('string');
    expect(typeof out.cookieValue).toBe('string');
    expect(out.token.length).toBeGreaterThan(0);
    expect(out.cookieValue.length).toBeGreaterThan(0);
  });

  it('token is at least 32 bytes (>=64 hex chars)', () => {
    const { token } = issueCsrfToken(SECRET_A);
    // 32 bytes hex == 64 chars
    expect(token.length).toBeGreaterThanOrEqual(64);
  });

  it('successive calls produce different tokens (entropy check)', () => {
    const a = issueCsrfToken(SECRET_A);
    const b = issueCsrfToken(SECRET_A);
    expect(a.token).not.toBe(b.token);
  });
});

describe('R6 CSRF — validateCsrf accepts valid pairs', () => {
  it('accepts a freshly issued (token, cookieValue) pair', () => {
    const { token, cookieValue } = issueCsrfToken(SECRET_A);
    const result = validateCsrf({
      submittedToken: token,
      cookieValue,
      secret: SECRET_A,
    });
    expect(result.valid).toBe(true);
  });
});

describe('R6 CSRF — algorithm-pinning rejections', () => {
  it('REJECTS a wrong-secret HMAC (cookie was signed by a different AUTH_SECRET)', () => {
    const { token, cookieValue } = issueCsrfToken(SECRET_A);
    const result = validateCsrf({
      submittedToken: token,
      cookieValue,
      secret: SECRET_B, // wrong key — must reject
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature|hmac|verify/i);
  });

  it('REJECTS a Round-2-broken sha256(secret+token) concat-hash signature', () => {
    // The Round-2 proposal originally used sha256 over concat. Round 3
    // moved to HMAC-SHA256. This test PINS the algorithm: a fake
    // "cookie value" produced by the broken concat scheme MUST be
    // rejected by validateCsrf.
    const { token } = issueCsrfToken(SECRET_A);
    const brokenSig = createHash('sha256')
      .update(SECRET_A + token, 'utf8')
      .digest('hex');
    const brokenCookie = `${token}.${brokenSig}`;

    const result = validateCsrf({
      submittedToken: token,
      cookieValue: brokenCookie,
      secret: SECRET_A,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature|hmac|verify/i);
  });

  it('confirms HMAC-SHA256(secret, token) is the signature primitive — happy path', () => {
    // The inverse of the algorithm-pinning test: prove the implementation
    // accepts a manually-constructed cookie value that uses the EXACT
    // documented primitive. Catches code that silently switched primitives.
    const { token } = issueCsrfToken(SECRET_A);
    const expectedSig = createHmac('sha256', SECRET_A).update(token, 'utf8').digest('hex');
    const handCraftedCookie = `${token}.${expectedSig}`;

    const result = validateCsrf({
      submittedToken: token,
      cookieValue: handCraftedCookie,
      secret: SECRET_A,
    });
    expect(result.valid).toBe(true);
  });
});

describe('R6 CSRF — double-submit consistency rejections', () => {
  it('REJECTS when submittedToken !== the token embedded in cookieValue', () => {
    const { token, cookieValue } = issueCsrfToken(SECRET_A);
    const result = validateCsrf({
      submittedToken: `${token}-tampered`,
      cookieValue,
      secret: SECRET_A,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mismatch|token/i);
  });
});

describe('R6 CSRF — input shape rejections', () => {
  it('REJECTS missing cookie (undefined cookieValue)', () => {
    const result = validateCsrf({
      submittedToken: 'whatever',
      cookieValue: undefined,
      secret: SECRET_A,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing|cookie/i);
  });

  it('REJECTS empty submittedToken', () => {
    const { cookieValue } = issueCsrfToken(SECRET_A);
    const result = validateCsrf({
      submittedToken: '',
      cookieValue,
      secret: SECRET_A,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing|empty|token/i);
  });

  it('REJECTS a malformed cookieValue with no delimiter', () => {
    const result = validateCsrf({
      submittedToken: 'abc',
      cookieValue: 'no-dot-separator-at-all',
      secret: SECRET_A,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/format|malformed|delim/i);
  });

  it('REJECTS missing AUTH_SECRET (defense — never run unconfigured)', () => {
    const { token, cookieValue } = issueCsrfToken(SECRET_A);
    expect(() =>
      validateCsrf({
        submittedToken: token,
        cookieValue,
        secret: '',
      }),
    ).toThrow(/secret/i);
  });
});
