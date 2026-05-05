/**
 * Named-query allowlist for /api/internal/postgres/query (ADR-012).
 *
 * No raw SQL is ever accepted from the Routine. Every supported operation
 * is defined here as a strongly-typed function. Adding a new query is a
 * deliberate amendment — keeps the proxy's blast radius minimal even if a
 * Routine session is compromised.
 *
 * Tenant scoping: every query reads tenantId from its params arg. The
 * route layer enforces tenantId === DEFAULT_TENANT_ID (i.e., 1) for v1.
 *
 * Constitution §4 + §12 (multi-tenant, no all-tenants): every query has
 * an explicit tenant_id filter. The tenant-id-lint sweeps this file too.
 *
 * Constitution §3 (audit-or-abort): the routine_runs query family lets the
 * Routine settle its in-flight audit row at exit.
 */

import { getTenantDb } from '@caishen/db/client';
import { capUsage } from '@caishen/db/schema/cap-usage';
import { executorReports } from '@caishen/db/schema/executor-reports';
import { orders } from '@caishen/db/schema/orders';
import { pairConfigs } from '@caishen/db/schema/pair-configs';
import { pairSchedules } from '@caishen/db/schema/pair-schedules';
import { routineRuns } from '@caishen/db/schema/routine-runs';
import { telegramInteractions } from '@caishen/db/schema/telegram-interactions';
import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';

export interface NamedQueryRequest {
  name: string;
  params: Record<string, unknown>;
}

export type NamedQueryResult = { rows: unknown[]; rowsAffected?: number };

// ─── helpers ───────────────────────────────────────────────────────────

function readTenantId(p: Record<string, unknown>): number {
  if (typeof p.tenantId !== 'number') throw new Error('tenantId required (number)');
  return p.tenantId;
}

function readString(p: Record<string, unknown>, key: string): string {
  if (typeof p[key] !== 'string' || (p[key] as string).length === 0) {
    throw new Error(`${key} required (non-empty string)`);
  }
  return p[key] as string;
}

function readNumber(p: Record<string, unknown>, key: string): number {
  if (typeof p[key] !== 'number') throw new Error(`${key} required (number)`);
  return p[key] as number;
}

function readOptionalNumber(p: Record<string, unknown>, key: string): number | null {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number') throw new Error(`${key} must be a number when present`);
  return v;
}

function readOptionalString(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`${key} must be a string when present`);
  return v;
}

/**
 * Permitted routine_name enum values for `insert_routine_run`.
 * Mirrors the routineRunRoutineName Postgres enum exactly. We hard-code the
 * list (rather than importing from the Drizzle schema) so the route layer
 * fails fast on bad input without round-tripping to Postgres for a 22P02.
 */
const ROUTINE_NAMES = new Set([
  'planner',
  'executor',
  'spike_ac_001_1',
  'spike_ac_001_2',
  'spike_ac_001_3',
  'spike_ac_001_4',
  'cap_status',
  'replan_orchestrator',
] as const);
type RoutineName =
  | 'planner'
  | 'executor'
  | 'spike_ac_001_1'
  | 'spike_ac_001_2'
  | 'spike_ac_001_3'
  | 'spike_ac_001_4'
  | 'cap_status'
  | 'replan_orchestrator';

const ROUTINE_FIRE_KINDS = new Set([
  'recurring',
  'scheduled_one_off',
  'fire_api',
  'claude_run_bash',
] as const);
type RoutineFireKind = 'recurring' | 'scheduled_one_off' | 'fire_api' | 'claude_run_bash';

// ─── named queries ─────────────────────────────────────────────────────

