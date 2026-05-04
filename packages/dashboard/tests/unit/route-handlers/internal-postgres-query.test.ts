/**
 * POST /api/internal/postgres/query — named-query allowlist proxy.
 *
 * Body: { name: <allowlisted>, params: object }.
 *
 * No raw SQL accepted. tenantId in params MUST equal DEFAULT_TENANT_ID
 * (1 in v1).
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let runNamedQuerySpy: ReturnType<typeof vi.fn>;
let knownQueryNames: string[];
let originalToken: string | undefined;
let originalDefaultTenant: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  originalDefaultTenant = process.env.DEFAULT_TENANT_ID;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  delete process.env.DEFAULT_TENANT_ID; // route defaults to 1 when absent
  runNamedQuerySpy = vi.fn();
  knownQueryNames = [
    'select_active_pairs',
    'select_pair_schedules_today',
    'insert_pair_schedule',
    'cancel_pair_schedules_today',
    'update_pair_schedule_one_off_id',
    'select_open_orders_for_pair',
    'insert_executor_report',
    'select_recent_telegram_interactions',
    'update_routine_run',
    'select_cap_status',
  ];
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalDefaultTenant === undefined) delete process.env.DEFAULT_TENANT_ID;
  else process.env.DEFAULT_TENANT_ID = originalDefaultTenant;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('../../../lib/internal-postgres-queries', () => ({
    runNamedQuery: runNamedQuerySpy,
    KNOWN_QUERY_NAMES: knownQueryNames,
  }));
  return await import('../../../app/api/internal/postgres/query/route');
}

function buildReq(body: unknown, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/postgres/query', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/postgres/query — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'select_active_pairs', params: { tenantId: 1 } }),
    );
    expect(res.status).toBe(401);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'select_active_pairs', params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/internal/postgres/query — body validation', () => {
  it('rejects missing name with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });

  it('rejects missing params with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'select_active_pairs' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown query name with 400 (NOT in allowlist)', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'drop_table', params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });

  it('rejects raw SQL attempts (security: never accept SQL strings as a "name")', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'SELECT * FROM users', params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });

  it('rejects body with `sql` field (defence: route never reads .sql)', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ sql: 'DROP TABLE users', params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/postgres/query — tenant scope enforcement', () => {
  it('rejects when params.tenantId is missing with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'select_active_pairs', params: {} }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects when params.tenantId differs from DEFAULT_TENANT_ID with 403', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { name: 'select_active_pairs', params: { tenantId: 999 } },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(403);
    expect(runNamedQuerySpy).not.toHaveBeenCalled();
  });

  it('honours DEFAULT_TENANT_ID env var', async () => {
    process.env.DEFAULT_TENANT_ID = '5';
    runNamedQuerySpy.mockResolvedValue({ rows: [] });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'select_active_pairs', params: { tenantId: 5 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    // tenantId=1 now would 403 because default is 5
    const res2 = await route.POST(
      buildReq({ name: 'select_active_pairs', params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res2.status).toBe(403);
  });
});

describe('POST /api/internal/postgres/query — happy path', () => {
  it('forwards to runNamedQuery and returns rows', async () => {
    runNamedQuerySpy.mockResolvedValue({
      rows: [
        { pair_code: 'XAUUSD', active_bool: true },
        { pair_code: 'EURUSD', active_bool: true },
      ],
    });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ name: 'select_active_pairs', params: { tenantId: 1 } }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    expect(runNamedQuerySpy).toHaveBeenCalledWith({
      name: 'select_active_pairs',
      params: { tenantId: 1 },
    });
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('passes rowsAffected through for INSERT/UPDATE queries', async () => {
    runNamedQuerySpy.mockResolvedValue({
      rows: [{ id: 42 }],
      rowsAffected: 1,
    });
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        {
          name: 'insert_pair_schedule',
          params: {
            tenantId: 1,
            date: '2026-05-04',
            pairCode: 'XAUUSD',
            sessionName: 'london',
            startTimeGmt: '2026-05-04T08:00:00Z',
            endTimeGmt: '2026-05-04T12:00:00Z',
          },
        },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; rowsAffected: number };
    expect(body.rowsAffected).toBe(1);
  });
});

describe('POST /api/internal/postgres/query — handler errors', () => {
  it('returns 500 when runNamedQuery throws (param validation failure inside handler)', async () => {
    runNamedQuerySpy.mockRejectedValue(new Error('date required (non-empty string)'));
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { name: 'insert_pair_schedule', params: { tenantId: 1 } },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/date required/);
  });
});
