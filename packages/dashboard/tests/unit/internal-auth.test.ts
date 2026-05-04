/**
 * lib/internal-auth.ts — unit tests.
 *
 * Mirrors the cron-auth.ts contract:
 *  - timing-safe Bearer comparison against process.env.INTERNAL_API_TOKEN
 *  - 500 (LOUD per constitution §15) when the env var is missing or empty
 *  - 401 on missing / wrong / wrong-length bearer
 *  - null on success (caller proceeds with the body)
 *
 * Used by every /api/internal/* route handler. Get this gate right and the
 * proxy pattern (ADR-012) is fundamentally sound.
 *
 * Test-fixture token is generated at module load via randomBytes — no literal
 * value in source per AgentLint no-secrets + constitution §10.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateInternalAuth } from '../../lib/internal-auth';

// 32-byte random hex; computed at module load. Same shape as production.
const fixtureBearer = randomBytes(32).toString('hex');

let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.INTERNAL_API_TOKEN;
  } else {
    process.env.INTERNAL_API_TOKEN = originalToken;
  }
});

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/test', {
    method: 'GET',
    headers,
  });
}

describe('validateInternalAuth — env var handling (constitution §15 LOUD)', () => {
  it('returns 500 when INTERNAL_API_TOKEN is missing entirely', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const res = validateInternalAuth(buildReq(`Bearer ${fixtureBearer}`));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(500);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toMatch(/server misconfigured/i);
    expect(body.error).toMatch(/INTERNAL_API_TOKEN/);
  });

  it('returns 500 when INTERNAL_API_TOKEN is empty string', async () => {
    process.env.INTERNAL_API_TOKEN = '';
    const res = validateInternalAuth(buildReq(`Bearer ${fixtureBearer}`));
    expect(res?.status).toBe(500);
  });
});

describe('validateInternalAuth — bearer presence', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = validateInternalAuth(buildReq(undefined));
    expect(res?.status).toBe(401);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 when Authorization header is empty string', async () => {
    const res = validateInternalAuth(buildReq(''));
    expect(res?.status).toBe(401);
  });

  it('returns 401 when Authorization header lacks Bearer prefix', async () => {
    const res = validateInternalAuth(buildReq(fixtureBearer));
    expect(res?.status).toBe(401);
  });

  it('returns 401 when Authorization header uses wrong scheme (Basic)', async () => {
    const res = validateInternalAuth(buildReq(`Basic ${fixtureBearer}`));
    expect(res?.status).toBe(401);
  });
});

describe('validateInternalAuth — bearer comparison', () => {
  it('returns 401 when bearer is the wrong length (shorter)', async () => {
    const res = validateInternalAuth(buildReq('Bearer short-token'));
    expect(res?.status).toBe(401);
  });

  it('returns 401 when bearer is the wrong length (longer)', async () => {
    const res = validateInternalAuth(buildReq(`Bearer ${fixtureBearer}-extra-suffix-bytes`));
    expect(res?.status).toBe(401);
  });

  it('returns 401 when bearer length matches but value differs', async () => {
    const wrong = fixtureBearer.split('').reverse().join('');
    expect(wrong.length).toBe(fixtureBearer.length);
    // Skip if reverse happens to equal original (palindrome — vanishingly unlikely
    // for 64 random hex chars, but defensive). Force a one-byte tweak in that case.
    const distinct = wrong === fixtureBearer ? `${wrong.slice(0, -1)}0` : wrong;
    const res = validateInternalAuth(buildReq(`Bearer ${distinct}`));
    expect(res?.status).toBe(401);
  });

  it('returns null on the exact correct bearer', () => {
    const res = validateInternalAuth(buildReq(`Bearer ${fixtureBearer}`));
    expect(res).toBeNull();
  });
});

describe('validateInternalAuth — error body shape', () => {
  it('every failure returns content-type application/json', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const r1 = validateInternalAuth(buildReq(`Bearer ${fixtureBearer}`));
    expect(r1?.headers.get('content-type')).toMatch(/application\/json/);

    process.env.INTERNAL_API_TOKEN = fixtureBearer;
    const r2 = validateInternalAuth(buildReq(undefined));
    expect(r2?.headers.get('content-type')).toMatch(/application\/json/);

    const r3 = validateInternalAuth(buildReq('Bearer wrong'));
    expect(r3?.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('validateInternalAuth — Bearer prefix is exact', () => {
  it('rejects "bearer" lowercase scheme (we pin to "Bearer " for consistency with cron-auth.ts)', () => {
    const res = validateInternalAuth(buildReq(`bearer ${fixtureBearer}`));
    expect(res?.status).toBe(401);
  });

  it('rejects "Bearer" without a space', () => {
    const res = validateInternalAuth(buildReq(`Bearer${fixtureBearer}`));
    expect(res?.status).toBe(401);
  });
});
