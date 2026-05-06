/**
 * POST /api/cron/health -- AC-024-3 inbound liveness ping.
 *
 * v1.2 FR-024 D5: the VPS-NSSM cron-runner POSTs to this route every 60s
 * with Authorization: Bearer ${CRON_SECRET}. Each request inserts a
 * cron_runner_health row carrying tenant_id + runner_id + pinged_at=now().
 *
 * Coverage:
 *   (a) valid bearer + body -> 200 + row inserted
 *   (b) missing bearer -> 401
 *   (c) wrong bearer -> 401
 *   (d) missing runner_id in body -> 400
 *   (e) DB write failure -> 500 with structured error (constitution section 17 boundary)
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronToken = randomBytes(32).toString('hex');

let insertSpy: ReturnType<typeof vi.fn>;
let originalCronSecret: string | undefined;

beforeEach(() => {
  originalCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = cronToken;
  insertSpy = vi.fn(async () => undefined);
  vi.resetModules();
});

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('@caishen/db/client', () => ({
    getTenantDb: vi.fn(() => ({
      drizzle: {
        insert: () => ({
          values: insertSpy,
        }),
      },
    })),
  }));
  return await import('../../../app/api/cron/health/route');
}

function buildReq(body: unknown, bearer: string | undefined): Request {
  const headers = new Headers();
  if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/cron/health', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/cron/health -- auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ runner_id: 'vps-1' }, undefined));
    expect(res.status).toBe(401);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ runner_id: 'vps-1' }, 'wrong-token'));
    expect(res.status).toBe(401);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/cron/health -- happy path', () => {
  it('200 with valid bearer + runner_id, inserts cron_runner_health row', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ runner_id: 'vps-windows-1' }, cronToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; server_time_gmt: string };
    expect(body.ok).toBe(true);
    expect(body.server_time_gmt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    // Optional chaining on the outer `[0]` keeps the access type-safe under
    // tsconfig.base.json's `noUncheckedIndexedAccess: true`. We already
    // asserted `toHaveBeenCalledTimes(1)`, so the runtime invariant holds.
    // If the call were absent, `?.[0]` is undefined and the explicit
    // `expect(inserted).toBeDefined()` below fires with a clear message
    // before the property reads run.
    const inserted = insertSpy.mock.calls[0]?.[0] as
      | { tenantId: number; runnerId: string }
      | undefined;
    expect(inserted).toBeDefined();
    expect(inserted?.tenantId).toBe(1);
    expect(inserted?.runnerId).toBe('vps-windows-1');
  });
});

describe('POST /api/cron/health -- body validation', () => {
  it('returns 400 with missing runner_id', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({}, cronToken));
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns 400 with non-string runner_id', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ runner_id: 123 }, cronToken));
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns 400 with empty runner_id', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ runner_id: '' }, cronToken));
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/cron/health -- DB error boundary (section 17)', () => {
  it('returns 500 with structured error when insert throws', async () => {
    insertSpy.mockRejectedValueOnce(new Error('postgres: connection refused'));
    const route = await importRoute();
    const res = await route.POST(buildReq({ runner_id: 'vps-1' }, cronToken));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cron_runner_health insert failed/);
  });
});
