/**
 * FR-007 AC-007-1 + EC-007-1 — `withAuditOrAbort` wrapper.
 *
 * Constitution §3 audit-or-abort: every Routine + spike + cron + replan
 * orchestrator MUST write a `routine_runs` row BEFORE making any external
 * tool call (MT5 REST, ForexFactory MCP, Postgres write, Telegram).
 *
 * If the audit insert fails → throw immediately, do NOT call work().
 * If work() succeeds → update audit row with status='completed' + output.
 * If work() throws → update audit row with status='failed' + error message,
 *                    then re-throw (caller decides recovery).
 *
 * EC-007-1: Postgres unreachable pre-tool-call → row insert throws → work()
 * is never called → no side effects on MT5 or Telegram. The orphan-detect
 * cron picks up runs stuck in 'running' state if the AUDIT UPDATE fails
 * post-work (R3-followup orphan recovery).
 */

import { eq } from 'drizzle-orm';
import type { TenantDb } from './client';
import { type NewRoutineRun, type RoutineRun, routineRuns } from './schema/routine-runs';

export interface WithAuditOrAbortInput {
  /** Routine name from the routine_run_routine_name enum (see schema/enums.ts). */
  routineName: NewRoutineRun['routineName'];
  /** How this routine was fired (recurring / one-off / fire / claude-run). */
  routineFireKind: NewRoutineRun['routineFireKind'];
  pair?: string | null;
  sessionWindow?: string | null;
  claudeCodeSessionId?: string | null;
  claudeCodeSessionUrl?: string | null;
  inputText?: string | null;
}

export interface WithAuditOrAbortContext {
  /** Audit row id (caller can reference for downstream writes — orders.source_id). */
  routineRunId: number;
  /** Tenant scope for this run (mirrors db.tenantId for convenience). */
  tenantId: number;
}

/**
 * Wrap a routine's body in audit-or-abort discipline.
 *
 * Usage (FR-002 Planner example):
 *
 *   await withAuditOrAbort(db, {
 *     routineName: 'planner',
 *     routineFireKind: 'recurring',
 *     inputText: 'daily-12:00-GMT',
 *   }, async (ctx) => {
 *     // Do the work. Throw on failure.
 *     return { schedules: [...] };
 *   });
 *
 * If the audit-row insert throws (DB unreachable per EC-007-1), `work` is
 * NEVER invoked — guarantee for the caller's recovery logic.
 */
export async function withAuditOrAbort<T>(
  db: TenantDb,
  input: WithAuditOrAbortInput,
  work: (ctx: WithAuditOrAbortContext) => Promise<T>,
): Promise<T> {
  // 1. Insert the start row. If THIS throws, propagate immediately.
  const [start] = await db.drizzle
    .insert(routineRuns)
    .values({
      tenantId: db.tenantId,
      routineName: input.routineName,
      routineFireKind: input.routineFireKind,
      pair: input.pair ?? null,
      sessionWindow: input.sessionWindow ?? null,
      claudeCodeSessionId: input.claudeCodeSessionId ?? null,
      claudeCodeSessionUrl: input.claudeCodeSessionUrl ?? null,
      inputText: input.inputText ?? null,
      status: 'running',
    })
    .returning();

  if (!start) {
    // Defensive: Drizzle's typed return should always populate this, but
    // surface a loud failure if Postgres returned an empty result set.
    throw new Error('audit-or-abort: insert succeeded but RETURNING produced no row');
  }

  const ctx: WithAuditOrAbortContext = {
    routineRunId: start.id,
    tenantId: db.tenantId,
  };

  // 2. Run the work. Capture success or failure.
  let result: T;
  try {
    result = await work(ctx);
  } catch (e) {
    // 2a. Mark as failed. If THIS update itself fails, the row stays in
    // 'running' state — orphan-detect cron picks it up after the threshold.
    await safeUpdate(db, start.id, {
      status: 'failed',
      endedAt: new Date(),
      failureReason: stringifyError(e),
    });
    throw e;
  }

  // 3. Mark as completed.
  await safeUpdate(db, start.id, {
    status: 'completed',
    endedAt: new Date(),
    outputJson: jsonOrNull(result),
  });

  return result;
}

/**
 * Best-effort UPDATE that swallows errors — the Routine has done its work;
 * leaving the audit row inconsistent is recoverable via orphan-detect cron,
 * but throwing here would cancel a successful work() result.
 */
async function safeUpdate(db: TenantDb, id: number, patch: Partial<RoutineRun>): Promise<void> {
  try {
    await db.drizzle.update(routineRuns).set(patch).where(eq(routineRuns.id, id));
  } catch (e) {
    // Constitution §17 — no silent catches. We log + return; the row is
    // recoverable via orphan-detect cron.
    process.stderr.write(
      `[audit-or-abort] warning: routine_runs.id=${id} update failed: ${stringifyError(e)}\n`,
    );
  }
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

function jsonOrNull(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'function') return null;
  return v;
}
