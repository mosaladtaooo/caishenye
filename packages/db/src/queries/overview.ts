/**
 * FR-006 + FR-015 + FR-017 — dashboard read-side query helpers.
 *
 * Pure-compute functions live next to the DB readers so unit tests can
 * exercise the formatting logic (countdowns, cap-bar tier) without a real
 * Postgres. The DB readers (getTodaySchedule etc.) are async wrappers that
 * fold the raw row arrays into render-ready shapes.
 *
 * Constitution §4: every reader filters by db.tenantId.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { TenantDb } from '../client';
import { agentState } from '../schema/agent-state';
import { capUsage } from '../schema/cap-usage';
import { executorReports } from '../schema/executor-reports';
import { orders } from '../schema/orders';
import { pairSchedules } from '../schema/pair-schedules';

// ────────────────────────────────────────────────────────────────────────────
// Pure compute helpers
// ────────────────────────────────────────────────────────────────────────────

export type ScheduleStatus = 'scheduled' | 'cancelled' | 'fired' | 'skipped_no_window';

export interface ScheduleRowMin {
  id: number;
  pairCode: string;
  sessionName: string;
  startTimeGmt: Date | null;
  endTimeGmt: Date | null;
  status: ScheduleStatus;
  scheduledOneOffId: string | null;
}

export interface ScheduleEntry extends ScheduleRowMin {
  countdown: string;
}

/**
 * Format the countdown to a future Date as a human-readable string.
 *
 *   start <= now             → "now"
 *   < 1h                     → "in Nm"
 *   >= 1h, exact hour          → "in Nh"
 *   >= 1h, with minutes        → "in Nh Mm"
 */
