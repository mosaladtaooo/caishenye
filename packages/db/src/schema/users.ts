/**
 * FR-008 — `users` table + Auth.js DrizzleAdapter tables.
 *
 * Constitution §4: tenant_id NOT NULL.
 * NFR-009: Auth.js v5 + WebAuthn passkeys provider. The four DrizzleAdapter
 * tables (accounts, sessions, verification_tokens, authenticators) co-locate
 * here so a single Drizzle schema covers both app users + Auth.js.
 *
 * Reference for Auth.js DrizzleAdapter shape:
 *   https://authjs.dev/getting-started/adapters/drizzle (v5)
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .default(1)
      .references(() => tenants.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    /** Auth.js compatibility — emailVerified is part of the Adapter contract. */
    emailVerified: timestamp('email_verified', { withTimezone: true }),
    /** Auth.js compatibility — image URL or base64 (optional). */
    image: text('image'),
    /** Auth.js compatibility — display name (optional). */
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

/**
 * Auth.js OAuth `accounts` table — required by DrizzleAdapter even when only
 * Passkey is enabled (Adapter writes session-bookkeeping rows here).
 */
export const accounts = pgTable(
  'accounts',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

/** Auth.js sessions table. */
export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
});

/** Auth.js verification_tokens table (used by email + passkey flows). */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/**
 * Auth.js authenticators table — Passkey credentials. v5 requires this
 * specific shape for the WebAuthn provider.
 */
export const authenticators = pgTable(
  'authenticators',
  {
    credentialID: text('credential_id').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id').notNull(),
    credentialPublicKey: text('credential_public_key').notNull(),
    counter: integer('counter').notNull(),
    credentialDeviceType: text('credential_device_type').notNull(),
    credentialBackedUp: boolean('credential_backed_up').notNull(),
    transports: text('transports'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.credentialID] })],
);

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  authenticators: many(authenticators),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
