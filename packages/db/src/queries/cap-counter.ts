/**
 * FR-021 cap counter (per ADR-008 — local-counter is the v1 source of truth).
 *
 * Two pure helpers:
 *   - rollupDailyTotal: rows × YYYY-MM-DD → daily count of cap-burning events.
 *     Excludes cap-exempt rows (Spike 1 PASS path: one-offs are cap-exempt).
 *   - tierFromUsage: maps daily_used to {tier, alertText, shouldAlertOnTransition}
 *     per AC-021-3 thresholds (12/15 warning, 14/15 hard).
 *
 * Plus the async DB writer:
 *   - insertCapUsageLocal: writes one cap_usage_local row per cap-burn event.
 *     Used by Planner / Executor dispatch / replan / cap-status cron itself.
 *
 * Constitution §4: every reader/writer is tenant-scoped.
 */

import { and, eq, gte, lte } from 'drizzle-orm';
import type { TenantDb } from '../client';
import { capUsageLocal } from '../schema/cap-usage';
import type { capUsageLocalKind } from '../schema/enums';

export type CapKind =
  | 'planner_recurring'
  | 'executor_one_off_cap_counted'
  | 'executor_one_off_cap_exempt'
  | 'replan_fire'
  | 'cap_status_cron';

export interface CapUsageLocalRow {
  id: number;
  at: Date;
  capKind: CapKind;
}

/**
 * Count cap-burning events on the given GMT date. Cap-exempt rows are
 * counted as 0 (audit trail only — they don't consume a slot).
 */
export function rollupDailyTotal(rows: readonly CapUsageLocalRow[], dateGmt: string): number {
  let count = 0;
  for (const row of rows) {
    const rowDate = toGmtDate(row.at);
    if (rowDate !== dateGmt) continue;
    if (row.capKind === 'executor_one_off_cap_exempt') continue;
    count += 1;
  }
  return count;
}

export type CapTier = 'green' | 'warning' | 'hard';

export interface TierResult {
  tier: CapTier;
  /** Telegram alert text — null when tier=green. */
  alertText: string | null;
  /**
   * True when the current `used` is exactly the entry threshold (12 or 14).
   * Callers debounce alerts to "only fire when crossing the boundary".
   */
  shouldAlertOnTransition: boolean;
}

const WARNING_THRESHOLD = 12;
const HARD_THRESHOLD = 14;
const DAILY_LIMIT = 15;

export function tierFromUsage(used: number): TierResult {
  if (used >= HARD_THRESHOLD) {
    return {
      tier: 'hard',
      alertText: `[caishen] cap hard: ${used} / ${DAILY_LIMIT} slots used today`,
      shouldAlertOnTransition: used === HARD_THRESHOLD,
    };
  }
  if (used >= WARNING_THRESHOLD) {
    return {
      tier: 'warning',
      alertText: `[caishen] cap warning: ${used} / ${DAILY_LIMIT} slots used today`,
      shouldAlertOnTransition: used === WARNING_THRESHOLD,
    };
  }
  return { tier: 'green', alertText: null, shouldAlertOnTransition: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Async DB primitives
// ────────────────────────────────────────────────────────────────────────────

export interface InsertCapUsageLocalArg {
  tenantId: number;
  at: Date;
  capKind: CapKind;
  routineRunsId?: number;
}

/**
 * Best-effort insert; failures are logged but don't propagate. Caller code
 * (Planner fire path, executor dispatch, etc.) is on the hot path and must
 * not be blocked by cap-counter bookkeeping. The cap-rollup cron's
 * reconciliation step picks up missed rows via the orphan-detect query.
 */
export async function insertCapUsageLocal(
  db: TenantDb,
  arg: InsertCapUsageLocalArg,
): Promise<void> {
  try {
    await db.drizzle.insert(capUsageLocal).values({
      tenantId: arg.tenantId,
      at: arg.at,
      capKind: arg.capKind as (typeof capUsageLocalKind.enumValues)[number],
      routineRunsId: arg.routineRunsId,
    });
  } catch (e) {
    process.stderr.write(`[cap-counter] insert failed: ${stringifyError(e)}\n`);
  }
}

/**
 * Read cap_usage_local rows for a specific GMT date. Used by cap-rollup cron
 * to compute the daily total.
 */
export async function readCapUsageLocalForDate(
  db: TenantDb,
  dateGmt: string,
): Promise<CapUsageLocalRow[]> {
  const dayStart = new Date(`${dateGmt}T00:00:00Z`);
  const dayEnd = new Date(`${dateGmt}T23:59:59Z`);
  const rows = await db.drizzle
    .select({
      id: capUsageLocal.id,
      at: capUsageLocal.at,
      capKind: capUsageLocal.capKind,
    })
    .from(capUsageLocal)
    .where(
      and(
        eq(capUsageLocal.tenantId, db.tenantId),
        gte(capUsageLocal.at, dayStart),
        lte(capUsageLocal.at, dayEnd),
      ),
    );
  return rows as CapUsageLocalRow[];
}

function toGmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
