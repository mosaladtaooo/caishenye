/**
 * FR-007 AC-007-3 + AC-007-3-b + FR-016 + FR-017 + FR-018 —
 * `override_actions` table.
 *
 * Round 2 R4 deltas (proposal Round 2):
 *   - success      → NULLABLE. null = in-flight (between step 4 and step 7
 *                     of the override-handler 7-step flow, or between Tx A
 *                     and Tx B of the replan split-tx flow). The orphan-
 *                     detect cron picks up rows older than 5 min still in
 *                     the in-flight state.
 *   - before_state_json → NULLABLE. null = MT5 read failed before any state
 *                          could be captured (R4 boundary (a)).
 *   - after_state_json  → NULLABLE. null = same reason, or audit insert
 *                          failed before the write attempt.
 *
 * AC-007-3-b: every override's `before_state_json` MUST be the result of a
 * server-side MT5 REST read performed BEFORE any state-mutating call. The
 * 7-step flow in `lib/override-handler.ts` (FR-016) enforces this.
 *
 * Constitution §11: every override writes an audit row. Override actions
 * that don't refuse to execute (audit-or-abort applied to overrides).
 *
 * Constitution §4: tenant_id NOT NULL.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { overrideActionType } from './enums';
import { tenants } from './tenants';
import { users } from './users';

export const overrideActions = pgTable(
  'override_actions',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    operatorUserId: integer('operator_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    actionType: overrideActionType('action_type').notNull(),
    targetPair: text('target_pair'),
    targetTicket: bigint('target_ticket', { mode: 'bigint' }),
    paramsJson: jsonb('params_json'),
    /** R4 — captured from MT5 read BEFORE state-mutating call. NULLABLE. */
    beforeStateJson: jsonb('before_state_json'),
    /** R4 — captured from post-write MT5 read OR write-response. NULLABLE. */
    afterStateJson: jsonb('after_state_json'),
    /** R4 — null = in-flight. true/false after settle. */
    success: boolean('success'),
    errorMessage: text('error_message'),
  },
  (t) => [index('override_actions_tenant_at_idx').on(t.tenantId, t.at.desc())],
);

export type OverrideAction = typeof overrideActions.$inferSelect;
export type NewOverrideAction = typeof overrideActions.$inferInsert;
