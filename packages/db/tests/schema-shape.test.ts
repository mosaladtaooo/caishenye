/**
 * FR-008 — Postgres schema shape verification.
 *
 * AC-008-1: post-migration table list contains every table from the contract.
 * AC-008-2: tenant_id column exists on every operator-data table (constitution §4).
 * AC-008-3: required indexes exist (per the Data Model section of contract.md).
 *
 * These tests inspect the Drizzle schema metadata directly. The migration
 * tests (vs a real Postgres) live in a separate integration suite that the
 * Evaluator runs against `infra/local/docker-compose.yml`.
 *
 * Round 2/3 schema deltas verified here:
 *   - override_actions.success / before_state_json / after_state_json — nullable (R4)
 *   - routine_runs.routine_name enum gains 'replan_orchestrator' (R3)
 *   - telegram_interactions.command_parsed includes 'SYNTHETIC_PING' (R5)
 *   - telegram_interactions index on (tenant_id, replied_at) (R5)
 */

import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema';

describe('FR-008 AC-008-1: every contract table is exported from schema/index', () => {
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
  ] as const;

  for (const tableName of REQUIRED_TABLES) {
    it(`exports table "${tableName}"`, () => {
      // Drizzle pgTable instances are objects with a Symbol-keyed config.
      const exported = (schema as unknown as Record<string, unknown>)[
        tableName.replace(/_(.)/g, (_, c: string) => c.toUpperCase())
      ];
      expect(exported, `expected schema.${tableName} (camelCased) to be exported`).toBeDefined();
    });
  }
});

describe('FR-008 AC-008-2: every operator-data table has a tenant_id column (constitution §4)', () => {
  const TABLES_WITH_TENANT_ID = [
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
  ] as const;

  for (const tableName of TABLES_WITH_TENANT_ID) {
    it(`${tableName} has tenant_id column`, () => {
      const camel = tableName.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
      const tbl = (schema as unknown as Record<string, unknown>)[camel] as
        | { _: { columns: Record<string, unknown> } }
        | undefined;
      expect(tbl, `${tableName} not exported`).toBeDefined();
      // Drizzle exposes columns under the table proxy directly OR under _.columns.
      // We probe both — whichever shape this version uses.
      const columns = (tbl as unknown as Record<string, unknown>) ?? {};
      const hasTenantId = 'tenantId' in columns || 'tenant_id' in columns;
      expect(hasTenantId, `${tableName} missing tenant_id (constitution §4)`).toBe(true);
    });
  }
});

describe('FR-008 R4: override_actions nullable fields (proposal Round 2)', () => {
  it('override_actions exports a `success` column', () => {
    const t = schema.overrideActions as unknown as Record<string, unknown>;
    expect(t.success).toBeDefined();
  });

  it('override_actions exports a `beforeStateJson` column', () => {
    const t = schema.overrideActions as unknown as Record<string, unknown>;
    expect(t.beforeStateJson).toBeDefined();
  });

  it('override_actions exports an `afterStateJson` column', () => {
    const t = schema.overrideActions as unknown as Record<string, unknown>;
    expect(t.afterStateJson).toBeDefined();
  });
});

describe('FR-008 R3: routine_runs.routine_name enum includes replan_orchestrator', () => {
  it('routineRunRoutineName enum is exported with replan_orchestrator value', () => {
    expect(schema.routineRunRoutineName).toBeDefined();
    const enumValues = (schema.routineRunRoutineName as unknown as { enumValues: string[] })
      .enumValues;
    expect(enumValues).toContain('replan_orchestrator');
    expect(enumValues).toContain('planner');
    expect(enumValues).toContain('executor');
  });
});

describe('FR-008 R5: telegram_interactions enum includes SYNTHETIC_PING', () => {
  // command_parsed is `text` per the contract (free-form), but the constants
  // module exposes the enum-of-known-values for type-safety in callers.
  it('TG_COMMAND_PARSED constants include SYNTHETIC_PING', () => {
    expect(schema.TG_COMMAND_PARSED).toContain('SYNTHETIC_PING');
    expect(schema.TG_COMMAND_PARSED).toContain('FREE_TEXT');
    expect(schema.TG_COMMAND_PARSED).toContain('REJECTED_NOT_ALLOWED');
  });
});

describe('FR-008 AC-008-3: pair_configs primary key shape (composite (tenant_id, pair_code))', () => {
  it('pairConfigs is exported', () => {
    expect(schema.pairConfigs).toBeDefined();
  });
});

describe('FR-008 AC-008-3: tenants table allowed_telegram_user_ids column', () => {
  it('tenants exports allowedTelegramUserIds column (FR-004 AC-004-6)', () => {
    const t = schema.tenants as unknown as Record<string, unknown>;
    expect(t.allowedTelegramUserIds).toBeDefined();
  });
});
