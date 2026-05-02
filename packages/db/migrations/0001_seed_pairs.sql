-- FR-012 — V1 pair list seed migration.
--
-- Mirror of `V1_PAIR_SEED` in packages/db/src/seed.ts. Both must stay in
-- sync; the seed.ts version is the canonical source for tests + programmatic
-- runs (`bun run --filter '@caishen/db' seed`), this SQL version is the
-- migration-runner path.
--
-- Drizzle's migration runner applies each .sql file exactly once per database
-- (tracked via __drizzle_migrations). The ON CONFLICT DO NOTHING clauses make
-- this file idempotent in case of replay outside the migration runner (e.g.,
-- if an operator manually applies it during VPS bring-up before connecting
-- the migration table).
--
-- Constitution §4: every row carries tenant_id (default 1).
-- AC-012-1: 7 pairs ship.
-- AC-012-2: GBP/JPY explicitly NOT seeded.
-- AC-003-3: XAU/USD's mt5_symbol = 'XAUUSD' exactly (NOT XAUUSDF).

-- 1. Tenant row (singleton for v1).
INSERT INTO "tenants" ("id", "name", "allowed_telegram_user_ids")
VALUES (1, 'caishen-v1', '[]'::jsonb)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- 2. V1 pair seed — exactly 7 entries.
INSERT INTO "pair_configs" ("tenant_id", "pair_code", "mt5_symbol", "sessions_json", "active_bool")
VALUES
  (1, 'EUR/USD', 'EURUSD', '["EUR","NY"]'::jsonb, true),
  (1, 'EUR/JPY', 'EURJPY', '["EUR","NY"]'::jsonb, true),
  (1, 'EUR/GBP', 'EURGBP', '["EUR","NY"]'::jsonb, true),
  (1, 'USD/JPY', 'USDJPY', '["EUR","NY"]'::jsonb, true),
  (1, 'GBP/USD', 'GBPUSD', '["EUR","NY"]'::jsonb, true),
  (1, 'USD/CAD', 'USDCAD', '["NY"]'::jsonb, true),
  (1, 'XAU/USD', 'XAUUSD', '["EUR","NY"]'::jsonb, true)
ON CONFLICT ("tenant_id", "pair_code") DO NOTHING;
--> statement-breakpoint

-- 3. agent_state singleton row (one per tenant).
INSERT INTO "agent_state" ("tenant_id", "paused_bool")
VALUES (1, false)
ON CONFLICT ("tenant_id") DO NOTHING;
