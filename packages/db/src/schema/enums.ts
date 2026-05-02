/**
 * FR-008 — Postgres enums shared across tables.
 *
 * Round 2/3 deltas from the proposal:
 *   - routine_runs.routine_name gains 'replan_orchestrator' (R3)
 *   - telegram_interactions.command_parsed text + TG_COMMAND_PARSED constant
 *     gains 'SYNTHETIC_PING' (R5)
 *
 * Constitution §16: snake_case for DB enums + columns.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * routine_runs.routine_name — every Routine + spike + cron + replan
 * orchestrator that writes a routine_runs row identifies itself here.
 */
export const routineRunRoutineName = pgEnum('routine_run_routine_name', [
  'planner',
  'executor',
  'spike_ac_001_1',
  'spike_ac_001_2',
  'spike_ac_001_3',
  'spike_ac_001_4',
  'cap_status',
  // R3 — proposal Round 2 — wraps the dashboard's /api/overrides/replan
  // flow so the orphan-detect cron can recover stuck split-tx runs.
  'replan_orchestrator',
]);

/** routine_runs.status — lifecycle state of a routine fire. */
export const routineRunStatus = pgEnum('routine_run_status', [
  'running',
  'completed',
  'failed',
  'degraded',
]);

/** routine_runs.routine_fire_kind — how this run was triggered. */
export const routineFireKind = pgEnum('routine_fire_kind', [
  'recurring',
  'scheduled_one_off',
  'fire_api',
  'claude_run_bash',
]);

/** pair_schedules.status — whether the schedule was honored. */
export const pairScheduleStatus = pgEnum('pair_schedule_status', [
  'scheduled',
  'cancelled',
  'fired',
  'skipped_no_window',
]);

/** orders.type — MT5 order kind + Executor's no_trade / rejected outcomes. */
export const orderType = pgEnum('order_type', [
  'market_buy',
  'market_sell',
  'limit_buy',
  'limit_sell',
  'stop_buy',
  'stop_sell',
  'no_trade',
  'rejected_by_risk',
]);

/** orders.status — open / closed / cancelled / rejected. */
export const orderStatus = pgEnum('order_status', ['open', 'closed', 'cancelled', 'rejected']);

/** override_actions.action_type — every operator override the dashboard supports. */
export const overrideActionType = pgEnum('override_action_type', [
  'close_pair',
  'close_all',
  'edit_sl_tp',
  'pause',
  'resume',
  'replan',
]);

/** channels_health.restart_reason — when restart-on-idle (ADR-009) ran. */
export const channelsRestartReason = pgEnum('channels_restart_reason', [
  'scheduled_idle',
  'manual',
  'crash',
]);

/** cap_usage_local.cap_kind — what kind of subscription consumption was logged. */
export const capUsageLocalKind = pgEnum('cap_usage_local_kind', [
  'planner_recurring',
  'executor_one_off_cap_counted',
  'executor_one_off_cap_exempt',
  'replan_fire',
  'cap_status_cron',
]);

/** cap_usage.source — where the rolled-up daily count came from. */
export const capUsageSource = pgEnum('cap_usage_source', ['local_counter', 'anthropic_api']);

/**
 * Free-form-text constants for telegram_interactions.command_parsed.
 *
 * The DB column is `text` (not pgEnum) because slash-command names are
 * open-ended (operator may add new commands without a migration). These
 * constants document the special non-slash-command tokens callers should
 * use:
 *
 *   FREE_TEXT             — free-form Q&A; LLM-mediated reply.
 *   REJECTED_NOT_ALLOWED  — sender not in tenants.allowed_telegram_user_ids.
 *   SYNTHETIC_PING        — R5 fallback healthcheck signal (Vercel cron).
 *
 * The schema-shape test asserts SYNTHETIC_PING is present.
 */
export const TG_COMMAND_PARSED = ['FREE_TEXT', 'REJECTED_NOT_ALLOWED', 'SYNTHETIC_PING'] as const;

export type TgCommandParsed = (typeof TG_COMMAND_PARSED)[number] | `/${string}`;
