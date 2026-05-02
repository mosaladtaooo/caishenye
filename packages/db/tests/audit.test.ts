/**
 * FR-007 AC-007-1 + EC-007-1 — withAuditOrAbort behavior tests.
 *
 * Constitution §3 audit-or-abort discipline:
 *   - Audit row inserted FIRST.
 *   - If insert throws, work() is NEVER called.
 *   - On work() success, audit row updated to status='completed'.
 *   - On work() throw, audit row updated to status='failed' THEN re-thrown.
 *   - If the post-work UPDATE fails, the row stays in 'running'/'failed';
 *     orphan-detect cron handles. Don't propagate update failures.
 */

import { describe, expect, it, vi } from 'vitest';
import { withAuditOrAbort } from '../src/audit';
import type { TenantDb } from '../src/client';

interface FakeDrizzle {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeFakeDb(opts: {
  insertReturning?: { id: number }[] | (() => never);
  updateThrows?: boolean;
}): { db: TenantDb; drizzle: FakeDrizzle } {
  const insertReturningSpy = vi.fn(async () => {
    const r = opts.insertReturning;
    if (typeof r === 'function') r();
    return r ?? [{ id: 42 }];
  });
  const insertChain = {
    values: vi.fn(() => insertChain),
    returning: insertReturningSpy,
  };
  const updateChain = {
    set: vi.fn(() => updateChain),
    where: vi.fn(async () => {
      if (opts.updateThrows) throw new Error('update failed (DB blip)');
      return undefined;
    }),
  };
  const drizzle: FakeDrizzle = {
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  };
  const db: TenantDb = Object.freeze({
    drizzle: drizzle as unknown as TenantDb['drizzle'],
    tenantId: 1,
  });
  return { db, drizzle };
}

describe('FR-007 AC-007-1: withAuditOrAbort — happy path', () => {
  it('inserts audit row BEFORE calling work()', async () => {
    const { db, drizzle } = makeFakeDb({ insertReturning: [{ id: 7 }] });
    const work = vi.fn(async () => ({ ok: true }));

    await withAuditOrAbort(db, { routineName: 'planner', routineFireKind: 'recurring' }, work);

    const insertOrder = drizzle.insert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const workOrder = work.mock.invocationCallOrder[0] ?? -1;
    expect(insertOrder).toBeLessThan(workOrder);
  });

  it('passes routineRunId from RETURNING into work() context', async () => {
    const { db } = makeFakeDb({ insertReturning: [{ id: 7 }] });
    const work = vi.fn(async (ctx: { routineRunId: number; tenantId: number }) => ctx);

    const result = (await withAuditOrAbort(
      db,
      { routineName: 'planner', routineFireKind: 'recurring' },
      work,
    )) as { routineRunId: number; tenantId: number };

    expect(result.routineRunId).toBe(7);
    expect(result.tenantId).toBe(1);
  });

  it('updates audit row with status=completed after work() succeeds', async () => {
    const { db, drizzle } = makeFakeDb({ insertReturning: [{ id: 7 }] });
    await withAuditOrAbort(
      db,
      { routineName: 'planner', routineFireKind: 'recurring' },
      async () => ({ schedules: [] }),
    );
    expect(drizzle.update).toHaveBeenCalled();
  });
});

describe('FR-007 EC-007-1: audit insert fails → work() NEVER called', () => {
  it('does NOT call work() when audit insert throws', async () => {
    const { db } = makeFakeDb({
      insertReturning: () => {
        throw new Error('postgres unreachable');
      },
    });
    const work = vi.fn(async () => ({ ok: true }));

    await expect(
      withAuditOrAbort(db, { routineName: 'planner', routineFireKind: 'recurring' }, work),
    ).rejects.toThrow(/postgres unreachable/);

    expect(work).not.toHaveBeenCalled();
  });
});

describe('FR-007 AC-007-1: work() throws → audit row marked failed + error re-thrown', () => {
  it('updates row with status=failed, then re-throws', async () => {
    const { db, drizzle } = makeFakeDb({ insertReturning: [{ id: 7 }] });

    await expect(
      withAuditOrAbort(
        db,
        { routineName: 'executor', routineFireKind: 'scheduled_one_off' },
        async () => {
          throw new Error('mt5 timeout');
        },
      ),
    ).rejects.toThrow(/mt5 timeout/);

    expect(drizzle.update).toHaveBeenCalled();
  });
});

describe('FR-007: post-work UPDATE failure does NOT cancel work() result', () => {
  it('returns work() result even if the post-work audit update throws (orphan-detect picks up)', async () => {
    const { db } = makeFakeDb({ insertReturning: [{ id: 7 }], updateThrows: true });

    const result = await withAuditOrAbort(
      db,
      { routineName: 'planner', routineFireKind: 'recurring' },
      async () => 'work-result',
    );

    // Update silently fails; result still returned.
    expect(result).toBe('work-result');
  });
});
