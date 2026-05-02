/**
 * FR-002 AC-002-2g + FR-018 AC-018-2 + AC-018-2-b — `pair_schedules` table.
 *
 * Each row represents the Planner's decision: "Pair X should fire its Executor
 * during session Y on date D" (or "no window — skip"). The Executor's pre-fire
 * stale-check (R3) reads its own row to noop if the row was cancelled by a
 * re-plan that happened between scheduling and firing.
 *
 * Schema deltas (Round 2 R3): scheduled_one_off_id stores Anthropic's one-off
 * ID so the Executor can compare against $ANTHROPIC_ONE_OFF_ID env var.
 */

import { date, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { pairScheduleStatus } from './enums';
import { routineRuns } from './routine-runs';
import { tenants } from './tenants';

export const pairSchedules = pgTable(
  'pair_schedules',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    pairCode: text('pair_code').notNull(),
    sessionName: text('session_name').notNull(),
    /** Empty Planner output → NULL (skipped_no_window). */
    startTimeGmt: timestamp('start_time_gmt', { withTimezone: true }),
    endTimeGmt: timestamp('end_time_gmt', { withTimezone: true }),
    plannerRunId: integer('planner_run_id').references(() => routineRuns.id, {
      onDelete: 'set null',
    }),
    /** Anthropic one-off ID (R3 — Executor pre-fire stale-check compares this). */
    scheduledOneOffId: text('scheduled_one_off_id'),
    status: pairScheduleStatus('status').notNull().default('scheduled'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pair_schedules_tenant_date_idx').on(t.tenantId, t.date),
    index('pair_schedules_tenant_pair_date_idx').on(t.tenantId, t.pairCode, t.date),
  ],
);

export type PairSchedule = typeof pairSchedules.$inferSelect;
export type NewPairSchedule = typeof pairSchedules.$inferInsert;