const handlers: Record<string, (params: Record<string, unknown>) => Promise<NamedQueryResult>> = {
  // Read all active pairs for a tenant.
  select_active_pairs: async (params) => {
    const tenantId = readTenantId(params);
    const db = getTenantDb(tenantId);
    const rows = await db.drizzle
      .select()
      .from(pairConfigs)
      .where(and(eq(pairConfigs.tenantId, tenantId), eq(pairConfigs.activeBool, true)))
      .orderBy(asc(pairConfigs.pairCode));
    return { rows };
  },

  // Read today's pair_schedules rows for a tenant. Optionally filter by pairCode.
  select_pair_schedules_today: async (params) => {
    const tenantId = readTenantId(params);
    const date = readString(params, 'date'); // YYYY-MM-DD GMT
    const pairCode = readOptionalString(params, 'pairCode');
    const db = getTenantDb(tenantId);
    const where =
      pairCode === null
        ? and(eq(pairSchedules.tenantId, tenantId), eq(pairSchedules.date, date))
        : and(
            eq(pairSchedules.tenantId, tenantId),
            eq(pairSchedules.date, date),
            eq(pairSchedules.pairCode, pairCode),
          );
    const rows = await db.drizzle.select().from(pairSchedules).where(where);
    return { rows };
  },

  // Insert one pair_schedules row. Returns the inserted id.
  insert_pair_schedule: async (params) => {
    const tenantId = readTenantId(params);
    const date = readString(params, 'date');
    const pairCode = readString(params, 'pairCode');
    const sessionName = readString(params, 'sessionName');
    const startIso = readOptionalString(params, 'startTimeGmt');
    const endIso = readOptionalString(params, 'endTimeGmt');
    const plannerRunId = readOptionalNumber(params, 'plannerRunId');
    const db = getTenantDb(tenantId);
    const inserted = await db.drizzle
      .insert(pairSchedules)
      .values({
        tenantId,
        date,
        pairCode,
        sessionName,
        startTimeGmt: startIso === null ? null : new Date(startIso),
        endTimeGmt: endIso === null ? null : new Date(endIso),
        plannerRunId,
        status: startIso === null ? 'skipped_no_window' : 'scheduled',
      })
      .returning({ id: pairSchedules.id });
    return { rows: inserted, rowsAffected: inserted.length };
  },

  // Cancel today's not-yet-fired pair_schedules rows during re-plan cleanup.
  cancel_pair_schedules_today: async (params) => {
    const tenantId = readTenantId(params);
    const date = readString(params, 'date');
    const db = getTenantDb(tenantId);
    const updated = await db.drizzle
      .update(pairSchedules)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(pairSchedules.tenantId, tenantId),
          eq(pairSchedules.date, date),
          eq(pairSchedules.status, 'scheduled'),
        ),
      )
      .returning({ id: pairSchedules.id });
    return { rows: updated, rowsAffected: updated.length };
  },

  // After Planner /schedules an Executor, persist the returned one_off_id on
  // the schedule row.
  //
  // Pre-v1.1: used by the Planner step 9 (since deprecated). v1.1+: also used
  // by /api/cron/fire-due-executors for the unclaim path (set the column back
  // to null when a fire fails so the next cron tick can retry).
  update_pair_schedule_one_off_id: async (params) => {
    const tenantId = readTenantId(params);
    const id = readNumber(params, 'id');
    const scheduledOneOffId = readOptionalString(params, 'scheduledOneOffId');
    const db = getTenantDb(tenantId);
    const updated = await db.drizzle
      .update(pairSchedules)
      .set({ scheduledOneOffId })
      .where(and(eq(pairSchedules.tenantId, tenantId), eq(pairSchedules.id, id)))
      .returning({ id: pairSchedules.id });
    return { rows: updated, rowsAffected: updated.length };
  },

  // v1.1 cron-pivot — read pair_schedules rows that are DUE for the cron tick
  // to fire. "Due" = status='scheduled' AND start_time_gmt has passed AND
  // scheduled_one_off_id is still null (no claim yet). Caller passes the
  // current ISO timestamp; route layer computes it.
  //
  // Look-back is bounded by `lookbackMinutes` (default 5) so the cron doesn't
  // pick up ancient missed-window schedules — those should be operator-
  // intervened, not auto-fired hours late.
  //
  // Per ADR-013 (v1.1 cascade edit): this is the read-side of the polling
  // pattern that replaces the dead /api/internal/anthropic/schedule call.
  select_pair_schedules_due_for_fire: async (params) => {
    const tenantId = readTenantId(params);
    const nowIso = readString(params, 'nowIso');
    const lookbackMinutes = typeof params.lookbackMinutes === 'number' ? params.lookbackMinutes : 5;
    const now = new Date(nowIso);
    if (Number.isNaN(now.getTime())) throw new Error('nowIso must be a valid ISO timestamp');
    const lookbackCutoff = new Date(now.getTime() - lookbackMinutes * 60_000);
    const db = getTenantDb(tenantId);
    const rows = await db.drizzle
      .select()
      .from(pairSchedules)
      .where(
        and(
          eq(pairSchedules.tenantId, tenantId),
          eq(pairSchedules.status, 'scheduled'),
          isNull(pairSchedules.scheduledOneOffId),
          lte(pairSchedules.startTimeGmt, now),
        ),
      )
      .orderBy(asc(pairSchedules.startTimeGmt));
    // Filter out ancient schedules (older than lookbackMinutes) — those are
    // missed windows that should be operator-investigated, not auto-fired.
    const fresh = rows.filter((r) => {
      if (r.startTimeGmt === null) return false;
      return new Date(r.startTimeGmt as unknown as string) >= lookbackCutoff;
    });
    return { rows: fresh };
  },

  // v1.1 cron-pivot — atomically claim a pair_schedules row for firing. The
  // UPDATE-WHERE-IS-NULL-RETURNING pattern guarantees that two concurrent
  // cron ticks can't double-fire the same row. The caller writes a
  // claim-token (e.g., "claiming-<timestamp>-<pid>") to scheduled_one_off_id;
  // if the UPDATE returns 0 rows the row was already claimed.
  //
  // After a successful upstream /fire, the caller MUST call
  // update_pair_schedule_fired with the real session_id to settle the row.
  // On /fire failure, the caller MUST call update_pair_schedule_one_off_id
  // with scheduledOneOffId=null to release the claim for the next tick.
  claim_pair_schedule_for_fire: async (params) => {
    const tenantId = readTenantId(params);
    const id = readNumber(params, 'id');
    const claimToken = readString(params, 'claimToken');
    const db = getTenantDb(tenantId);
    const claimed = await db.drizzle
      .update(pairSchedules)
      .set({ scheduledOneOffId: claimToken })
      .where(
        and(
          eq(pairSchedules.tenantId, tenantId),
          eq(pairSchedules.id, id),
          eq(pairSchedules.status, 'scheduled'),
          isNull(pairSchedules.scheduledOneOffId),
        ),
      )
      .returning({ id: pairSchedules.id });
    return { rows: claimed, rowsAffected: claimed.length };
  },

  // v1.1 cron-pivot — settle a successfully-fired schedule. Sets
  // scheduled_one_off_id to the real session_id from /fire's response and
  // status='fired'. Idempotent against re-calls (the WHERE clause matches
  // the prior 'scheduled' state).
  update_pair_schedule_fired: async (params) => {
    const tenantId = readTenantId(params);
    const id = readNumber(params, 'id');
    const scheduledOneOffId = readString(params, 'scheduledOneOffId');
    const db = getTenantDb(tenantId);
    const updated = await db.drizzle
      .update(pairSchedules)
      .set({ scheduledOneOffId, status: 'fired' })
      .where(and(eq(pairSchedules.tenantId, tenantId), eq(pairSchedules.id, id)))
      .returning({ id: pairSchedules.id });
    return { rows: updated, rowsAffected: updated.length };
  },

  // Read open orders for a pair. Used by Executor for position-sizing.
  select_open_orders_for_pair: async (params) => {
    const tenantId = readTenantId(params);
    const pairCode = readString(params, 'pairCode');
    const db = getTenantDb(tenantId);
    const rows = await db.drizzle
      .select()
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), eq(orders.pair, pairCode), eq(orders.status, 'open')),
      );
    return { rows };
  },

  // Write one executor_reports row at end of Executor session (FR-015).
  // Schema columns: pair, session, reportMdBlobUrl, summaryMd, actionTaken,
  // routineRunId, tenantId.
  insert_executor_report: async (params) => {
    const tenantId = readTenantId(params);
    const pair = readString(params, 'pair');
    const session = readString(params, 'session');
    const reportMdBlobUrl = readOptionalString(params, 'reportMdBlobUrl');
    const summaryMd = readOptionalString(params, 'summaryMd');
    const actionTaken = readOptionalString(params, 'actionTaken');
    const routineRunId = readNumber(params, 'routineRunId');
    const db = getTenantDb(tenantId);
    const inserted = await db.drizzle
      .insert(executorReports)
      .values({
        tenantId,
        pair,
        session,
        reportMdBlobUrl,
        summaryMd,
        actionTaken,
        routineRunId,
      })
      .returning({ id: executorReports.id });
    return { rows: inserted, rowsAffected: inserted.length };
  },

  // Read recent telegram_interactions (Channels session "what did I say
  // yesterday" — bounded by LIMIT 50).
  select_recent_telegram_interactions: async (params) => {
    const tenantId = readTenantId(params);
    const db = getTenantDb(tenantId);
    const rows = await db.drizzle
      .select()
      .from(telegramInteractions)
      .where(eq(telegramInteractions.tenantId, tenantId))
      .orderBy(desc(telegramInteractions.repliedAt))
      .limit(50);
    return { rows };
  },

  /**
   * Insert a routine_runs row at the START of a Routine session — the
   * Planner/Executor's FIRST proxy call. Returns the inserted id which the
   * Routine then carries through every subsequent call and uses for the
   * audit settle (update_routine_run) at the end.
   *
   * Constitution §3 audit-or-abort: this query closes the gap session 5g
   * surfaced — under Path B (proxy gateway) the Routine has no direct
   * Postgres handle, so it CANNOT write the in-flight row itself the way
   * the prior TS-script Routines could. This wrapper gives Claude a
   * one-call shape that takes the place of `withAuditOrAbort`'s pre-fire
   * insert and returns the id Claude needs to round-trip through to the
   * settle step.
   *
   * Per constitution §15 LOUD: rejects unknown routine_name / routine_fire_kind
   * with a 400 from the route layer (we throw with a descriptive message
   * here that the route's catch maps to 500 after Drizzle would have
   * failed; cheaper to validate here before round-trip).
   *
   * Required params:
   *   tenantId: number
   *   routineName: 'planner' | 'executor' | 'spike_ac_001_*' | 'cap_status'
   *                | 'replan_orchestrator'
   *   routineFireKind: 'recurring' | 'scheduled_one_off' | 'fire_api'
   *                    | 'claude_run_bash'
   * Optional params:
   *   pair, sessionWindow, claudeCodeSessionId, claudeCodeSessionUrl,
   *   inputText
   *
   * Returns: { rows: [{ id: <new routine_runs.id> }], rowsAffected: 1 }
   */
  insert_routine_run: async (params) => {
    const tenantId = readTenantId(params);
    const routineName = readString(params, 'routineName');
    if (!ROUTINE_NAMES.has(routineName as RoutineName)) {
      throw new Error(
        `routineName must be one of: ${[...ROUTINE_NAMES].join(',')} — got '${routineName}'`,
      );
    }
    const routineFireKind = readString(params, 'routineFireKind');
    if (!ROUTINE_FIRE_KINDS.has(routineFireKind as RoutineFireKind)) {
      throw new Error(
        `routineFireKind must be one of: ${[...ROUTINE_FIRE_KINDS].join(',')} — got '${routineFireKind}'`,
      );
    }
    const pair = readOptionalString(params, 'pair');
    const sessionWindow = readOptionalString(params, 'sessionWindow');
    const claudeCodeSessionId = readOptionalString(params, 'claudeCodeSessionId');
    const claudeCodeSessionUrl = readOptionalString(params, 'claudeCodeSessionUrl');
    const inputText = readOptionalString(params, 'inputText');
    const db = getTenantDb(tenantId);
    const inserted = await db.drizzle
      .insert(routineRuns)
      .values({
        tenantId,
        routineName: routineName as RoutineName,
        routineFireKind: routineFireKind as RoutineFireKind,
        pair,
        sessionWindow,
        claudeCodeSessionId,
        claudeCodeSessionUrl,
        inputText,
        // status defaults to 'running' per schema; startedAt defaults to now()
      })
      .returning({ id: routineRuns.id });
    return { rows: inserted, rowsAffected: inserted.length };
  },

  // Update a routine_runs row to settle the in-flight audit row at exit
  // (constitution §3 audit-or-abort).
  update_routine_run: async (params) => {
    const tenantId = readTenantId(params);
    const id = readNumber(params, 'id');
    const status = readString(params, 'status'); // 'completed' | 'failed'
    const failureReason = readOptionalString(params, 'failureReason');
    const outputJson = params.outputJson;
    const db = getTenantDb(tenantId);
    const updated = await db.drizzle
      .update(routineRuns)
      .set({
        status: status as 'completed' | 'failed',
        endedAt: new Date(),
        failureReason,
        outputJson: (outputJson ?? null) as Record<string, unknown> | null,
      })
      .where(and(eq(routineRuns.tenantId, tenantId), eq(routineRuns.id, id)))
      .returning({ id: routineRuns.id });
    return { rows: updated, rowsAffected: updated.length };
  },

  // Cap-status read for the Planner's "should I fire executors today" check.
  select_cap_status: async (params) => {
    const tenantId = readTenantId(params);
    const date = readString(params, 'date'); // YYYY-MM-DD GMT
    const db = getTenantDb(tenantId);
    const rows = await db.drizzle
      .select({
        dailyUsed: capUsage.dailyUsed,
        dailyLimit: capUsage.dailyLimit,
      })
      .from(capUsage)
      .where(and(eq(capUsage.tenantId, tenantId), eq(capUsage.date, date)))
      .orderBy(desc(capUsage.recordedAt))
      .limit(1);
    return { rows };
  },
};

export const KNOWN_QUERY_NAMES = Object.keys(handlers);

export async function runNamedQuery(req: NamedQueryRequest): Promise<NamedQueryResult> {
  const handler = handlers[req.name];
  if (!handler) {
    throw new Error(`unknown query name: ${req.name}`);
  }
  return await handler(req.params);
}
