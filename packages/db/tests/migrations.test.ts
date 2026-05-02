/**
 * Migrations file shape verification.
 *
 * The Evaluator's docker-compose-up integration suite will apply these
 * against a real Postgres. These vitest cases are static-text checks —
 * cheap CI gate that catches "someone edited the SQL and broke a pin"
 * before the heavy integration run.
 *
 * AC-008-1: 0000_init.sql exists and contains every contract table.
 * AC-008-3: required indexes are present.
 * AC-012-1 / -2 / -3 / AC-003-3: 0001_seed_pairs.sql ships the right pairs.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve relative to this test file. Bun + Node both honor import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const MIGRATIONS_DIR = join(dirname(__filename), '..', 'migrations');

describe('migrations directory', () => {
  it('exists and has at least the init + seed migrations', () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => f.includes('init'))).toBe(true);
    expect(files.some((f) => f.includes('seed_pairs'))).toBe(true);
  });

  it('drizzle journal references both migrations', () => {
    const journalPath = join(MIGRATIONS_DIR, 'meta', '_journal.json');
    expect(existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string; idx: number }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.some((t) => t.includes('init'))).toBe(true);
    expect(tags.some((t) => t.includes('seed_pairs'))).toBe(true);
  });
});

describe('FR-008 0000_init.sql — DDL coverage', () => {
  const initSql = (() => {
    const files = readdirSync(MIGRATIONS_DIR).filter(
      (f) => f.endsWith('.sql') && f.includes('init'),
    );
    if (files[0] === undefined) throw new Error('no init .sql');
    return readFileSync(join(MIGRATIONS_DIR, files[0]), 'utf8');
  })();

  const REQUIRED_TABLES = [
    'tenants',
    'users',
    'pair_configs',
    'pair_schedules',
    'routine_runs',
    'executor_reports',
    'orders',
    'override_actions',
    'telegram_interactions',
    'channels_health',
    'agent_state',
    'cap_usage_local',
    'cap_usage',
    // Auth.js DrizzleAdapter tables — co-located with users.ts
    'accounts',
    'sessions',
    'verification_tokens',
    'authenticators',
  ];

  for (const table of REQUIRED_TABLES) {
    it(`contains CREATE TABLE "${table}"`, () => {
      expect(initSql).toMatch(new RegExp(`CREATE TABLE\\s+"${table}"`));
    });
  }

  it('R3 delta: routine_run_routine_name enum includes replan_orchestrator', () => {
    expect(initSql).toMatch(/routine_run_routine_name[^;]*replan_orchestrator/);
  });

  it('R5 delta: telegram_interactions has tenant_id+replied_at index', () => {
    // Drizzle names this index "tg_interactions_tenant_replied_idx".
    expect(initSql).toMatch(/CREATE INDEX[^"]*"tg_interactions_tenant_replied_idx"/);
    expect(initSql).toMatch(/"telegram_interactions"[\s\S]*?"replied_at"/);
  });

  it('R4 delta: override_actions.success/before_state_json/after_state_json are nullable', () => {
    // Drizzle emits NOT NULL only on truly-required columns; presence of these
    // columns WITHOUT a NOT NULL suffix is what we assert.
    const overrideStart = initSql.indexOf('CREATE TABLE "override_actions"');
    const overrideEnd = initSql.indexOf(');', overrideStart);
    expect(overrideStart).toBeGreaterThan(-1);
    const block = initSql.slice(overrideStart, overrideEnd);
    // success column present, NOT FOLLOWED by "NOT NULL" on the same line.
    expect(block).toMatch(/"success"\s+boolean(?:[^,\n]|,)*$/m);
    // It should NOT have NOT NULL on the success column.
    expect(/^.*"success"\s+boolean\s+NOT NULL/m.test(block)).toBe(false);
    // before_state_json + after_state_json are jsonb without NOT NULL.
    expect(/^.*"before_state_json"\s+jsonb\s+NOT NULL/m.test(block)).toBe(false);
    expect(/^.*"after_state_json"\s+jsonb\s+NOT NULL/m.test(block)).toBe(false);
  });

  it('every operator-data table includes tenant_id NOT NULL DEFAULT 1', () => {
    // Spot-check on one table; the schema-shape suite covers all per-table.
    expect(initSql).toMatch(/"pair_configs"[\s\S]*?"tenant_id" integer DEFAULT 1 NOT NULL/);
  });
});

describe('FR-012 0001_seed_pairs.sql — V1 pair seed', () => {
  const seedSql = (() => {
    const files = readdirSync(MIGRATIONS_DIR).filter(
      (f) => f.endsWith('.sql') && f.includes('seed_pairs'),
    );
    if (files[0] === undefined) throw new Error('no seed_pairs .sql');
    return readFileSync(join(MIGRATIONS_DIR, files[0]), 'utf8');
  })();

  it('AC-012-1: contains all 7 pair codes', () => {
    for (const code of [
      'EUR/USD',
      'EUR/JPY',
      'EUR/GBP',
      'USD/JPY',
      'GBP/USD',
      'USD/CAD',
      'XAU/USD',
    ]) {
      expect(seedSql).toContain(`'${code}'`);
    }
  });

  it('AC-012-2: GBP/JPY is NOT seeded', () => {
    expect(seedSql).not.toContain("'GBP/JPY'");
    expect(seedSql).not.toContain("'GBPJPY'");
  });

  it('AC-003-3: XAU/USD uses XAUUSD (not XAUUSDF)', () => {
    expect(seedSql).toContain("'XAUUSD'");
    expect(seedSql).not.toContain("'XAUUSDF'");
  });

  it('USD/CAD has only NY session', () => {
    // Look for the line that includes USD/CAD.
    const line = seedSql.split('\n').find((l) => l.includes("'USD/CAD'"));
    expect(line).toBeDefined();
    expect(line).toContain('["NY"]');
    expect(line).not.toContain('["EUR","NY"]');
  });

  it('idempotent: every INSERT carries an ON CONFLICT DO NOTHING clause', () => {
    const insertCount = (seedSql.match(/INSERT INTO/g) ?? []).length;
    const conflictCount = (seedSql.match(/ON CONFLICT/g) ?? []).length;
    expect(insertCount).toBeGreaterThan(0);
    expect(conflictCount).toBeGreaterThanOrEqual(insertCount);
  });

  it('seeds tenants(id=1) AND agent_state(tenant_id=1) singleton rows', () => {
    expect(seedSql).toMatch(/INSERT INTO "tenants"[\s\S]*?VALUES \(1,\s*'caishen-v1'/);
    expect(seedSql).toMatch(/INSERT INTO "agent_state"[\s\S]*?VALUES \(1,\s*false\)/);
  });
});