export function formatCountdown(now: Date, start: Date): string {
  const diffMs = start.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const totalMin = Math.floor(diffMs / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/**
 * Render schedule rows as ScheduleEntry[] with countdown attached.
 * Cancelled rows get countdown='cancelled', skipped_no_window gets '—'.
 */
export function buildScheduleEntries(rows: readonly ScheduleRowMin[], now: Date): ScheduleEntry[] {
  return rows.map((row) => {
    let countdown = '—';
    if (row.status === 'cancelled') {
      countdown = 'cancelled';
    } else if (row.status === 'skipped_no_window') {
      countdown = '—';
    } else if (row.startTimeGmt) {
      countdown = formatCountdown(now, row.startTimeGmt);
    }
    return { ...row, countdown };
  });
}

export type CapTier = 'green' | 'yellow' | 'red';

export interface CapProgress {
  dailyUsed: number;
  dailyLimit: number;
  percent: number;
  tier: CapTier;
}

const CAP_YELLOW_THRESHOLD = 12;
const CAP_RED_THRESHOLD = 14;

/**
 * Compute the cap progress bar's tier + percent. AC-021-2.
 *   green  <= 11 used
 *   yellow 12-13 used
 *   red    >= 14 used
 *
 * Percent is clamped to 100 even when used > limit (defensive rendering;
 * a daily_used > daily_limit is a reconciliation bug we want visible).
 */
export function computeCapBarTier(input: { dailyUsed: number; dailyLimit: number }): CapProgress {
  const used = Math.max(0, input.dailyUsed);
  const limit = Math.max(0, input.dailyLimit);
  let percent: number;
  if (limit === 0) {
    percent = 0;
  } else {
    percent = Math.min(100, Math.round((used / limit) * 100));
  }
  let tier: CapTier;
  if (used >= CAP_RED_THRESHOLD) tier = 'red';
  else if (used >= CAP_YELLOW_THRESHOLD) tier = 'yellow';
  else tier = 'green';
  return { dailyUsed: used, dailyLimit: limit, percent, tier };
}

// ────────────────────────────────────────────────────────────────────────────
// Async DB readers
// ────────────────────────────────────────────────────────────────────────────

export interface AgentStateView {
  pausedBool: boolean;
  pausedAt: Date | null;
}

/**
 * Read agent_state for the tenant. Returns the default `{paused: false}`
 * when no row exists (first deploy, before any pause/resume happened).
 */
export async function getAgentState(db: TenantDb): Promise<AgentStateView> {
  const rows = await db.drizzle
    .select({
      pausedBool: agentState.pausedBool,
      pausedAt: agentState.pausedAt,
    })
    .from(agentState)
    .where(eq(agentState.tenantId, db.tenantId));
  const row = rows[0];
  if (!row) return { pausedBool: false, pausedAt: null };
  return row;
}

/**
 * Today's pair_schedules with computed countdowns. Used by the Schedule
 * page + the Overview hero.
 */
export async function getTodaySchedule(db: TenantDb, today: string): Promise<ScheduleEntry[]> {
  const rows = await db.drizzle
    .select({
      id: pairSchedules.id,
      pairCode: pairSchedules.pairCode,
      sessionName: pairSchedules.sessionName,
      startTimeGmt: pairSchedules.startTimeGmt,
      endTimeGmt: pairSchedules.endTimeGmt,
      status: pairSchedules.status,
      scheduledOneOffId: pairSchedules.scheduledOneOffId,
    })
    .from(pairSchedules)
    .where(and(eq(pairSchedules.tenantId, db.tenantId), eq(pairSchedules.date, today)));
  return buildScheduleEntries(rows as ScheduleRowMin[], new Date());
}

export interface RecentTrade {
  id: number;
  pair: string;
  type: string;
  status: string;
  volume: string | null;
  price: string | null;
  pnl: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
}

/**
 * Last N orders for the tenant — most recent first. Used by History page +
 * Overview "open positions" snapshot.
 */
export async function getRecentTrades(db: TenantDb, limit: number): Promise<RecentTrade[]> {
  const rows = await db.drizzle
    .select({
      id: orders.id,
      pair: orders.pair,
      type: orders.type,
      status: orders.status,
      volume: orders.volume,
      price: orders.price,
      pnl: orders.pnl,
      openedAt: orders.openedAt,
      closedAt: orders.closedAt,
    })
    .from(orders)
    .where(eq(orders.tenantId, db.tenantId))
    .orderBy(desc(orders.openedAt))
    .limit(limit);
  return rows;
}

export interface RecentReport {
  id: number;
  pair: string;
  session: string;
  actionTaken: string | null;
  reportMdBlobUrl: string | null;
  summaryMd: string | null;
  createdAt: Date;
  routineRunId: number;
}

/**
 * Last N executor_reports for the tenant. Used by the per-pair page
 * (filtered to a single pair) and the Overview "recent activity" feed.
 */
export async function getRecentReports(
  db: TenantDb,
  limit: number,
  filterPair?: string,
): Promise<RecentReport[]> {
  const conditions = [eq(executorReports.tenantId, db.tenantId)];
  if (filterPair) {
    conditions.push(eq(executorReports.pair, filterPair));
  }
  const rows = await db.drizzle
    .select({
      id: executorReports.id,
      pair: executorReports.pair,
      session: executorReports.session,
      actionTaken: executorReports.actionTaken,
      reportMdBlobUrl: executorReports.reportMdBlobUrl,
      summaryMd: executorReports.summaryMd,
      createdAt: executorReports.createdAt,
      routineRunId: executorReports.routineRunId,
    })
    .from(executorReports)
    .where(and(...conditions))
    .orderBy(desc(executorReports.createdAt))
    .limit(limit);
  return rows;
}

/**
 * Today's cap usage row. Returns null when no roll-up exists yet (cap-rollup
 * cron hasn't run for today). The dashboard's cap progress bar renders a
 * placeholder in that case.
 */
export async function getCapUsageProgress(
  db: TenantDb,
  today: string,
): Promise<CapProgress | null> {
  const rows = await db.drizzle
    .select({
      dailyUsed: capUsage.dailyUsed,
      dailyLimit: capUsage.dailyLimit,
    })
    .from(capUsage)
    .where(and(eq(capUsage.tenantId, db.tenantId), eq(capUsage.date, today)))
    .orderBy(desc(capUsage.recordedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return computeCapBarTier({
    dailyUsed: Number(row.dailyUsed ?? 0),
    dailyLimit: Number(row.dailyLimit ?? 15),
  });
}
