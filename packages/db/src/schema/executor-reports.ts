/**
 * FR-015 AC-015-2 — `executor_reports` table.
 *
 * The Executor uploads its full report markdown to Vercel Blob and stores the
 * URL here, plus a degraded-fallback `summary_md` that survives even when the
 * Blob upload fails (FR-015 EC-015-1).
 *
 * Constitution §4: tenant_id NOT NULL.
 */

import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { routineRuns } from './routine-runs';
import { tenants } from './tenants';

export const executorReports = pgTable(
  'executor_reports',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    routineRunId: integer('routine_run_id')
      .notNull()
      .references(() => routineRuns.id, { onDelete: 'cascade' }),
    pair: text('pair').notNull(),
    session: text('session').notNull(),
    /** Vercel Blob URL — signed via /api/reports/[id] for dashboard reads. */
    reportMdBlobUrl: text('report_md_blob_url'),
    /** Degraded fallback when Blob upload fails (FR-015 EC-015-1). */
    summaryMd: text('summary_md'),
    actionTaken: text('action_taken'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('executor_reports_tenant_created_idx').on(t.tenantId, t.createdAt.desc())],
);

export type ExecutorReport = typeof executorReports.$inferSelect;
export type NewExecutorReport = typeof executorReports.$inferInsert;
