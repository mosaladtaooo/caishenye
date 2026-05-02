/**
 * FR-008 — tenant-scoped Drizzle client factory.
 *
 * Constitution §4: every query in app code MUST include tenant_id. The
 * factory is the structural enforcement: callers receive a client that
 * carries a `tenantId` property + helpers that always include the filter.
 *
 * The raw `db` is NOT exported. Callers obtain a tenant-scoped client via:
 *
 *   import { getTenantDb } from '@caishen/db/client';
 *   const db = getTenantDb(1);
 *   // db.select().from(routineRuns) — caller still has to add WHERE tenant_id;
 *   //   the lint/tenant-id-lint.ts AST checker enforces it at commit time.
 *
 * The factory ALSO carries `db.tenantId` so callers writing queries can
 * reference it ergonomically: `eq(routine_runs.tenant_id, db.tenantId)`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Connection-pool reuse. Multiple `getTenantDb` calls share the same
 * underlying postgres pool to avoid socket exhaustion on Vercel Functions.
 */
let _client: postgres.Sql | null = null;
let _drizzle: ReturnType<typeof drizzle> | null = null;

function rawDb(): ReturnType<typeof drizzle> {
  if (_drizzle) return _drizzle;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing — required for @caishen/db client');
  _client = postgres(url, { max: 10, idle_timeout: 20 });
  _drizzle = drizzle(_client, { schema });
  return _drizzle;
}

/**
 * Tenant-scoped Drizzle client. The returned object has the full Drizzle
 * surface plus `tenantId` for ergonomic WHERE clauses.
 *
 * NOTE: this DOES NOT auto-apply WHERE tenant_id. Callers must still write
 * explicit filters — the linter (`lint/tenant-id-lint.ts`) catches missing
 * filters at commit time. We chose explicit-over-magic to keep query
 * intent obvious in code review (Drizzle's middleware approach was
 * rejected per constitution §17 + criteria.md Code Quality).
 */
export interface TenantDb {
  /** Drizzle client surface (select, insert, update, delete, transaction, etc.) */
  readonly drizzle: ReturnType<typeof drizzle>;
  /** Tenant scope this client is bound to. */
  readonly tenantId: number;
}

export function getTenantDb(tenantId: number): TenantDb {
  if (!Number.isInteger(tenantId) || tenantId < 1) {
    throw new Error(`getTenantDb: tenantId must be a positive integer, got ${tenantId}`);
  }
  return Object.freeze({
    drizzle: rawDb(),
    tenantId,
  });
}

/** Test/utility entry point — reset the pool (used by integration tests). */
export async function _resetClientForTests(): Promise<void> {
  if (_client) await _client.end({ timeout: 1 });
  _client = null;
  _drizzle = null;
}
