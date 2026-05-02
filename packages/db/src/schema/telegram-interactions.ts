/**
 * FR-007 AC-007-2 + FR-004 AC-004-6 + FR-005 AC-005-1 —
 * `telegram_interactions` table.
 *
 * Round 2 R5 deltas (proposal Round 2):
 *   - command_parsed text token gains 'SYNTHETIC_PING' (R5 fallback signal
 *     the 30-min Vercel cron writes; same wrapper-script path as a real
 *     operator message, so a dead session leaves replied_at=NULL forever).
 *   - NEW index on (tenant_id, replied_at DESC) — for the healthcheck
 *     handler's MAX(replied_at) query (R5 driver).
 *
 * Constitution §3: the wrapper script writes the row BEFORE handing the
 * message to the Channels session. Constitution §4: tenant_id NOT NULL.
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const telegramInteractions = pgTable(
  'telegram_interactions',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL until the Channels session finishes its reply (R5 healthcheck signal). */
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    fromUserId: bigint('from_user_id', { mode: 'bigint' }).notNull(),
    messageText: text('message_text').notNull(),
    /**
     * Slash command name OR one of the special tokens:
     *   FREE_TEXT             — free-form Q&A
     *   REJECTED_NOT_ALLOWED  — sender not in allowlist (AC-004-6)
     *   SYNTHETIC_PING        — R5 cron fallback signal
     */
    commandParsed: text('command_parsed').notNull(),
    toolCallsMadeJson: jsonb('tool_calls_made_json'),
    replyText: text('reply_text'),
    claudeCodeSessionId: text('claude_code_session_id'),
  },
  (t) => [
    index('tg_interactions_tenant_received_idx').on(t.tenantId, t.receivedAt.desc()),
    index('tg_interactions_tenant_user_received_idx').on(
      t.tenantId,
      t.fromUserId,
      t.receivedAt.desc(),
    ),
    // R5 — for the healthcheck handler's MAX(replied_at) query.
    index('tg_interactions_tenant_replied_idx').on(t.tenantId, t.repliedAt.desc()),
  ],
);

export type TelegramInteraction = typeof telegramInteractions.$inferSelect;
export type NewTelegramInteraction = typeof telegramInteractions.$inferInsert;
