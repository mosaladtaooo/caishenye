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
 * The seed is idempotent — re-running inserts only missing rows (uses
 * INSERT ... ON CONFLICT DO NOTHING semantics via Drizzle's onConflictDoNothing).
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

export async function seedV1(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    // 1. Tenant row.
    await db
      .insert(schema.tenants)
      .values({ id: 1, name: 'caishen-v1', allowedTelegramUserIds: [] })
      .onConflictDoNothing();

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
