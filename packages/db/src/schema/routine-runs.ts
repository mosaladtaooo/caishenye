/**
 * FR-007 + FR-002 + FR-003 — `routine_runs` audit table.
 *
 * Constitution §3 audit-or-abort: every Routine + spike + cron + replan
 * orchestrator MUST write a row HERE before any external tool call.
 *
 * Round 2 R3 delta: routine_name enum gains `replan_orchestrator` so the
 * dashboard's /api/overrides/replan handler can wrap its split-tx flow in
 * withAuditOrAbort and the orphan-detect cron can recover stuck runs.
 *
 * Indexes per AC-008-3:
 *   - (tenant_id, started_at DESC) — main timeline read pattern
 *   - (tenant_id, routine_name, started_at DESC) — per-routine drilldown
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { routineFireKind, routineRunRoutineName, routineRunStatus } from './enums';
import { tenants } from './tenants';

export const routineRuns = pgTable(
  'routine_runs',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    routineName: routineRunRoutineName('routine_name').notNull(),
    /** Pair this run was scoped to (null for Planner + spike + cap_status). */
    pair: text('pair'),
    /** Trading session this run was scoped to ('EUR' | 'NY' | 'ASIA' | null). */
    sessionWindow: text('session_window'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Anthropic-issued session ID for the routine fire. */
    claudeCodeSessionId: text('claude_code_session_id'),
    /** Anthropic UI link to the session (FR-007 AC-007-5). */
    claudeCodeSessionUrl: text('claude_code_session_url'),
    /** Free-form input prompt or description. */
    inputText: text('input_text'),
    /** Structured output (Planner schedule, Executor decision, spike outcome). */
    outputJson: jsonb('output_json'),
    toolCallsCount: integer('tool_calls_count').notNull().default(0),
    status: routineRunStatus('status').notNull().default('running'),
    failureReason: text('failure_reason'),
    degraded: boolean('degraded').notNull().default(false),
    routineFireKind: routineFireKind('routine_fire_kind').notNull(),
  },
  (t) => [
    index('routine_runs_tenant_started_at_idx').on(t.tenantId, t.startedAt.desc()),
    index('routine_runs_tenant_name_started_at_idx').on(
      t.tenantId,
      t.routineName,
      t.startedAt.desc(),
    ),
  ],
);

export type RoutineRun = typeof routineRuns.$inferSelect;
export type NewRoutineRun = typeof routineRuns.$inferInsert;
