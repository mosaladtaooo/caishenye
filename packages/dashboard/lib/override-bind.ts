/**
 * Override-handler integration adapter — binds the pure executeOverride()
 * library (lib/override-handler.ts) to live infrastructure:
 *   - Auth.js session → operator user resolution
 *   - MT5 REST client (mt5-server.ts)
 *   - Postgres @caishen/db audit-row writes
 *   - Telegram broadcast queue
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
import { eq } from 'drizzle-orm';
import { mt5Get, mt5Post } from './mt5-server';
import type {
  ExecuteOverrideDeps,
  InsertOverrideRowArg,
  Mt5WriteResult,
  UpdateOverrideRowArg,
} from './override-handler';
import { sendTelegramBroadcast } from './telegram-broadcast';

export interface ResolvedOperator {
  tenantId: number;
  operatorUserId: number;
}

/**
 * Resolve a session cookie to {tenantId, operatorUserId}. Returns null on
 * unauthenticated / unknown session.
 *
 * In the live wire-up (post Auth.js [...nextauth] factory init), this
 * queries the `sessions` table for the session row and joins to `users`.
 * For now we surface a guardrail: throw a known error if AUTH_URL is unset
 * so misconfig doesn't silently let unauthenticated traffic through.
 */
export async function resolveOperatorFromSession(
  sessionToken: string | undefined,
): Promise<ResolvedOperator | null> {
  if (sessionToken === undefined || sessionToken.length === 0) return null;
  // Live wire-up lands when AUTH_URL is provided post-deploy. Until then
  // we fail closed.
  const authUrl = process.env.AUTH_URL;
  if (authUrl === undefined || authUrl.length === 0) {
    throw new Error(
      'override-bind: AUTH_URL missing — Auth.js session resolution requires it; refusing to authenticate',
    );
  }
  const tenantDb = getTenantDb(1);
  const { sessions, users } = await import('@caishen/db/schema/users');
  const rows = await tenantDb.drizzle
    .select({
      sessionUserId: sessions.userId,
      tenantId: users.tenantId,
      userId: users.id,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sessionToken, sessionToken));
  const row = rows[0];
  if (!row) return null;
  return { tenantId: row.tenantId, operatorUserId: row.userId };
}

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
      const after = await dispatchMt5Write(arg.shape);
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

async function dispatchMt5Write(shape: ActionShape): Promise<unknown> {
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
      // Pause has no MT5-side write — it sets agent_state.paused_bool=true
      // and cancels not-yet-fired one-offs. The verb returns the new state
      // snapshot; the caller (route handler for /api/overrides/pause)
      // overlays this with its own dispatcher.
      return { type: 'pause', ts: new Date().toISOString() };
    case 'resume':
      return { type: 'resume', ts: new Date().toISOString() };
    case 'replan':
      // Replan uses the split-tx flow (R3-followup) — its route handler
      // overrides this verb entirely. Reaching here is a programming error.
      throw new Error(
        'override-bind: replan must use the split-tx flow in /api/overrides/replan/route.ts, not the standard 7-step engine',
      );
  }
}
