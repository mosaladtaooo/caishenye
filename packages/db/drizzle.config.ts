/**
 * drizzle-kit configuration.
 *
 * The schema is the source of truth (constitution §16: kebab-case files,
 * snake_case tables). `drizzle-kit generate` reads schema/index.ts +
 * everything it re-exports and emits SQL into ./migrations/.
 *
 * No `dbCredentials` block — generation is offline and doesn't need a live
 * Postgres. The migration runner (bun run --filter '@caishen/db' migrate,
 * a thin wrapper around drizzle-orm/postgres-js's migrate()) is the only
 * place that touches DATABASE_URL.
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  // Migration table options: keep defaults (drizzle.__drizzle_migrations).
  // Strict + verbose so the generator yells loudly on dialect ambiguities.
  verbose: true,
  strict: true,
});
