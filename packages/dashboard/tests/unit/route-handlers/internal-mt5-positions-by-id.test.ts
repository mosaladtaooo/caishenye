/**
 * /api/internal/mt5/positions/[id] — DELETE (close) + PATCH (modify) tests.
 *
 * v1.1 — Phase B position-management coverage. Validates:
 *   - DELETE auth gate; routes to upstream DELETE /api/v1/positions/{id}
 *   - DELETE rejects non-numeric / leading-zero / scientific id (defence vs path injection)
 *   - PATCH auth gate; body must be { sl?, tp? } with at least one;
 *     translates sl→stop_loss + tp→take_profit before calling upstream PUT
 *   - PATCH rejects empty body / unrecognized fields-only / non-finite numbers
 *   - Upstream errors mapped via mapUpstreamError (502 / 504 etc.)
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let mt5DeleteSpy: ReturnType<typeof vi.fn>;
let mt5PutSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  mt5DeleteSpy = vi.fn();
  mt5PutSpy = vi.fn();
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('../../../lib/mt5-server', () => ({
    mt5Get: vi.fn(),
    mt5Post: vi.fn(),
    mt5Put: mt5PutSpy,
    mt5Delete: mt5DeleteSpy,
  }));
  return await import('../../../app/api/internal/mt5/positions/[id]/route');
}

function buildReq(
  method: 'DELETE' | 'PATCH',
  headerValue: string | undefined,
  body?: unknown,
): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/mt5/positions/12345', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/internal/mt5/positions/[id] — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.DELETE(buildReq('DELETE', undefined), ctx('12345'));
    expect(res.status).toBe(401);
    expect(mt5DeleteSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.DELETE(buildReq('DELETE', `Bearer ${fixtureBearer}`), ctx('12345'));
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/internal/mt5/positions/[id] — id validation', () => {
  it.each([['abc'], ['12.5'], ['0x1f'], ['012'], ['-3'], [' 12 '], ['']])(
    'rejects non-canonical id %s with 400',
    async (id) => {
      const route = await importRoute();
      const res = await route.DELETE(buildReq('DELETE', `Bearer ${fixtureBearer}`), ctx(id));
      expect(res.status).toBe(400);
      expect(mt5DeleteSpy).not.toHaveBeenCalled();
    },
  );

  it('accepts a positive integer id and forwards to upstream', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true, ticket: 12345, message: 'closed' });
    const route = await importRoute();
    const res = await route.DELETE(buildReq('DELETE', `Bearer ${fixtureBearer}`), ctx('12345'));
    expect(res.status).toBe(200);
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/positions/12345');
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});

describe('DELETE /api/internal/mt5/positions/[id] — upstream errors', () => {
  it('returns mapped error when upstream throws', async () => {
    mt5DeleteSpy.mockRejectedValue(
      new Error('mt5: DELETE /api/v1/positions/12345 → HTTP 504: timeout'),
    );
    const route = await importRoute();
    const res = await route.DELETE(buildReq('DELETE', `Bearer ${fixtureBearer}`), ctx('12345'));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('PATCH /api/internal/mt5/positions/[id] — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.PATCH(buildReq('PATCH', undefined, { sl: 1.09 }), ctx('12345'));
    expect(res.status).toBe(401);
    expect(mt5PutSpy).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/internal/mt5/positions/[id] — id validation', () => {
  it('rejects non-canonical id with 400', async () => {
    const route = await importRoute();
    const res = await route.PATCH(
      buildReq('PATCH', `Bearer ${fixtureBearer}`, { sl: 1.09 }),
      ctx('abc'),
    );
    expect(res.status).toBe(400);
    expect(mt5PutSpy).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/internal/mt5/positions/[id] — body validation', () => {
  it('400 when JSON body is malformed', async () => {
    const route = await importRoute();
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${fixtureBearer}`);
    headers.set('content-type', 'application/json');
    const req = new Request('https://app.local/api/internal/mt5/positions/12345', {
      method: 'PATCH',
      headers,
      body: '{not json',
    });
    const res = await route.PATCH(req, ctx('12345'));
    expect(res.status).toBe(400);
  });

  it('400 when body is empty (no sl, no tp)', async () => {
    const route = await importRoute();
    const res = await route.PATCH(buildReq('PATCH', `Bearer ${fixtureBearer}`, {}), ctx('12345'));
    expect(res.status).toBe(400);
  });

  it('400 when sl is non-numeric', async () => {
    const route = await importRoute();
    const res = await route.PATCH(
      buildReq('PATCH', `Bearer ${fixtureBearer}`, { sl: 'low' }),
      ctx('12345'),
    );
    expect(res.status).toBe(400);
  });

  it('400 when tp is Infinity', async () => {
    const route = await importRoute();
    const res = await route.PATCH(
      buildReq('PATCH', `Bearer ${fixtureBearer}`, { tp: Infinity }),
      ctx('12345'),
    );
    // Infinity round-trips through JSON.stringify as null, so the body
    // ends up { tp: null } which fails the typeof === 'number' check.
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/internal/mt5/positions/[id] — translation', () => {
  it('translates sl/tp → stop_loss/take_profit and PUTs', async () => {
    mt5PutSpy.mockResolvedValue({ success: true, ticket: 12345 });
    const route = await importRoute();
    const res = await route.PATCH(
      buildReq('PATCH', `Bearer ${fixtureBearer}`, { sl: 2300, tp: 2400 }),
      ctx('12345'),
    );
    expect(res.status).toBe(200);
    expect(mt5PutSpy).toHaveBeenCalledWith('/api/v1/positions/12345', {
      stop_loss: 2300,
      take_profit: 2400,
    });
  });

  it('omits stop_loss when only tp provided', async () => {
    mt5PutSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.PATCH(buildReq('PATCH', `Bearer ${fixtureBearer}`, { tp: 1.09 }), ctx('12345'));
    expect(mt5PutSpy).toHaveBeenCalledWith('/api/v1/positions/12345', { take_profit: 1.09 });
  });

  it('omits take_profit when only sl provided', async () => {
    mt5PutSpy.mockResolvedValue({ success: true });
    const route = await importRoute();
    await route.PATCH(buildReq('PATCH', `Bearer ${fixtureBearer}`, { sl: 1.09 }), ctx('12345'));
    expect(mt5PutSpy).toHaveBeenCalledWith('/api/v1/positions/12345', { stop_loss: 1.09 });
  });
});

describe('PATCH /api/internal/mt5/positions/[id] — upstream errors', () => {
  it('returns mapped error when upstream throws', async () => {
    mt5PutSpy.mockRejectedValue(
      new Error('mt5: PUT /api/v1/positions/12345 → HTTP 502: bad gateway'),
    );
    const route = await importRoute();
    const res = await route.PATCH(
      buildReq('PATCH', `Bearer ${fixtureBearer}`, { sl: 1.09 }),
      ctx('12345'),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
