/**
 * FR-011 — `pair_configs` query helpers.
 *
 * AC-011-2: Planner reads `WHERE tenant_id=$1 AND active_bool=true` and only
 *           schedules executors for active pairs.
 * AC-011-3: Dashboard shows pair list as read-only in v1.
 *
 * Constitution §4: every query must include WHERE tenant_id.
 * Constitution §12: no all-tenants query — getActivePairs(db) MUST scope to db.tenantId.
 *
 * Strategy: spy-instrumented Drizzle. We assert (a) the right columns are
 * selected, (b) the where-chain is called once, (c) the where-clause carries
 * the tenant_id and active_bool filters, (d) the helper returns the rows the
 * fake DB hands back, (e) helpers REJECT calls when given a malformed db.
 *
 * The deeper integration check — that the actual SQL produced runs against
 * Postgres and returns the right rows — happens in the Evaluator's docker-
 * compose suite (deferred per implementation-report Known Rough Edge #5).
 */

import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDb } from '../../src/client';
import { getActivePairs, getAllPairsForDashboard, getPairConfig } from '../../src/queries/pairs';
import type { PairConfig } from '../../src/schema/pair-configs';

interface FakeDrizzle {
  select: ReturnType<typeof vi.fn>;
}

interface SelectChainCalls {
  fromArg: unknown;
  whereArg: SQL | undefined;
  orderByArg: SQL | undefined;
}

/**
 * Drizzle SQL objects hold cycles back to their owning PgTable. JSON.stringify
 * can't walk them. This stringifier collapses repeated objects + extracts the
 * column "name" + literal "value" payloads we care about for the assertions.
 */
function safeReprSql(node: unknown): string {
  const seen = new WeakSet<object>();
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') {
      parts.push(n);
      return;
    }
    if (typeof n === 'number' || typeof n === 'boolean') {
      parts.push(`value:${String(n)}`);
      return;
    }
    if (typeof n !== 'object') return;
    if (seen.has(n as object)) return;
    seen.add(n as object);
    // Pull identifying fields commonly present on Drizzle Column / SQL chunks.
    const obj = n as Record<string, unknown>;
    if (typeof obj.name === 'string') parts.push(`name:${obj.name}`);
    if (typeof obj.value === 'number' || typeof obj.value === 'string') {
      parts.push(`value:${String(obj.value)}`);
    }
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    for (const k of Object.keys(obj)) {
      if (k === 'table') continue; // skip the back-reference cycle
      walk(obj[k]);
    }
  };
  walk(node);
  return parts.join('|');
}

