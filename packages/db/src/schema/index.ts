/**
 * FR-008 — Drizzle schema index.
 *
 * Re-exports every table + enum + type so callers can do:
 *   import { users, routineRuns, ... } from '@caishen/db/schema';
 *
 * Constitution §4: every operator-data table has a tenant_id column.
 * Constitution §16: snake_case for DB names, kebab-case for files.
 */

export * from './agent-state';
export * from './cap-usage';
export * from './channels-health';
export * from './cron-runner-health';
export * from './enums';
export * from './executor-reports';
export * from './orders';
export * from './override-actions';
export * from './pair-configs';
export * from './pair-schedules';
export * from './routine-runs';
export * from './telegram-interactions';
export * from './tenants';
export * from './users';
export * from './webauthn';
