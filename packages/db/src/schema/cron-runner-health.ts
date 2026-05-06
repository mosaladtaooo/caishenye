/**
 * FR-024 D5 -- cron_runner_health.
 *
 * Liveness ping table written by /api/cron/health (POST). The VPS-NSSM
 * cron-runner inserts one row per tick (every 60s) so the Vercel-cron
 * watchdog backstop (/api/cron/runner-watchdog) can detect runner death
 * by looking at MAX(pinged_at) staleness.
 *
 * Constitution section 4: tenant_id on every row.
 * Constitution section 16: snake_case columns, kebab-case file.
 *
 * Indexes per AC-024-3:
 *   - (pinged_at DESC)                                     -- watchdog scan
 *   - (tenant_id, runner_id, pinged_at DESC) -- self-watch previous-tick lookup
 */

import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const cronRunnerHealth = pgTable(
  'cron_runner_health',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    runnerId: text('runner_id').notNull(),
    pingedAt: timestamp('pinged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cron_runner_health_pinged_idx').on(t.pingedAt.desc()),
    index('cron_runner_health_runner_pinged_idx').on(t.tenantId, t.runnerId, t.pingedAt.desc()),
  ],
);

export type CronRunnerHealth = typeof cronRunnerHealth.$inferSelect;
export type NewCronRunnerHealth = typeof cronRunnerHealth.$inferInsert;
