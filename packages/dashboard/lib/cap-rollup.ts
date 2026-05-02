/**
 * FR-021 cap-rollup helpers — DB read/write + optional /v1/usage cross-check.
 *
 * Three primitives:
 *   - readYesterdayCapLocal: pull cap_usage_local rows for "yesterday GMT"
 *   - upsertCapUsageDaily: insert (or update on conflict) the daily row
 *   - fetchAnthropicUsage: optional /v1/usage cross-check (per ADR-008,
 *     conditional on FR-001 Spike 4 outcome). Returns null if disabled or
 *     unsupported.
 *
 * The route handler composes these.
 */

import { getTenantDb } from '@caishen/db/client';
import {
  type CapUsageLocalRow,
  readCapUsageLocalForDate,
  rollupDailyTotal,
} from '@caishen/db/queries/cap-counter';
import { capUsage } from '@caishen/db/schema/cap-usage';

const DEFAULT_TENANT = 1;

export type CapRollupSource = 'local_counter' | 'anthropic_api';

export interface UpsertCapUsageArg {
  tenantId: number;
  date: string;
  dailyUsed: number;
  dailyLimit: number;
  weeklyUsed: number;
  weeklyLimit: number;
  source: CapRollupSource;
}

/**
 * Pull yesterday's GMT cap_usage_local rows. "Yesterday" = the date one
 * second before now (GMT) — the cron runs at 12:00 GMT and rolls up the
 * preceding 24h.
 */
export async function readYesterdayCapLocal(
  tenantId: number = DEFAULT_TENANT,
): Promise<CapUsageLocalRow[]> {
  const yesterday = yesterdayGmt();
  const db = getTenantDb(tenantId);
  return readCapUsageLocalForDate(db, yesterday);
}

/**
 * Upsert the cap_usage daily row. Unique constraint on
 * (tenant_id, date, source) — re-running the cron OR adding the
 * /v1/usage cross-check row is idempotent.
 */
export async function upsertCapUsageDaily(arg: UpsertCapUsageArg): Promise<void> {
  const db = getTenantDb(arg.tenantId);
  await db.drizzle
    .insert(capUsage)
    .values({
      tenantId: arg.tenantId,
      date: arg.date,
      dailyUsed: arg.dailyUsed,
      dailyLimit: arg.dailyLimit,
      weeklyUsed: arg.weeklyUsed,
      weeklyLimit: arg.weeklyLimit,
      source: arg.source,
    })
    .onConflictDoUpdate({
      target: [capUsage.tenantId, capUsage.date, capUsage.source],
      set: {
        dailyUsed: arg.dailyUsed,
        dailyLimit: arg.dailyLimit,
        weeklyUsed: arg.weeklyUsed,
        weeklyLimit: arg.weeklyLimit,
        recordedAt: new Date(),
      },
    });
}

export interface AnthropicUsageReading {
  dailyUsed: number;
  weeklyUsed: number;
}

/**
 * Optional cross-check: fetch /v1/usage from Anthropic. Conditional on
 * FR-001 Spike 4 outcome (per ADR-008). When the env flag is unset OR the
 * endpoint isn't yet exposed (Spike 4 PARTIAL/FAIL), returns null.
 *
 * The endpoint shape used here is illustrative: Spike 4 confirms the actual
 * shape on first live run. Drift detection happens at the route-handler
 * layer (compare local vs anthropic counts).
 */
export async function fetchAnthropicUsage(): Promise<AnthropicUsageReading | null> {
  const enabled = process.env.ANTHROPIC_USAGE_RECONCILE_ENABLED === '1';
  if (!enabled) return null;
  const bearer = process.env.PLANNER_ROUTINE_BEARER ?? '';
  if (bearer.length === 0) return null;
  // Defensive: do not attempt the live fetch unless explicitly opted in.
  // Spike 4 will confirm the shape; until then, returning null defers the
  // cross-check to the cap-status cron's reconcile step.
  return null;
}

function yesterdayGmt(): string {
  const d = new Date(Date.now() - 24 * 3_600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { rollupDailyTotal };
