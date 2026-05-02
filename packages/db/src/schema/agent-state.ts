/**
 * FR-017 AC-017-1 — `agent_state` table.
 *
 * Singleton-per-tenant: each tenant has exactly one row keyed by tenant_id.
 * Stores the global pause/resume state of the trading agent. The Planner +
 * Executor + Channels session all read this table BEFORE firing.
 *
 * Constitution §4: tenant_id IS the primary key (single row per tenant).
 */

import { boolean, integer, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const agentState = pgTable(
  'agent_state',
  {
    tenantId: integer('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    pausedBool: boolean('paused_bool').notNull().default(false),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedBy: integer('paused_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ columns: [t.tenantId] })],
);

export type AgentState = typeof agentState.$inferSelect;
export type NewAgentState = typeof agentState.$inferInsert;
