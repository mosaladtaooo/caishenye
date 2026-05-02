/**
 * R4 7-step override-handler library — implements the operator-action flow
 * for FR-016 + FR-017 + FR-018 + AC-007-3-b + NFR-007 atomicity.
 *
 * Why a library + caller-supplied verbs?
 *   The 7 steps are identical for close-pair, close-all, edit-position,
 *   pause/resume, and replan. Only the MT5-side verb (the actual mutation)
 *   varies. The library owns the audit-row lifecycle (insert with
 *   success=null, settle to success=true|false on completion); the route
 *   handler injects `mt5Write` for its specific action.
 *
 * The 7 steps:
 *
 *   1. (Done by caller) — Auth.js session re-verify. Route handler calls
 *      auth() before invoking executeOverride(), and returns 401 if
 *      no session. We pass operatorUserId through so the audit row links
 *      to the verified user.
 *   2. (Done by caller) — CSRF gate via validateCsrf. Route handler returns
 *      403 if invalid. We do NOT trust the caller's claim past this point
 *      because the route handler is the only entrypoint.
 *   3. mt5ReadState() — read pre-write MT5 snapshot (AC-007-3-b: every
 *      override's before_state_json comes from a real MT5 read BEFORE any
 *      state-mutating call). If THIS throws, we abort — no audit row, no
 *      write attempt, no telegram (boundary (a)).
 *   4. insertOverrideRow() — write `override_actions` row with success=null
 *      (in-flight marker; orphan-detect cron can later flip to false if the
 *      row is stuck). If THIS throws, we propagate — no MT5 write was
 *      attempted, so no real-world side effect occurred (boundary (b)).
 *   5. mt5Write() — perform the actual override against MT5. If THIS throws,
 *      we settle the audit row to success=false + last-known after_state +
 *      error message; we do NOT fire Telegram (no false success; the row is
 *      the record-of-truth — the dashboard polls override history and shows
 *      the failure) (boundary (c)).
 *   6. updateOverrideRow() — settle the audit row to success=true +
 *      after_state. If THIS throws on the success path, we log + still fire
 *      Telegram because the work succeeded; the audit row stays in-flight
 *      and orphan-detect cron picks it up (boundary (d)).
 *   7. sendTelegram() — operator notification (best-effort fan-out;
 *      failure does NOT cancel the success).
 */

import { OVERRIDE_ACTION_TYPES, type OverrideActionType } from './override-action-types';

/** The actions the dashboard surfaces. Mirror of override_action_type pgEnum. */
export type ExecuteOverrideActionType = OverrideActionType;

/**
 * MT5 write outcome — the verb returns the post-write state if known,
 * letting the handler record after_state_json. If the verb is `pause` /
 * `resume` (no MT5-side write), the verb still returns an `after` snapshot
 * (e.g., the agent_state row contents) so audit data is uniform.
 */
export interface Mt5WriteResult {
  ok: true;
  /** Post-write snapshot — could be a real MT5 read, or a logical state. */
  after: unknown;
}

export interface ExecuteOverrideInput {
  tenantId: number;
  operatorUserId: number;
  actionType: ExecuteOverrideActionType;
  /** Pair this override is scoped to (null for close-all, pause, resume, replan). */
  targetPair?: string | null;
  /** MT5 ticket if action is edit-position; null otherwise. */
  targetTicket?: bigint | null;
  /** Action params recorded in the audit row (e.g., {sl:1.078, tp:1.085}). */
  paramsJson?: unknown;
  /** Human description for the Telegram notification (e.g., "close-pair EUR/USD"). */
  mt5WriteDescription: string;
}

/** What the handler passes to insertOverrideRow — the in-flight audit shape. */
export interface InsertOverrideRowArg {
  tenantId: number;
  operatorUserId: number;
  actionType: ExecuteOverrideActionType;
  targetPair: string | null;
  targetTicket: bigint | null;
  paramsJson: unknown;
  beforeStateJson: unknown;
  /** R4 — null at insert time; settled to true/false in step 6. */
  success: null;
  /** R4 — null at insert time; settled to a snapshot in step 6. */
  afterStateJson: null;
}

/** What the handler passes to updateOverrideRow — the settle shape. */
export interface UpdateOverrideRowArg {
  id: number;
  success: boolean;
  afterStateJson: unknown;
  errorMessage: string | null;
}

export interface ExecuteOverrideDeps {
  /**
   * Step 3 — read pre-write MT5 snapshot. Returns whatever shape is useful
   * for the action (positions list for close-*, single position for edit,
   * agent_state row for pause/resume). Throws on MT5 unreachable.
   */
  mt5ReadState: () => Promise<unknown>;

  /** Step 4 — insert in-flight audit row. Returns the new row id. */
  insertOverrideRow: (arg: InsertOverrideRowArg) => Promise<number>;

  /**
   * Step 5 — perform the override against MT5. Returns post-write snapshot
   * via `after`. Throws on any MT5-side failure.
   */
  mt5Write: () => Promise<Mt5WriteResult>;

