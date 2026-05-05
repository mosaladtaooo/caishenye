/**
 * DELETE /api/internal/mt5/orders/pending/[id] — cancel one pending order tests.
 *
 *   - Auth gate (401 / 500-LOUD)
 *   - id sanitisation (positive integer; rejects non-numeric / leading-zero / scientific)
 *   - Forwards to upstream DELETE /api/v1/order/pending/{id}
 *   - Upstream errors mapped via mapUpstreamError
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let mt5DeleteSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  mt5DeleteSpy = vi.fn();
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
    mt5Put: vi.fn(),
    mt5Delete: mt5DeleteSpy,
  }));
  return await import('../../../app/api/internal/mt5/orders/pending/[id]/route');
}

function buildReq(headerValue: string | undefined): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  return new Request('https://app.local/api/internal/mt5/orders/pending/12345', {
    method: 'DELETE',
    headers,
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/internal/mt5/orders/pending/[id] — auth gate', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.DELETE(buildReq(undefined), ctx('12345'));
    expect(res.status).toBe(401);
    expect(mt5DeleteSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('12345'));
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/internal/mt5/orders/pending/[id] — id validation', () => {
  it.each([['abc'], ['12.5'], ['0x1f'], ['012'], ['-3'], [' 12 '], ['']])(
    'rejects non-canonical id %s with 400',
    async (id) => {
      const route = await importRoute();
      const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx(id));
      expect(res.status).toBe(400);
      expect(mt5DeleteSpy).not.toHaveBeenCalled();
    },
  );

  it('accepts positive integer and forwards to upstream', async () => {
    mt5DeleteSpy.mockResolvedValue({ success: true, ticket: 12345 });
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('12345'));
    expect(res.status).toBe(200);
    expect(mt5DeleteSpy).toHaveBeenCalledWith('/api/v1/order/pending/12345');
  });
});

describe('DELETE /api/internal/mt5/orders/pending/[id] — upstream errors', () => {
  it('returns mapped error when upstream throws', async () => {
    mt5DeleteSpy.mockRejectedValue(new Error('mt5: DELETE → HTTP 504'));
    const route = await importRoute();
    const res = await route.DELETE(buildReq(`Bearer ${fixtureBearer}`), ctx('12345'));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
