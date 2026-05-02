/**
 * FR-008 — `tenants` table.
 *
 * Constitution §4: every table that holds operator data has a tenant_id. The
 * `tenants` table itself is the lookup; v1 ships with a single row (id=1).
 *
 * `allowed_telegram_user_ids` (jsonb int[]) gates the Channels session per
 * FR-004 AC-004-6. Operator IDs are populated by `infra/vps/setup.sh` from
 * the `ALLOWED_TELEGRAM_USER_IDS` env var.
 */

import { jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  /** jsonb array of integer Telegram user IDs (AC-004-6). */
  allowedTelegramUserIds: jsonb('allowed_telegram_user_ids')
    .$type<number[]>()
    .notNull()
    .default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