  /** Step 6 — settle the audit row. May throw (boundary (d)); see flow doc. */
  updateOverrideRow: (arg: UpdateOverrideRowArg) => Promise<void>;

  /**
   * Step 7 — Telegram fan-out. May throw — best-effort; failures do NOT
   * cancel success.
   */
  sendTelegram: (message: string) => Promise<void>;
}

export interface ExecuteOverrideResult {
  ok: boolean;
  overrideRowId: number;
  /** Set when ok=false: the underlying error's message. */
  errorMessage?: string;
}

/**
 * Run the 7-step override flow. The caller (route handler) has already
 * done steps 1 + 2 (auth + CSRF) and supplied the verb-specific MT5 closure.
 */
export async function executeOverride(
  input: ExecuteOverrideInput,
  deps: ExecuteOverrideDeps,
): Promise<ExecuteOverrideResult> {
  validateInput(input);

  // Step 3 — MT5 read for before_state_json.
  // If this throws, no audit row exists yet, no write attempted: clean abort.
  const beforeState = await deps.mt5ReadState();

  // Step 4 — Insert in-flight audit row (success=null).
  // If this throws, MT5 is untouched; the operator's intent is recoverable
  // by the dashboard surface returning a 5xx. No partial state.
  const overrideRowId = await deps.insertOverrideRow({
    tenantId: input.tenantId,
    operatorUserId: input.operatorUserId,
    actionType: input.actionType,
    targetPair: input.targetPair ?? null,
    targetTicket: input.targetTicket ?? null,
    paramsJson: input.paramsJson ?? null,
    beforeStateJson: beforeState,
    success: null,
    afterStateJson: null,
  });

  // Step 5 — MT5 write. On failure, settle to success=false + record before-state
  // as after_state (last known) + error. NO telegram on failure — dashboard
  // shows the audit row.
  let writeResult: Mt5WriteResult;
  try {
    writeResult = await deps.mt5Write();
  } catch (e) {
    const errMsg = stringifyError(e);
    // Best-effort settle. If this throws too, we have a stuck in-flight row.
    // orphan-detect cron flips it later. We swallow the secondary error and
    // surface the primary one.
    await safeUpdate(deps, {
      id: overrideRowId,
      success: false,
      afterStateJson: beforeState,
      errorMessage: errMsg,
    });
    return { ok: false, overrideRowId, errorMessage: errMsg };
  }

  // Step 6 — Settle audit row to success=true.
  // If this throws (boundary d), we log and continue to step 7 — the work
  // succeeded against MT5 and the operator must be notified.
  try {
    await deps.updateOverrideRow({
      id: overrideRowId,
      success: true,
      afterStateJson: writeResult.after,
      errorMessage: null,
    });
  } catch (e) {
    process.stderr.write(
      `[override-handler] warning: audit update for override id=${overrideRowId} failed: ${stringifyError(
        e,
      )} — orphan-detect cron will recover\n`,
    );
  }

  // Step 7 — Telegram fan-out (best-effort).
  await fireTelegramBestEffort(deps, input);

  return { ok: true, overrideRowId };
}

async function safeUpdate(deps: ExecuteOverrideDeps, arg: UpdateOverrideRowArg): Promise<void> {
  try {
    await deps.updateOverrideRow(arg);
  } catch (e) {
    process.stderr.write(
      `[override-handler] warning: post-failure audit update for override id=${arg.id} failed: ${stringifyError(
        e,
      )}\n`,
    );
  }
}

async function fireTelegramBestEffort(
  deps: ExecuteOverrideDeps,
  input: ExecuteOverrideInput,
): Promise<void> {
  const target = input.targetPair ?? input.targetTicket?.toString() ?? '(global)';
  const msg = `[OVERRIDE] ${input.actionType} on ${target} — ${input.mt5WriteDescription}`;
  try {
    await deps.sendTelegram(msg);
  } catch (e) {
    process.stderr.write(`[override-handler] telegram fan-out failed: ${stringifyError(e)}\n`);
  }
}

function validateInput(input: ExecuteOverrideInput): void {
  if (!input || typeof input.tenantId !== 'number' || input.tenantId < 1) {
    throw new Error('override-handler: tenantId must be a positive integer');
  }
  if (typeof input.operatorUserId !== 'number' || input.operatorUserId < 1) {
    throw new Error('override-handler: operatorUserId must be a positive integer');
  }
  if (!OVERRIDE_ACTION_TYPES.includes(input.actionType)) {
    throw new Error(
      `override-handler: actionType must be one of ${JSON.stringify(
        OVERRIDE_ACTION_TYPES,
      )}; got "${String(input.actionType)}"`,
    );
  }
  if (!input.mt5WriteDescription || input.mt5WriteDescription.length === 0) {
    throw new Error('override-handler: mt5WriteDescription must be a non-empty string');
  }
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
