/**
 * POST /api/internal/anthropic/schedule — DEPRECATED route tests (v1.1 ADR-013).
 *
 * Behaviour: still gated by INTERNAL_API_TOKEN bearer (so unauthenticated
 * callers don't even learn whether the route exists), but always returns
 * 501 Not Implemented with a clear pointer to the cron-pivot architecture.
 *
 * Architectural note: the prior implementation forwarded to Anthropic
 * /v1/routines/{id}/schedule, which never existed (verified via
 * docs.code.claude.com/routines — Anthropic exposes no programmatic
 * /schedule API; the CLI's `/schedule tomorrow at 9am, ...` is web-UI
 * mediated). Live wire-up surfaced HTTP 502 from upstream 404. See
 * progress/decisions.md ADR-013 for the cron-pivot rationale.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  vi.restoreAllMocks();
});

async function importRoute() {
  return await import('../../../app/api/internal/anthropic/schedule/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/anthropic/schedule', {
    method: 'POST',
    headers,
    body: JSON.stringify({ routine: 'executor', fire_at_iso: '2026-05-05T13:00:00Z', body: {} }),
  });
}

describe('POST /api/internal/anthropic/schedule — auth gate (still enforced)', () => {
  it('returns 401 without bearer (does not leak deprecation status)', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq(undefined));
    expect(res.status).toBe(401);
  });

  it('returns 500 when INTERNAL_API_TOKEN missing (constitution §15 LOUD)', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/internal/anthropic/schedule — DEPRECATED behaviour (v1.1 ADR-013)', () => {
  it('returns 501 Not Implemented for an authenticated caller', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(501);
  });

  it('error body points at the cron-pivot architecture', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`));
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cron tick/i);
    expect(body.error).toMatch(/fire-due-executors/);
    expect(body.error).toMatch(/ADR-013/);
  });

  it('does not perform any upstream fetch (no Anthropic call)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const route = await importRoute();
    const res = await route.POST(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(501);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
