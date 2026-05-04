/**
 * lib/internal-postgres-queries — pure-allowlist tests (no DB).
 *
 * Validates: KNOWN_QUERY_NAMES is the canonical list, runNamedQuery
 * rejects unknown names, every known query requires tenantId.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importModule() {
  // Stub the DB client so handlers don't try to connect.
  vi.doMock('@caishen/db/client', () => ({
    getTenantDb: () => {
      throw new Error('DATABASE_URL missing — required for @caishen/db client');
    },
  }));
  return await import('../../lib/internal-postgres-queries');
}

describe('KNOWN_QUERY_NAMES', () => {
  it('includes the v1 baseline set', async () => {
    const { KNOWN_QUERY_NAMES } = await importModule();
    expect(KNOWN_QUERY_NAMES).toContain('select_active_pairs');
    expect(KNOWN_QUERY_NAMES).toContain('select_pair_schedules_today');
    expect(KNOWN_QUERY_NAMES).toContain('insert_pair_schedule');
    expect(KNOWN_QUERY_NAMES).toContain('cancel_pair_schedules_today');
    expect(KNOWN_QUERY_NAMES).toContain('update_pair_schedule_one_off_id');
    expect(KNOWN_QUERY_NAMES).toContain('select_open_orders_for_pair');
    expect(KNOWN_QUERY_NAMES).toContain('insert_executor_report');
    expect(KNOWN_QUERY_NAMES).toContain('select_recent_telegram_interactions');
    expect(KNOWN_QUERY_NAMES).toContain('update_routine_run');
    expect(KNOWN_QUERY_NAMES).toContain('select_cap_status');
  });

  it('does NOT include any raw-SQL or DDL operation', async () => {
    const { KNOWN_QUERY_NAMES } = await importModule();
    for (const name of KNOWN_QUERY_NAMES) {
      expect(name).not.toMatch(/^(drop|truncate|delete|alter|grant|revoke)/i);
      expect(name).not.toContain(' '); // no SQL fragments
      expect(name).not.toContain(';'); // no SQL fragments
    }
  });
});

describe('runNamedQuery', () => {
  it('throws on unknown query name', async () => {
    const { runNamedQuery } = await importModule();
    await expect(runNamedQuery({ name: 'no-such-query', params: { tenantId: 1 } })).rejects.toThrow(
      /unknown query name/,
    );
  });

  it('throws when tenantId missing on a query that needs it', async () => {
    const { runNamedQuery } = await importModule();
    await expect(runNamedQuery({ name: 'select_active_pairs', params: {} })).rejects.toThrow(
      /tenantId/,
    );
  });

  it('throws when tenantId is not a number', async () => {
    const { runNamedQuery } = await importModule();
    await expect(
      runNamedQuery({
        name: 'select_active_pairs',
        params: { tenantId: 'one' as unknown as number },
      }),
    ).rejects.toThrow(/tenantId/);
  });

  it('throws when insert_pair_schedule missing required string params', async () => {
    const { runNamedQuery } = await importModule();
    await expect(
      runNamedQuery({ name: 'insert_pair_schedule', params: { tenantId: 1 } }),
    ).rejects.toThrow(/date required/);
  });

  it('throws when update_pair_schedule_one_off_id missing id', async () => {
    const { runNamedQuery } = await importModule();
    await expect(
      runNamedQuery({ name: 'update_pair_schedule_one_off_id', params: { tenantId: 1 } }),
    ).rejects.toThrow(/id required/);
  });
});
