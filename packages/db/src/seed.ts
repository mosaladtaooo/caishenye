/**
 * FR-012 — V1 pair list seed.
 *
 * Per AC-012-1: insert EUR/USD, EUR/JPY, EUR/GBP, USD/JPY, GBP/USD, USD/CAD,
 * XAU/USD (mt5_symbol = XAUUSD, NOT XAUUSDF — see AC-003-3).
 * Per AC-012-2: GBP/JPY is NOT seeded (out of v1 scope).
 *
 * Constitution §4: every row carries tenant_id (default 1). The single-tenant
 * v1 row in `tenants` is also seeded here.
 *
 * Run via: `bun run --filter '@caishen/db' seed`
 *
 * Idempotency: pair_configs + agent_state use INSERT ... ON CONFLICT DO NOTHING
 * (re-running is safe; existing rows are untouched). The tenants row uses
 * INSERT ... ON CONFLICT DO UPDATE on `allowed_telegram_user_ids` so the
 * operator can change the allowlist via env vars and re-seed without manual
 * one-shot scripts (closes the v1.1 #4 gap that surfaced in session 5h, where
 * the live tenants row had `[]` and telegram/send was returning 503 until a
 * `seed-tenant.mjs` one-shot UPSERT ran outside the canonical seed flow).
 *
 * Operator allowlist source (precedence, highest first):
 *   1. ALLOWED_TELEGRAM_USER_IDS env (JSON array of numbers)
 *   2. OPERATOR_CHAT_ID env (single number — wrapped into [n])
 *   3. empty array (no operator wired up; telegram/send will 503 until set)
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export interface SeedPair {
  pairCode: string;
  mt5Symbol: string;
  sessionsJson: string[];
}

/**
 * V1 pair seed list. Exposed as a const so tests can import + assert without
 * connecting to a real Postgres.
 *
 * AC-012-1 + AC-012-2 — these 7 entries (and only these 7) ship.
 */
export const V1_PAIR_SEED: readonly SeedPair[] = Object.freeze([
  { pairCode: 'EUR/USD', mt5Symbol: 'EURUSD', sessionsJson: ['EUR', 'NY'] },
  { pairCode: 'EUR/JPY', mt5Symbol: 'EURJPY', sessionsJson: ['EUR', 'NY'] },
  { pairCode: 'EUR/GBP', mt5Symbol: 'EURGBP', sessionsJson: ['EUR', 'NY'] },
  { pairCode: 'USD/JPY', mt5Symbol: 'USDJPY', sessionsJson: ['EUR', 'NY'] },
  { pairCode: 'GBP/USD', mt5Symbol: 'GBPUSD', sessionsJson: ['EUR', 'NY'] },
  { pairCode: 'USD/CAD', mt5Symbol: 'USDCAD', sessionsJson: ['NY'] },
  /** XAU/USD: EUR at 0730 GMT mandatory + NY at 1300 GMT. mt5_symbol XAUUSD. */
  { pairCode: 'XAU/USD', mt5Symbol: 'XAUUSD', sessionsJson: ['EUR', 'NY'] },
]);

/**
 * Parse the operator allowlist from env. Returns a clean number[] (positive
 * integers only; non-numeric / non-positive entries are dropped). v1.1 #4 —
 * pulled out as a pure helper so tests can verify env-handling without a DB.
 */
export function parseAllowedTelegramUserIds(env: NodeJS.ProcessEnv): number[] {
  // Source 1: ALLOWED_TELEGRAM_USER_IDS as JSON array.
  const arrRaw = (env.ALLOWED_TELEGRAM_USER_IDS ?? '').trim();
  if (arrRaw.length > 0) {
    try {
      const parsed = JSON.parse(arrRaw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => (typeof v === 'number' ? v : Number(v)))
          .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
      }
    } catch {
      // fall through to OPERATOR_CHAT_ID
    }
  }
  // Source 2: OPERATOR_CHAT_ID as single number.
  const singleRaw = (env.OPERATOR_CHAT_ID ?? '').trim();
  if (singleRaw.length > 0) {
    const n = Number(singleRaw);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return [n];
  }
  // Source 3: nothing set.
  return [];
}

export async function seedV1(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    // 1. Tenant row — INSERT ... ON CONFLICT DO UPDATE on allowedTelegramUserIds.
    //    Closes the v1.1 #4 gap: re-running the seed picks up env changes
    //    (e.g., adding a second operator chat_id) without manual UPSERT scripts.
    const allowedIds = parseAllowedTelegramUserIds(process.env);
    await db
      .insert(schema.tenants)
      .values({ id: 1, name: 'caishen-v1', allowedTelegramUserIds: allowedIds })
      .onConflictDoUpdate({
        target: schema.tenants.id,
        set: { allowedTelegramUserIds: allowedIds },
      });

    // 2. Pair seed.
    for (const p of V1_PAIR_SEED) {
      await db
        .insert(schema.pairConfigs)
        .values({
          tenantId: 1,
          pairCode: p.pairCode,
          mt5Symbol: p.mt5Symbol,
          sessionsJson: p.sessionsJson,
          activeBool: true,
        })
        .onConflictDoNothing();
    }

    // 3. agent_state row (singleton per tenant).
    await db
      .insert(schema.agentState)
      .values({ tenantId: 1, pausedBool: false })
      .onConflictDoNothing();
  } finally {
    await sql.end({ timeout: 1 });
  }
}

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('seed: DATABASE_URL missing\n');
    process.exit(1);
  }
  seedV1(url)
    .then(() => {
      process.stdout.write('seed: V1 pair list + tenant + agent_state OK\n');
    })
    .catch((e) => {
      process.stderr.write(`seed: failed: ${(e as Error).message}\n`);
      process.exit(1);
    });
}