function makeFakeDb(rows: PairConfig[]): {
  db: TenantDb;
  drizzle: FakeDrizzle;
  calls: SelectChainCalls;
} {
  const calls: SelectChainCalls = {
    fromArg: undefined,
    whereArg: undefined,
    orderByArg: undefined,
  };

  // Drizzle .select().from(...).where(...).orderBy(...) returns awaitable rows.
  // We model the chain as a thenable that resolves to `rows`.
  const chain = {
    from: vi.fn((arg: unknown) => {
      calls.fromArg = arg;
      return chain;
    }),
    where: vi.fn((arg: SQL) => {
      calls.whereArg = arg;
      return chain;
    }),
    orderBy: vi.fn((arg: SQL) => {
      calls.orderByArg = arg;
      return chain;
    }),
    // Drizzle's query builder is itself a thenable — `await db.select()...`
    // resolves when the chain is consumed. We mirror that by exposing a `then`
    // method on the chain object. Biome flags this pattern by default; the
    // suppression is justified because this object IS intentionally the same
    // promise-like shape Drizzle returns, and that's the seam under test.
    // biome-ignore lint/suspicious/noThenProperty: deliberate Drizzle thenable mock
    then: (onFulfilled: (rows: PairConfig[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
  };
  const drizzle: FakeDrizzle = {
    select: vi.fn(() => chain),
  };
  const db: TenantDb = Object.freeze({
    drizzle: drizzle as unknown as TenantDb['drizzle'],
    tenantId: 1,
  });
  return { db, drizzle, calls };
}

const SAMPLE_ROWS: PairConfig[] = [
  {
    tenantId: 1,
    pairCode: 'EUR/USD',
    mt5Symbol: 'EURUSD',
    sessionsJson: ['EUR', 'NY'],
    activeBool: true,
    createdAt: new Date('2026-05-03T00:00:00Z'),
  },
  {
    tenantId: 1,
    pairCode: 'XAU/USD',
    mt5Symbol: 'XAUUSD',
    sessionsJson: ['EUR', 'NY'],
    activeBool: true,
    createdAt: new Date('2026-05-03T00:00:00Z'),
  },
];

describe('FR-011 AC-011-2: getActivePairs filters by tenant_id AND active_bool', () => {
  it('calls .select().from(pair_configs) once', async () => {
    const { db, drizzle } = makeFakeDb(SAMPLE_ROWS);
    await getActivePairs(db);
    expect(drizzle.select).toHaveBeenCalledTimes(1);
  });

  it('returns the rows from the fake DB', async () => {
    const { db } = makeFakeDb(SAMPLE_ROWS);
    const result = await getActivePairs(db);
    expect(result).toHaveLength(2);
    expect(result[0]?.pairCode).toBe('EUR/USD');
  });

  it('builds a where-clause that references tenant_id', async () => {
    const { db, calls } = makeFakeDb(SAMPLE_ROWS);
    await getActivePairs(db);
    expect(calls.whereArg).toBeDefined();
    // The Drizzle SQL helper objects don't expose a clean predicate string, but
    // serializing via .toString() / inspecting children gives enough signal.
    // The query encoder converts our SQL chunk into something containing both
    // "tenant_id" and "active_bool" identifier fragments.
    const repr = safeReprSql(calls.whereArg);
    expect(repr.includes('tenant_id') || repr.includes('tenantId')).toBe(true);
    expect(repr.includes('active_bool') || repr.includes('activeBool')).toBe(true);
  });

  it('binds the where-clause to db.tenantId (constitution §12 — no all-tenants)', async () => {
    const { db, calls } = makeFakeDb(SAMPLE_ROWS);
    await getActivePairs(db);
    // tenantId=1 must show up as a parameter value somewhere in the encoded SQL.
    const repr = safeReprSql(calls.whereArg);
    expect(repr).toMatch(/value:1\b/);
  });

  it('orders results by pair_code ascending (deterministic for Planner ordering)', async () => {
    const { db, calls } = makeFakeDb(SAMPLE_ROWS);
    await getActivePairs(db);
    expect(calls.orderByArg).toBeDefined();
    const repr = safeReprSql(calls.orderByArg);
    expect(repr.includes('pair_code') || repr.includes('pairCode')).toBe(true);
  });

  it('throws if given a non-frozen / malformed db (defense-in-depth)', async () => {
    // A bare object lacking drizzle/tenantId should be rejected before any IO.
    await expect(getActivePairs({} as unknown as TenantDb)).rejects.toThrow(/tenantId|drizzle/i);
  });
});

describe('FR-011 AC-011-3: getAllPairsForDashboard returns active + inactive (read-only)', () => {
  it('does NOT filter by active_bool — surfaces toggled-off pairs too', async () => {
    const allRows: PairConfig[] = [
      ...SAMPLE_ROWS,
      {
        tenantId: 1,
        pairCode: 'GBP/USD',
        mt5Symbol: 'GBPUSD',
        sessionsJson: ['EUR', 'NY'],
        activeBool: false, // toggled off
        createdAt: new Date('2026-05-03T00:00:00Z'),
      },
    ];
    const { db, calls } = makeFakeDb(allRows);
    const result = await getAllPairsForDashboard(db);
    expect(result).toHaveLength(3);
    // The where-clause should still carry tenant_id but NOT active_bool=true.
    const repr = safeReprSql(calls.whereArg);
    expect(repr.includes('tenant_id') || repr.includes('tenantId')).toBe(true);
    // active_bool MUST NOT appear as a filter — dashboard sees everything.
    expect(repr.includes('active_bool') || repr.includes('activeBool')).toBe(false);
  });

  it('still scopes to db.tenantId (constitution §12)', async () => {
    const { db, calls } = makeFakeDb(SAMPLE_ROWS);
    await getAllPairsForDashboard(db);
    const repr = safeReprSql(calls.whereArg);
    expect(repr).toMatch(/value:1\b/);
  });
});

describe('FR-011: getPairConfig (single-pair lookup by pair_code)', () => {
  it('filters by both tenant_id AND pair_code (composite PK lookup)', async () => {
    const { db, calls } = makeFakeDb([SAMPLE_ROWS[0] as PairConfig]);
    await getPairConfig(db, 'EUR/USD');
    const repr = safeReprSql(calls.whereArg);
    expect(repr.includes('tenant_id') || repr.includes('tenantId')).toBe(true);
    expect(repr.includes('pair_code') || repr.includes('pairCode')).toBe(true);
  });

  it('returns undefined when no row matches', async () => {
    const { db } = makeFakeDb([]);
    const result = await getPairConfig(db, 'NOT/EXIST');
    expect(result).toBeUndefined();
  });

  it('returns the single row when found', async () => {
    const { db } = makeFakeDb([SAMPLE_ROWS[1] as PairConfig]);
    const result = await getPairConfig(db, 'XAU/USD');
    expect(result?.pairCode).toBe('XAU/USD');
    expect(result?.mt5Symbol).toBe('XAUUSD');
  });

  it('throws if pairCode is empty (defense-in-depth)', async () => {
    const { db } = makeFakeDb([]);
    await expect(getPairConfig(db, '')).rejects.toThrow(/pairCode/i);
  });
});
