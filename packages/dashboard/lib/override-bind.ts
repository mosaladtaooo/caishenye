/**
 * Override-handler integration adapter -- binds the pure executeOverride()
 * library (lib/override-handler.ts) to live infrastructure:
 *   - MT5 REST client (mt5-server.ts)
 *   - Postgres @caishen/db audit-row writes
 *   - Telegram broadcast queue
 *
 * v1.2 FR-025 D3: the Auth.js session resolver previously here
 * (`resolveOperatorFromSession`) was MOVED to lib/auth-js-session.ts during
 * the cookie sweep. Routes no longer call this module for auth -- they call
 * lib/resolve-operator-auth.ts. This module's only public surface today is
 * `buildOverrideDeps` (the MT5 + audit verb factory).
 *
 * Why a separate module?
 *   - Keeps lib/override-handler.ts pure / unit-testable (no DB / network).
 *   - Lets route handlers import a thin factory + delegate to the engine.
 *   - Tests inject `vi.doMock('../../lib/override-bind', () => stub)` to
 *     bypass live deps without touching the engine.
 *
 * The MT5 verb closure (the `mt5Write` injected into ExecuteOverrideDeps)
 * is built per-action by `buildOverrideDeps`, varying with input shape.
 */

import { getTenantDb } from '@caishen/db/client';
import { type NewOverrideAction, overrideActions } from '@caishen/db/schema/override-actions';
import { and, eq } from 'drizzle-orm';
import { mt5Get, mt5Post } from './mt5-server';
import type {
  ExecuteOverrideDeps,
  InsertOverrideRowArg,
  Mt5WriteResult,
  UpdateOverrideRowArg,
} from './override-handler';
import { sendTelegramBroadcast } from './telegram-broadcast';

export type { ResolvedOperator } from './auth-js-session';

/**
 * Build the verb-specific MT5 closure + audit-row helpers for an override
 * action. The route handler picks the right `actionShape` per its own
 * endpoint; this factory wires the rest.
 */
export type ActionShape =
  | { type: 'close_pair'; pair: string }
  | { type: 'close_all' }
  | { type: 'edit_sl_tp'; ticket: bigint; sl: number; tp: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'replan'; force: boolean };

export interface BuildOverrideDepsArg {
  tenantId: number;
  shape: ActionShape;
}

export function buildOverrideDeps(arg: BuildOverrideDepsArg): ExecuteOverrideDeps {
  const tenantDb = getTenantDb(arg.tenantId);

  return {
    mt5ReadState: async () => {
      // Default read path — full positions snapshot. Action-specific reads
      // (e.g., one-position read for edit_sl_tp) overlay on this.
      return mt5Get('/positions');
    },
    insertOverrideRow: async (row: InsertOverrideRowArg): Promise<number> => {
      const insert: NewOverrideAction = {
        tenantId: row.tenantId,
        operatorUserId: row.operatorUserId,
        actionType: row.actionType,
        targetPair: row.targetPair,
        targetTicket: row.targetTicket,
        paramsJson: row.paramsJson,
        beforeStateJson: row.beforeStateJson,
        afterStateJson: row.afterStateJson,
        success: row.success,
      };
      const inserted = await tenantDb.drizzle
        .insert(overrideActions)
        .values(insert)
        .returning({ id: overrideActions.id });
      const returned = inserted[0];
      if (!returned) {
        throw new Error('override-bind: insert returned no row');
      }
      return returned.id;
    },
    mt5Write: async (): Promise<Mt5WriteResult> => {
      const after = await dispatchMt5Write(arg.shape, arg.tenantId);
      return { ok: true, after };
    },
    updateOverrideRow: async (u: UpdateOverrideRowArg): Promise<void> => {
      await tenantDb.drizzle
        .update(overrideActions)
        .set({
          success: u.success,
          afterStateJson: u.afterStateJson,
          errorMessage: u.errorMessage,
        })
        .where(eq(overrideActions.id, u.id));
    },
    sendTelegram: async (msg: string) => {
      await sendTelegramBroadcast(msg);
    },
  };
}

async function dispatchMt5Write(shape: ActionShape, tenantId: number): Promise<unknown> {
  switch (shape.type) {
    case 'close_pair':
      return mt5Post('/positions/close-pair', { pair: shape.pair });
    case 'close_all':
      return mt5Post('/positions/close-all', {});
    case 'edit_sl_tp':
      return mt5Post('/positions/edit', {
        ticket: shape.ticket.toString(),
        sl: shape.sl,
        tp: shape.tp,
      });
    case 'pause':
      // No MT5-side write — flip agent_state + cancel today's not-yet-fired
      // one-offs. AC-017-1 + AC-017-3.
      return doPauseWrite(tenantId);
    case 'resume':
      return doResumeWrite(tenantId);
    case 'replan':
      // Replan uses the split-tx flow (R3-followup) — its route handler
      // overrides this verb entirely. Reaching here is a programming error.
      throw new Error(
        'override-bind: replan must use the split-tx flow in /api/overrides/replan/route.ts, not the standard 7-step engine',
      );
  }
}

async function doPauseWrite(tenantId: number): Promise<unknown> {
  const tenantDb = getTenantDb(tenantId);
  const { agentState } = await import('@caishen/db/schema/agent-state');
  const { pairSchedules } = await import('@caishen/db/schema/pair-schedules');
  const today = currentDateGmt();

  // Tx: upsert agent_state + cancel pair_schedules.
  await tenantDb.drizzle.transaction(async (tx) => {
    // Upsert (tenant_id is PK).
    await tx
      .insert(agentState)
      .values({
        tenantId,
        pausedBool: true,
        pausedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentState.tenantId,
        set: { pausedBool: true, pausedAt: new Date() },
      });
    // Cancel all not-yet-fired schedule rows for today (status='scheduled').
    await tx
      .update(pairSchedules)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(pairSchedules.tenantId, tenantId),
          eq(pairSchedules.date, today),
          eq(pairSchedules.status, 'scheduled'),
        ),
      );
  });

  return { paused: true, ts: new Date().toISOString(), cancelledScheduledFor: today };
}

async function doResumeWrite(tenantId: number): Promise<unknown> {
  const tenantDb = getTenantDb(tenantId);
  const { agentState } = await import('@caishen/db/schema/agent-state');
  await tenantDb.drizzle
    .insert(agentState)
    .values({ tenantId, pausedBool: false, pausedAt: null })
    .onConflictDoUpdate({
      target: agentState.tenantId,
      set: { pausedBool: false, pausedAt: null },
    });
  return { paused: false, ts: new Date().toISOString() };
}

function currentDateGmt(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
