/**
 * GET /api/internal/ffcal/today — DEPRECATED route tests (session 5g).
 *
 * Behaviour: still gated by INTERNAL_API_TOKEN bearer (so an unauthenticated
 * caller doesn't even learn whether the route exists), but always returns
 * 501 Not Implemented with a clear pointer to the MCP-connector path.
 *
 * Architectural note: the prior session-5e implementation forwarded to
 * ${FFCAL_BASE_URL}/today, which never existed because ForexFactory is an
 * MCP server, not an HTTP service. Live wire-up surfaced HTTP 404 from
 * upstream. See routines-architecture.md § FFCal.
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
  return await import('../../../app/api/internal/ffcal/today/route');
}

function buildReq(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/ffcal/today', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/internal/ffcal/today — auth gate (still enforced)', () => {
  it('returns 401 without bearer (does not leak deprecation status)', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(undefined));
    expect(res.status).toBe(401);
  });

  it('returns 500 when INTERNAL_API_TOKEN missing (constitution §15 LOUD)', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/internal/ffcal/today — DEPRECATED behaviour', () => {
  it('returns 501 Not Implemented for an authenticated caller', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(501);
  });

  it('error body points at the MCP-connector path', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/MCP connector/i);
    expect(body.error).toMatch(/ForexFactory/);
    expect(body.error).toMatch(/routines-architecture/);
  });

  it('does not perform any upstream fetch (no FFCAL_BASE_URL/FFCAL_BEARER_TOKEN read)', async () => {
    // Even without ffcal env set, the route must NOT 500 / NOT fetch.
    delete process.env.FFCAL_BASE_URL;
    delete process.env.FFCAL_BEARER_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const route = await importRoute();
    const res = await route.GET(buildReq(`Bearer ${fixtureBearer}`));
    expect(res.status).toBe(501);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
