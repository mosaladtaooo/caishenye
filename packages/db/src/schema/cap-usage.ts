/**
 * FR-021 AC-021-1 — `cap_usage_local` + `cap_usage` tables (per ADR-008).
 *
 * `cap_usage_local` is the v1 source of truth: every code path that burns
 * subscription cap inserts a row (Planner fire, Executor one-off, replan,
 * cap-status cron itself). The dashboard cap progress bar reads from here.
 *
 * `cap_usage` is the rolled-up daily view. The 12:00 GMT cap-rollup cron
 * (FR-021) summarises yesterday's `cap_usage_local` rows into a single
 * `cap_usage` row keyed by (tenant_id, date, source). If the FR-001 spike
 * confirms `/v1/usage` exists, a second row per date with
 * source='anthropic_api' is written for cross-check.
 *
 * Constitution §4: tenant_id NOT NULL.
 */

import { date, index, integer, pgTable, serial, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { capUsageLocalKind, capUsageSource } from './enums';
import { routineRuns } from './routine-runs';
import { tenants } from './tenants';

export const capUsageLocal = pgTable(
  'cap_usage_local',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    capKind: capUsageLocalKind('cap_kind').notNull(),
    routineRunsId: integer('routine_runs_id').references(() => routineRuns.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('cap_usage_local_tenant_at_idx').on(t.tenantId, t.at.desc())],
);

export const capUsage = pgTable(
  'cap_usage',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    dailyUsed: integer('daily_used').notNull(),
    dailyLimit: integer('daily_limit').notNull().default(15),
    weeklyUsed: integer('weekly_used').notNull(),
    weeklyLimit: integer('weekly_limit').notNull(),
    source: capUsageSource('source').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cap_usage_tenant_date_idx').on(t.tenantId, t.date),
    // ADR-008 reconciliation: one local-counter row + optionally one
    // anthropic-api row per (tenant, date). Unique constraint enforces this.
    uniqueIndex('cap_usage_tenant_date_source_uq').on(t.tenantId, t.date, t.source),
  ],
);

export type CapUsageLocal = typeof capUsageLocal.$inferSelect;
export type NewCapUsageLocal = typeof capUsageLocal.$inferInsert;
export type CapUsage = typeof capUsage.$inferSelect;
export type NewCapUsage = typeof capUsage.$inferInsert;
