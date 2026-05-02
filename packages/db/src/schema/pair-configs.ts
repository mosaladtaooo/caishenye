/**
 * FR-011 — `pair_configs` table. Composite PK = (tenant_id, pair_code).
 *
 * Stores the per-pair MT5 symbol mapping + the JSON of allowed sessions
 * (e.g., `["EUR","NY"]`). FR-012 seed populates the v1 pair list.
 *
 * Constitution §4: tenant_id NOT NULL.
 */

import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const pairConfigs = pgTable(
  'pair_configs',
  {
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    pairCode: text('pair_code').notNull(),
    /** MT5 symbol — e.g., "EURUSD", "XAUUSD" (note: NO 'F' suffix per AC-003-3). */
    mt5Symbol: text('mt5_symbol').notNull(),
    /** Sessions this pair trades — jsonb array, e.g., ["EUR","NY"]. */
    sessionsJson: jsonb('sessions_json').$type<string[]>().notNull(),
    activeBool: boolean('active_bool').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.pairCode] })],
);

export type PairConfig = typeof pairConfigs.$inferSelect;
export type NewPairConfig = typeof pairConfigs.$inferInsert;
