/**
 * FR-007 AC-007-4 + FR-015 + FR-016 — `orders` table.
 *
 * Mirrors MT5 orders the system has placed (or intentionally NOT placed —
 * `no_trade` and `rejected_by_risk` are real outcomes the SPARTAN prompt
 * produces). source_table + source_id back-reference points at whatever audit
 * row decided the order (executor routine_run, override action, etc.).
 *
 * Constitution §4: tenant_id NOT NULL.
 */

import {
  bigint,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { orderStatus, orderType } from './enums';
import { tenants } from './tenants';

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** MT5 ticket — bigint because MT5 tickets fit comfortably in i64. */
    mt5Ticket: bigint('mt5_ticket', { mode: 'bigint' }),
    pair: text('pair').notNull(),
    /** Cleaned MT5 symbol (NEVER 'XAUUSDF' — see AC-003-3 hard test). */
    mt5Symbol: text('mt5_symbol').notNull(),
    type: orderType('type').notNull(),
    volume: numeric('volume', { precision: 18, scale: 6 }),
    price: numeric('price', { precision: 18, scale: 6 }),
    sl: numeric('sl', { precision: 18, scale: 6 }),
    tp: numeric('tp', { precision: 18, scale: 6 }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Audit back-reference — which table caused this order to exist. */
    sourceTable: text('source_table').notNull(),
    sourceId: bigint('source_id', { mode: 'bigint' }).notNull(),
    status: orderStatus('status').notNull().default('open'),
    pnl: numeric('pnl', { precision: 18, scale: 6 }),
  },
  (t) => [
    index('orders_tenant_opened_idx').on(t.tenantId, t.openedAt.desc()),
    index('orders_tenant_ticket_idx').on(t.tenantId, t.mt5Ticket),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
