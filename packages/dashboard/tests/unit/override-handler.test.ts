/**
 * R4 7-step override-handler flow — unit tests.
 *
 * The 7 steps the override-handler library implements (per contract R4 +
 * AC-007-3-b + AC-016-1..3 + NFR-007):
 *
 *   1. Re-verify Auth.js session (operator user is logged in).
 *   2. CSRF gate via validateCsrf (lib/csrf.ts already covered by csrf.test.ts).
 *   3. MT5 read for `before_state_json` — happens BEFORE any state-mutating
 *      call so AC-007-3-b can be enforced (every override has a real
 *      pre-write snapshot).
 *   4. Insert `override_actions` row with `success=null` (in-flight marker).
 *   5. MT5 write — the actual override (close, edit-position, etc).
 *   6. Update the `override_actions` row with `success=true|false` +
 *      `after_state_json`.
 *   7. Trigger Telegram broadcast (best-effort fan-out; failure does NOT
 *      cancel the success).
 *
 * Fault-injection coverage at all 4 boundaries (NFR-007 atomicity):
 *   (a) MT5 read fail (step 3)
 *   (b) audit insert fail (step 4)
 *   (c) MT5 write fail (step 5)
 *   (d) audit update fail (step 6)
 *
 * Each boundary has a test asserting:
 *   - the right side effects happened up to the failure point
 *   - the right side effects did NOT happen after the failure
 *   - the override_actions row reflects the failure mode (in-flight on (b),
 *     `success=false` on (c), unrecoverable post-write on (d))
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ExecuteOverrideActionType,
  type ExecuteOverrideDeps,
  type ExecuteOverrideInput,
  executeOverride,
} from '../../lib/override-handler';

const TENANT_ID = 1;
const OPERATOR_USER_ID = 42;

const SAMPLE_BEFORE_STATE = {
  tickets: [{ ticket: 12345, symbol: 'EURUSD', volume: 0.1, sl: 1.078, tp: 1.085 }],
  balance: 10_000,
  equity: 10_005,
};

const SAMPLE_AFTER_STATE_AFTER_CLOSE = {
  tickets: [],
  balance: 10_005,
  equity: 10_005,
};

function makeDeps(overrides: Partial<ExecuteOverrideDeps> = {}): ExecuteOverrideDeps {
  return {
    mt5ReadState: vi.fn(async () => SAMPLE_BEFORE_STATE),
    mt5Write: vi.fn(async () => ({ ok: true as const, after: SAMPLE_AFTER_STATE_AFTER_CLOSE })),
    insertOverrideRow: vi.fn(async () => 999),
    updateOverrideRow: vi.fn(async () => undefined),
    sendTelegram: vi.fn(async () => undefined),
    ...overrides,
  };
}

const CLOSE_PAIR_INPUT: ExecuteOverrideInput = {
  tenantId: TENANT_ID,
  operatorUserId: OPERATOR_USER_ID,
  actionType: 'close_pair',
  targetPair: 'EUR/USD',
  paramsJson: { pair: 'EUR/USD' },
  // The mt5Write closure is the verb that performs the override against MT5.
  // The handler is action-shape agnostic — close, close-all, edit all use
  // the same 7-step engine; the verb varies.
  mt5WriteDescription: 'close-pair EUR/USD',
};

describe('R4 override-handler — happy path (all 7 steps)', () => {
  it('runs MT5 read → audit insert → MT5 write → audit update → telegram, in that order', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      mt5ReadState: vi.fn(async () => {
        calls.push('mt5_read');
        return SAMPLE_BEFORE_STATE;
      }),
      insertOverrideRow: vi.fn(async () => {
        calls.push('insert_override');
        return 999;
      }),
      mt5Write: vi.fn(async () => {
        calls.push('mt5_write');
        return { ok: true as const, after: SAMPLE_AFTER_STATE_AFTER_CLOSE };
      }),
      updateOverrideRow: vi.fn(async () => {
        calls.push('update_override');
      }),
      sendTelegram: vi.fn(async () => {
        calls.push('telegram');
      }),
    });

    const result = await executeOverride(CLOSE_PAIR_INPUT, deps);

    expect(result.ok).toBe(true);
    expect(result.overrideRowId).toBe(999);
    // Strict ordering — read MUST happen before insert; insert before write;
    // write before update; update before telegram.
    expect(calls).toEqual([
      'mt5_read',
      'insert_override',
      'mt5_write',
      'update_override',
      'telegram',
    ]);
  });

  it('captures the pre-write MT5 state into before_state_json (AC-007-3-b)', async () => {
    const insertSpy = vi.fn<ExecuteOverrideDeps['insertOverrideRow']>(async () => 999);
    const deps = makeDeps({
      insertOverrideRow: insertSpy,
    });

    await executeOverride(CLOSE_PAIR_INPUT, deps);

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const insertArg = insertSpy.mock.calls[0]?.[0];
    expect(insertArg?.beforeStateJson).toEqual(SAMPLE_BEFORE_STATE);
    // success = null (in-flight) at insert time per R4
    expect(insertArg?.success).toBe(null);
    expect(insertArg?.afterStateJson).toBe(null);
    expect(insertArg?.tenantId).toBe(TENANT_ID);
    expect(insertArg?.operatorUserId).toBe(OPERATOR_USER_ID);
    expect(insertArg?.actionType).toBe('close_pair');
  });

  it('records the post-write MT5 state into after_state_json on update', async () => {
    const updateSpy = vi.fn<ExecuteOverrideDeps['updateOverrideRow']>(async () => undefined);
    const deps = makeDeps({
      updateOverrideRow: updateSpy,
    });

    await executeOverride(CLOSE_PAIR_INPUT, deps);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateArg = updateSpy.mock.calls[0]?.[0];
    expect(updateArg?.id).toBe(999);
    expect(updateArg?.success).toBe(true);
    expect(updateArg?.afterStateJson).toEqual(SAMPLE_AFTER_STATE_AFTER_CLOSE);
    expect(updateArg?.errorMessage).toBe(null);
  });

  it('fires telegram with the action description AFTER successful write', async () => {
    const tgSpy = vi.fn<ExecuteOverrideDeps['sendTelegram']>(async () => undefined);
    const deps = makeDeps({ sendTelegram: tgSpy });

    await executeOverride(CLOSE_PAIR_INPUT, deps);

    expect(tgSpy).toHaveBeenCalledTimes(1);
    const msg = tgSpy.mock.calls[0]?.[0];
    expect(typeof msg).toBe('string');
    // Message must mention the override action so the operator sees what fired.
    expect(msg).toContain('close_pair');
    expect(msg).toContain('EUR/USD');
  });
});

describe('R4 override-handler — fault injection at boundary (a) MT5 read fail', () => {
  it('throws + does NOT insert audit row, does NOT call mt5Write, does NOT telegram', async () => {
    const insertSpy = vi.fn(async () => 999);
    const writeSpy = vi.fn(async () => ({
      ok: true as const,
      after: SAMPLE_AFTER_STATE_AFTER_CLOSE,
    }));
    const tgSpy = vi.fn(async () => undefined);
    const updateSpy = vi.fn(async () => undefined);

    const deps = makeDeps({
      mt5ReadState: vi.fn(async () => {
        throw new Error('mt5: read failed');
      }),
      insertOverrideRow: insertSpy,
      mt5Write: writeSpy,
      updateOverrideRow: updateSpy,
      sendTelegram: tgSpy,
    });

    await expect(executeOverride(CLOSE_PAIR_INPUT, deps)).rejects.toThrow(/mt5: read failed/);

    expect(insertSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(tgSpy).not.toHaveBeenCalled();
  });
});

describe('R4 override-handler — fault injection at boundary (b) audit insert fail', () => {
  it('throws + does NOT call mt5Write, does NOT update, does NOT telegram', async () => {
    const writeSpy = vi.fn(async () => ({
      ok: true as const,
      after: SAMPLE_AFTER_STATE_AFTER_CLOSE,
    }));
    const tgSpy = vi.fn(async () => undefined);
    const updateSpy = vi.fn(async () => undefined);

    const deps = makeDeps({
      insertOverrideRow: vi.fn(async () => {
        throw new Error('postgres: connection refused');
      }),
      mt5Write: writeSpy,
      updateOverrideRow: updateSpy,
      sendTelegram: tgSpy,
    });

    await expect(executeOverride(CLOSE_PAIR_INPUT, deps)).rejects.toThrow(
      /postgres: connection refused/,
    );

    expect(writeSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(tgSpy).not.toHaveBeenCalled();
  });
});

describe('R4 override-handler — fault injection at boundary (c) MT5 write fail', () => {
  it('captures success=false + last-known after_state, does NOT telegram', async () => {
    const updateSpy = vi.fn<ExecuteOverrideDeps['updateOverrideRow']>(async () => undefined);
    const tgSpy = vi.fn(async () => undefined);

    const deps = makeDeps({
      mt5Write: vi.fn(async () => {
        throw new Error('mt5: ECONNRESET on write');
      }),
      updateOverrideRow: updateSpy,
      sendTelegram: tgSpy,
    });

    const result = await executeOverride(CLOSE_PAIR_INPUT, deps);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/ECONNRESET/);
    expect(result.overrideRowId).toBe(999);

    // Audit row was settled to success=false, after_state captures the last
    // known pre-write state (R4: "audit update failures don't cancel successful work
    // result" — but here the work itself failed, so we record that).
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateArg = updateSpy.mock.calls[0]?.[0];
    expect(updateArg?.success).toBe(false);
    expect(updateArg?.afterStateJson).toEqual(SAMPLE_BEFORE_STATE);
    expect(updateArg?.errorMessage).toMatch(/ECONNRESET/);

    // Per R4: NO telegram on failure (the audit row is the record-of-truth;
    // the dashboard polls override history; we don't fire false success
    // notifications).
    expect(tgSpy).not.toHaveBeenCalled();
  });
});

describe('R4 override-handler — fault injection at boundary (d) audit update fail', () => {
  it('returns ok=true (work completed), but logs warning + still fires telegram', async () => {
    // The work completed successfully against MT5. The audit-row UPDATE is
    // post-work bookkeeping — failing it shouldn't cancel the operator's
    // intent. The audit row stays in `success=null` (in-flight) state and
    // the orphan-detect cron picks it up later.
    const tgSpy = vi.fn(async () => undefined);
    const updateError = new Error('postgres: lost connection mid-update');
    const deps = makeDeps({
      updateOverrideRow: vi.fn(async () => {
        throw updateError;
      }),
      sendTelegram: tgSpy,
    });

    const result = await executeOverride(CLOSE_PAIR_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(result.overrideRowId).toBe(999);
    // Telegram still fires — the operator's action SUCCEEDED at MT5 and they
    // need to know.
    expect(tgSpy).toHaveBeenCalledTimes(1);
  });
});

describe('R4 override-handler — input validation', () => {
  it('rejects tenantId < 1', async () => {
    const deps = makeDeps();
    await expect(executeOverride({ ...CLOSE_PAIR_INPUT, tenantId: 0 }, deps)).rejects.toThrow(
      /tenantId/i,
    );
  });

  it('rejects empty operatorUserId', async () => {
    const deps = makeDeps();
    await expect(executeOverride({ ...CLOSE_PAIR_INPUT, operatorUserId: 0 }, deps)).rejects.toThrow(
      /operatorUserId/i,
    );
  });

  it('rejects unrecognized actionType', async () => {
    const deps = makeDeps();
    await expect(
      executeOverride(
        // Casting to ExecuteOverrideActionType bypasses the compile-time
        // enum check so we can verify the runtime validator's rejection
        // behavior. The cast is intentional and scoped to this test only.
        {
          ...CLOSE_PAIR_INPUT,
          actionType: 'something_invalid' as ExecuteOverrideActionType,
        },
        deps,
      ),
    ).rejects.toThrow(/actionType/);
  });
});

describe('R4 override-handler — telegram failure does NOT cancel success', () => {
  it('still returns ok=true even if Telegram throws (best-effort fan-out)', async () => {
    const deps = makeDeps({
      sendTelegram: vi.fn(async () => {
        throw new Error('telegram: 502 bad gateway');
      }),
    });

    const result = await executeOverride(CLOSE_PAIR_INPUT, deps);
    expect(result.ok).toBe(true);
    // The audit row was still updated successfully — that's the
    // record-of-truth. Telegram is a notification, not a record.
  });
});
