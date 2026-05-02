/**
 * FR-011 — `pair_configs` query helpers.
 *
 * Constitution §4: every query has WHERE tenant_id.
 * Constitution §12: no all-tenants query — every helper filters by db.tenantId.
 *
 * Two read paths:
 *   - getActivePairs(db)      — Planner consumes; only active rows; AC-011-2.
 *   - getAllPairsForDashboard — Dashboard read-only view; surfaces inactive too;
 *                               AC-011-3.
 *   - getPairConfig(db, code) — single-pair lookup by composite PK.
 *
 * The Planner ordering matters (AC-002-2 schedule-output is per-pair); we
 * order by pair_code ASC so the schedule list is deterministic across runs.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { TenantDb } from '../client';
import { type PairConfig, pairConfigs } from '../schema/pair-configs';

function assertTenantDb(db: TenantDb): void {
  if (
    !db ||
    typeof db !== 'object' ||
    !('drizzle' in db) ||
    !('tenantId' in db) ||
    typeof db.tenantId !== 'number'
  ) {
    throw new Error(
      `pairs query: expected a TenantDb with drizzle + tenantId; got ${JSON.stringify(db)}`,
    );
  }
}

/**
 * AC-011-2 — Planner's primary input. Returns active pairs scoped to the
 * caller's tenant, ordered by pair_code ascending so downstream schedule
 * output is deterministic.
 */
export async function getActivePairs(db: TenantDb): Promise<PairConfig[]> {
  assertTenantDb(db);
  const rows = await db.drizzle
    .select()
    .from(pairConfigs)
    .where(and(eq(pairConfigs.tenantId, db.tenantId), eq(pairConfigs.activeBool, true)))
    .orderBy(asc(pairConfigs.pairCode));
  return rows as PairConfig[];
}

/**
 * AC-011-3 — Dashboard read-only view. Surfaces both active and inactive
 * pairs (so the operator can see what's been toggled off without editing).
 * v1 is read-only; the editing UI is intentionally out-of-scope.
 */
export async function getAllPairsForDashboard(db: TenantDb): Promise<PairConfig[]> {
  assertTenantDb(db);
  const rows = await db.drizzle
    .select()
    .from(pairConfigs)
    .where(eq(pairConfigs.tenantId, db.tenantId))
    .orderBy(asc(pairConfigs.pairCode));
  return rows as PairConfig[];
}

/**
 * Single-pair lookup by composite PK (tenant_id, pair_code).
 *
 * Used by:
 *   - Executor's pre-fire stale-check (R3) to verify the pair is still
 *     scheduled for today's session.
 *   - Override handlers' validation step.
 */
export async function getPairConfig(
  db: TenantDb,
  pairCode: string,
): Promise<PairConfig | undefined> {
  assertTenantDb(db);
  if (!pairCode || pairCode.length === 0) {
    throw new Error('pairs query: pairCode must be a non-empty string');
  }
  const rows = await db.drizzle
    .select()
    .from(pairConfigs)
    .where(and(eq(pairConfigs.tenantId, db.tenantId), eq(pairConfigs.pairCode, pairCode)));
  return (rows as PairConfig[])[0];
}
