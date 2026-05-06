/**
 * Operator session — HMAC-signed cookie for v1 single-user dashboard auth.
 *
 * v1.1 KI-005 workaround: Auth.js v5 WebAuthn beta has integration issues
 * (see KI-005 in progress/known-issues.md). This module ships an alternative
 * auth path that works TODAY: the operator visits /login, types their
 * INITIAL_REGISTRATION_TOKEN, and gets a signed cookie that the dashboard
 * middleware accepts.
 *
 * Properties:
 *   - HMAC-SHA256 signed using AUTH_SECRET (same secret Auth.js v5 used)
 *   - 7-day expiration
 *   - HttpOnly + Secure + SameSite=Lax — matches Auth.js's session cookie security
 *   - Single-user: there's only ever one operator identity; the cookie carries
 *     a fixed `sub` value
 *
 * Edge-runtime safe: uses Web Crypto API (crypto.subtle) instead of
 * node:crypto so it works in the Next.js middleware (which runs on Edge by
 * default on Vercel) AND in API route handlers (which run on Node).
 *
 * Threat model:
 *   - Stolen INITIAL_REGISTRATION_TOKEN → can sign in. Same risk as Auth.js's
 *     passkey flow (a stolen passkey = same outcome). Mitigation: rotate the
 *     token after first login + treat .env.local with care.
 *   - Stolen cookie → can act as operator until expiry. Same as any session
 *     cookie. Mitigation: HttpOnly prevents XSS theft; HTTPS prevents MITM.
 *   - Brute-force the token → 64-hex-char tokens have 256 bits of entropy;
 *     not feasible. Constant-time compare prevents timing attacks.
 *
 * v1.2: replace with SimpleWebAuthn direct (KI-005 resolution path 2).
 */

export const OPERATOR_COOKIE_NAME = 'caishen-operator-session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const OPERATOR_SUBJECT = 'caishen-operator-v1';

interface OperatorSessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

function readSecret(): string {
  const s = process.env.AUTH_SECRET ?? '';
  if (s.length === 0) {
    throw new Error('operator-session: AUTH_SECRET missing in env');
  }
  return s;
}

function base64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecodeToString(s: string): string {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

function base64urlDecodeToBytes(s: string): Uint8Array {
  const decoded = base64urlDecodeToString(s);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) out[i] = decoded.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signHmac(payload: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64urlEncode(new Uint8Array(sig));
}

async function verifyHmac(payload: string, sig: string, secret: string): Promise<boolean> {
  try {
    const key = await importHmacKey(secret);
    return await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecodeToBytes(sig) as BufferSource,
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

/** Constant-time string compare. Prevents timing-attack token-leak. */
export function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Mint a fresh operator session cookie value.
 * Caller is responsible for setting it via Set-Cookie with proper flags.
 */
export async function mintOperatorCookie(now: Date = new Date()): Promise<string> {
  const secret = readSecret();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload: OperatorSessionPayload = { sub: OPERATOR_SUBJECT, iat, exp };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = await signHmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify an operator session cookie value. Returns true if signature is
 * valid AND not expired. Returns false on any tampering / expiry / missing
 * fields. Async because Web Crypto signing is async.
 */
export async function verifyOperatorCookie(
  cookieValue: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof cookieValue !== 'string' || cookieValue.length === 0) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  if (typeof payloadB64 !== 'string' || typeof sig !== 'string') return false;

  let secret: string;
  try {
    secret = readSecret();
  } catch {
    return false;
  }

  const sigOk = await verifyHmac(payloadB64, sig, secret);
  if (!sigOk) return false;

  let payload: OperatorSessionPayload;
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadB64)) as OperatorSessionPayload;
  } catch {
    return false;
  }

  if (typeof payload.sub !== 'string' || payload.sub !== OPERATOR_SUBJECT) return false;
  if (typeof payload.exp !== 'number') return false;
  const nowSec = Math.floor(now.getTime() / 1000);
  if (payload.exp <= nowSec) return false;

  return true;
}

/** Cookie attributes for Set-Cookie. */
export function buildSetCookieHeader(value: string, isSecure: boolean): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_SECONDS}`];
  if (isSecure) flags.push('Secure');
  return `${OPERATOR_COOKIE_NAME}=${value}; ${flags.join('; ')}`;
}

export function buildClearCookieHeader(isSecure: boolean): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure) flags.push('Secure');
  return `${OPERATOR_COOKIE_NAME}=; ${flags.join('; ')}`;
}
