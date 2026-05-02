/**
 * FR-005 AC-005-1 + AC-005-2 + ADR-009 — `channels_health` table.
 *
 * Vercel cron `/api/cron/channels-health` writes a row every 5 minutes with
 * the result of querying the VPS healthcheck endpoint. Three-strikes-and-
 * out alerting reads from this table.
 *
 * ADR-009 restart-on-idle: `mute_alarm_until` lets the restart script
 * suppress the next ≤90s of "down" alerts during a planned restart window.
 *
 * Constitution §4: tenant_id NOT NULL.
 */

import { boolean, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { channelsRestartReason } from './enums';
import { tenants } from './tenants';

export const channelsHealth = pgTable(
  'channels_health',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    healthyBool: boolean('healthy_bool').notNull(),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    restartReason: channelsRestartReason('restart_reason'),
    /** ADR-009 — 90s mute marker the restart-on-idle script writes. */
    muteAlarmUntil: timestamp('mute_alarm_until', { withTimezone: true }),
  },
  (t) => [index('channels_health_tenant_checked_idx').on(t.tenantId, t.checkedAt.desc())],
);

export type ChannelsHealth = typeof channelsHealth.$inferSelect;
export type NewChannelsHealth = typeof channelsHealth.$inferInsert;
