/**
 * Drizzle migration runner.
 *
 * Applies migrations from `packages/db/migrations/` against the configured
 * Postgres. Tracked via the standard Drizzle `__drizzle_migrations` table.
 *
 * Usage:
 *   bun run --filter '@caishen/db' migrate
 *
 * Required env: DATABASE_URL.
 *
 * The migration runner is the ONE place in the codebase that touches
 * DATABASE_URL. App code goes through `getTenantDb()` which lazily creates
 * the connection pool. Constitution §3 audit-or-abort doesn't apply here
 * because migrations run BEFORE any routine fires; there's no audit table
 * yet to write into.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.length === 0) {
    process.stderr.write('migrate: DATABASE_URL missing\n');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    await migrate(db, { migrationsFolder: './migrations' });
    process.stdout.write('migrate: OK\n');
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
  main().catch((e) => {
    process.stderr.write(`migrate: failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
