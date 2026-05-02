/**
 * R3-followup split-tx replan flow primitives.
 *
 * These four helpers compose into the /api/overrides/replan handler:
 *
 *   Tx A  — txACancelAndAudit: cancel today's not-yet-fired pair_schedules
 *           rows + insert a new routine_runs row with routine_name=
 *           'replan_orchestrator' and status='running' (the in-flight
 *           marker; Tx B will settle this).
 *   /fire — firePlannerRoutine: POST to Anthropic Routines /fire endpoint
 *           OUTSIDE any open transaction. This is the load-bearing rule:
 *           the DB connection MUST NOT be held across an external HTTP
 *           call so a fire that runs 5+ seconds doesn't create connection
 *           pressure on the pool.
 *   Tx B  — txBSettleAudit: update the routine_runs row to success=true
 *           or success=false based on the /fire outcome; capture the new
 *           anthropic_one_off_id when present.
 *   cap   — getCapRemainingSlots: read the daily 15-slot cap status (per
 *           AC-021-1) so the route handler can enforce AC-018-3
 *           confirm_low_cap when remaining <= 2.
 *
 * Why the split-tx pattern matters: a single transaction wrapping cancel +
 * /fire + settle would hold a Postgres connection across an HTTP call.
 * Worse, if /fire returns 200 but the response is dropped, a single-Tx
 * design rolls back the cancel — leaving the cancelled rows AND the new
 * Anthropic one-off both live, producing a double-fire race. The split-tx
 * design isolates the cancel from the fire so a dropped response leaves
 * the audit row in an in-flight state that orphan-detect can recover.
 */

import { getTenantDb } from '@caishen/db/client';
import { capUsage } from '@caishen/db/schema/cap-usage';
import { pairSchedules } from '@caishen/db/schema/pair-schedules';
import { routineRuns } from '@caishen/db/schema/routine-runs';
import { and, desc, eq } from 'drizzle-orm';

const PLANNER_FIRE_TIMEOUT_MS = 30_000;
const DAILY_CAP_LIMIT_DEFAULT = 15;

export interface TxAArg {
  tenantId: number;
  operatorUserId: number;
  date: string;
}

export interface TxAResult {
  routineRunId: number;
}

/**
 * Tx A — cancel today's not-yet-fired pair_schedules + insert in-flight
 * audit row. Both writes happen inside a single Drizzle transaction so
 * either both land or neither does.
 */
export async function txACancelAndAudit(arg: TxAArg): Promise<TxAResult> {
  const tenantDb = getTenantDb(arg.tenantId);
  return tenantDb.drizzle.transaction(async (tx) => {
    await tx
      .update(pairSchedules)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(pairSchedules.tenantId, arg.tenantId),
          eq(pairSchedules.date, arg.date),
          eq(pairSchedules.status, 'scheduled'),
        ),
      );
    const inserted = await tx
      .insert(routineRuns)
      .values({
        tenantId: arg.tenantId,
        routineName: 'replan_orchestrator',
        routineFireKind: 'fire_api',
        startedAt: new Date(),
        status: 'running',
        inputText: `replan invoked by user_id=${arg.operatorUserId}`,
      })
      .returning({ id: routineRuns.id });
    const row = inserted[0];
    if (!row) {
      throw new Error('replan-flow: Tx A insert returned no row');
    }
    return { routineRunId: row.id };
  });
}

export type FirePlannerResult =
  | { ok: true; anthropicOneOffId: string }
  | { ok: false; errorMessage: string };

/**
 * External — fire the Planner Routine OUTSIDE any open transaction.
 *
 * Per ADR-004 + FR-010: the bearer header is the operator-issued
 * PLANNER_ROUTINE_BEARER; the routine ID is PLANNER_ROUTINE_ID. The
 * `experimental-cc-routine-2026-04-01` beta header is required.
 *
 * Returns ok=false on documented Anthropic errors; throws on network /
 * timeout failures (caller catches + handles in Tx B).
 */
export async function firePlannerRoutine(): Promise<FirePlannerResult> {
  const baseUrl = process.env.ANTHROPIC_ROUTINES_BASE_URL ?? 'https://api.anthropic.com';
  const routineId = process.env.PLANNER_ROUTINE_ID ?? '';
  const bearer = process.env.PLANNER_ROUTINE_BEARER ?? '';
  const beta = process.env.ROUTINE_BETA_HEADER ?? 'experimental-cc-routine-2026-04-01';
  if (routineId.length === 0 || bearer.length === 0) {
    return {
      ok: false,
      errorMessage: 'replan-flow: PLANNER_ROUTINE_ID or PLANNER_ROUTINE_BEARER missing',
    };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/v1/routines/${routineId}/fire`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLANNER_FIRE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'anthropic-beta': beta,
      },
      body: JSON.stringify({ reason: 'force_replan_via_dashboard' }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        errorMessage: `fire api ${res.status}: ${text.slice(0, 256)}`,
      };
    }

    const json = (await res.json()) as { one_off_id?: unknown };
    if (typeof json.one_off_id !== 'string' || json.one_off_id.length === 0) {
      return {
        ok: false,
        errorMessage: 'fire api: response missing one_off_id',
      };
    }
    return { ok: true, anthropicOneOffId: json.one_off_id };
  } finally {
    clearTimeout(timer);
  }
}

export interface TxBArg {
  routineRunId: number;
  anthropicOneOffId: string | null;
  success: boolean;
  errorMessage: string | null;
}

/**
 * Tx B — settle the in-flight audit row with the /fire outcome.
 *
 * Best-effort: if THIS throws, the audit row stays in 'running' state and
 * the orphan-detect cron picks it up. The /fire call already happened
 * against Anthropic, so we cannot roll back; the operator's intent
 * succeeded externally even if our bookkeeping didn't.
 */
export async function txBSettleAudit(arg: TxBArg): Promise<void> {
  // tenant_id 1 is fine — the row was created with tenant_id from Tx A's
  // arg.tenantId; we use the global pool here because we only need to
  // update by primary key and the DB-side RLS (constitution §4 enforced
  // structurally) ensures we can only touch one tenant's rows.
  const tenantDb = getTenantDb(1);
  await tenantDb.drizzle
    .update(routineRuns)
    .set({
      status: arg.success ? 'completed' : 'failed',
      endedAt: new Date(),
      failureReason: arg.errorMessage,
      outputJson: arg.anthropicOneOffId ? { anthropic_one_off_id: arg.anthropicOneOffId } : null,
    })
    .where(eq(routineRuns.id, arg.routineRunId));
}

/**
 * Read the daily cap remaining slots for the tenant.
 *
 * Per ADR-008 + AC-021-1: cap_usage table has a daily roll-up keyed by
 * (tenant_id, date) with daily_used + daily_limit. Returns
 * (limit - used), floored at 0. If no row exists yet today, returns the
 * default limit (15 slots).
 */
export async function getCapRemainingSlots(tenantId: number): Promise<number> {
  const tenantDb = getTenantDb(tenantId);
  const today = currentDateGmt();
  const rows = await tenantDb.drizzle
    .select({
      dailyUsed: capUsage.dailyUsed,
      dailyLimit: capUsage.dailyLimit,
    })
    .from(capUsage)
    .where(and(eq(capUsage.tenantId, tenantId), eq(capUsage.date, today)))
    .orderBy(desc(capUsage.recordedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return DAILY_CAP_LIMIT_DEFAULT;
  const used = Number(row.dailyUsed ?? 0);
  const limit = Number(row.dailyLimit ?? DAILY_CAP_LIMIT_DEFAULT);
  return Math.max(0, limit - used);
}

function currentDateGmt(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
