/**
 * FR-023 D4 -- SimpleWebAuthn schema (replaces Auth.js v5 WebAuthn beta).
 *
 * Two tables:
 *   - webauthn_credentials: one row per registered passkey (phone + laptop
 *     authenticators per operator).
 *   - webauthn_challenges: short-lived challenges for register / authenticate
 *     flows. Each row is consumed (consumed_at set) on verify or rejected
 *     after expires_at.
 *
 * Constitution section 4: tenant_id NOT NULL with FK to tenants.
 * Constitution section 16: snake_case columns, kebab-case file.
 *
 * Stale challenge sweep: the existing /api/cron/audit-archive cron at
 * 03:30 GMT (FR-007 EC-007-2) is extended in v1.2 to also DELETE rows
 * where expires_at < now() - interval '5 minutes'. Per clarify Q1 -- soft
 * cap against Postgres-row-flooding from the public pre-auth WebAuthn
 * endpoints.
 *
 * v13 SimpleWebAuthn types: WebAuthnCredential.publicKey is Uint8Array;
 * AuthenticatorTransportFuture[] is the type of the transports column.
 */

import {
  bigint,
  customType,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// drizzle-orm 0.39.x doesn't export bytea / text[] helpers directly from
// pg-core; we declare them via customType. publicKey is BYTEA (Uint8Array
// from @simplewebauthn/server's WebAuthnCredential.publicKey). transports
// is TEXT[] (e.g., ['internal', 'hybrid']).
const bytea_ = customType<{ data: Uint8Array; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});
const textArray = customType<{ data: string[]; default: false; notNull: false }>({
  dataType() {
    return 'text[]';
  },
});

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** base64url credential id (unique across all tenants). */
    credentialId: text('credential_id').notNull(),
    /** COSE-formatted public key bytes from @simplewebauthn/server. */
    publicKey: bytea_('public_key').notNull(),
    /** Replay-protection counter -- bumped on every authenticate-verify success. */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    /** AuthenticatorTransportFuture[] -- e.g., ['internal'], ['hybrid', 'usb']. */
    transports: textArray('transports').notNull().default([]),
    /** Operator-set label visible in the UI ("phone", "laptop"). */
    nickname: text('nickname'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('webauthn_credentials_credential_id_unique').on(t.credentialId),
    index('webauthn_credentials_tenant_id_idx').on(t.tenantId),
  ],
);

export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: serial('id').primaryKey(),
    tenantId: integer('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** base64url challenge string. */
    challenge: text('challenge').notNull(),
    /** 'register' | 'authenticate' (not pgEnum because the surface is small + stable). */
    purpose: text('purpose').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** created_at + 5 minutes per AC-023-2 timing. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on successful verify; null while still pending. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('webauthn_challenges_tenant_purpose_idx').on(t.tenantId, t.purpose)],
);

export type WebAuthnCredentialRow = typeof webauthnCredentials.$inferSelect;
export type NewWebAuthnCredential = typeof webauthnCredentials.$inferInsert;
export type WebAuthnChallengeRow = typeof webauthnChallenges.$inferSelect;
export type NewWebAuthnChallenge = typeof webauthnChallenges.$inferInsert;
