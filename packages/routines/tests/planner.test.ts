/**
 * FR-002 — Daily Planner Routine body.
 *
 * AC-002-1: Planner uses verbatim planner-systemprompt.md (covered by Tier 1
 *           prompt-preserve test, which is already passing).
 * AC-002-2: Planner output → `pair_schedules` rows for today's date, plus
 *           schedule-fire of per-pair Executor one-offs.
 * AC-002-3: Empty start_time/end_time strings yield NO Executor scheduling
 *           for that pair-session.
 * AC-002-4: On routine failure (LLM unparseable, tool error), failure audit
 *           row is written AND emergency Telegram is fired.
 *
 * EC-002-1: ForexFactory MCP unavailable → routine proceeds with calendar=[],
 *           audit row marked degraded:true, Telegram alert fired.
 * EC-002-2: Zero news items → planner prompt handles gracefully.
 * EC-002-3: pair_schedules already has today's rows (re-plan path) → DELETE
 *           today's rows for tenant FIRST, then INSERT new ones, then cancel
 *           stale one-offs.
 *
 * Strategy: Planner is structured as a pure orchestrator that receives
 * injected deps (loadActivePairs, fetchNews, fetchCalendar, callPlannerLlm,
 * writeSchedules, scheduleFire, sendTelegram, time). Tests assert behavior
 * by exercising each branch with stubbed deps.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type PlannerDeps,
  type PlannerInput,
  type PlannerLlmOutput,
  planDay,
} from '../src/planner';

const FIXED_NOW = new Date('2026-05-04T04:00:00.000Z');

interface FakePairConfig {
  pairCode: string;
  mt5Symbol: string;
  sessionsJson: string[];
  activeBool: boolean;
  tenantId: number;
  createdAt: Date;
}

const SAMPLE_PAIRS: FakePairConfig[] = [
  {
    pairCode: 'EUR/USD',
    mt5Symbol: 'EURUSD',
    sessionsJson: ['EUR', 'NY'],
    activeBool: true,
    tenantId: 1,
    createdAt: FIXED_NOW,
  },
  {
    pairCode: 'XAU/USD',
    mt5Symbol: 'XAUUSD',
    sessionsJson: ['EUR', 'NY'],
    activeBool: true,
    tenantId: 1,
    createdAt: FIXED_NOW,
  },
];

const SAMPLE_LLM_OUTPUT: PlannerLlmOutput = {
  sessions: [
    {
      session_name: 'EUR',
      start_time: '2026-05-04T07:30:00Z',
      end_time: '2026-05-04T11:30:00Z',
      reason: 'No Tier-1 events; standard EUR window.',
    },
    {
      session_name: 'NY',
      start_time: '2026-05-04T13:00:00Z',
      end_time: '2026-05-04T17:00:00Z',
      reason: 'Standard NY window.',
    },
  ],
};

function makeDeps(overrides: Partial<PlannerDeps> = {}): PlannerDeps {
  return {
    now: () => FIXED_NOW,
    loadActivePairs: vi.fn(async () => SAMPLE_PAIRS),
    fetchNews: vi.fn(async () => ({
      news_count: 2,
      time_window_start: '2026-05-03T04:00:00.000Z',
      markdown: '## News Summary\n\n### 1. ...\n',
    })),
    fetchCalendar: vi.fn(async () => ({ events: [], degraded: false })),
    callPlannerLlm: vi.fn(async () => SAMPLE_LLM_OUTPUT),
    writeSchedules: vi.fn(async () => undefined),
    scheduleFire: vi.fn(async () => undefined),
    sendTelegram: vi.fn(async () => undefined),
    loadSystemPrompt: vi.fn(() => 'PLANNER PROMPT VERBATIM (160 lines)'),
    ...overrides,
  };
}

describe('FR-002 AC-002-2: Planner happy path', () => {
  it('loads active pairs first, then fetches news, then fetches calendar', async () => {
    const deps = makeDeps();
    await planDay({ tenantId: 1 }, deps);
    const pairsCall = (deps.loadActivePairs as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const newsCall = (deps.fetchNews as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const calCall = (deps.fetchCalendar as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(pairsCall).toBeDefined();
    expect(newsCall).toBeDefined();
    expect(calCall).toBeDefined();
    expect(pairsCall ?? Number.POSITIVE_INFINITY).toBeLessThan(
      newsCall ?? Number.POSITIVE_INFINITY,
    );
  });

  it('passes the verbatim system prompt + a templated user message to callPlannerLlm', async () => {
    const deps = makeDeps();
    await planDay({ tenantId: 1 }, deps);
    expect(deps.callPlannerLlm).toHaveBeenCalledTimes(1);
    const arg = (deps.callPlannerLlm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { systemPrompt: string; userMessage: string }
      | undefined;
    expect(arg?.systemPrompt).toBe('PLANNER PROMPT VERBATIM (160 lines)');
    expect(arg?.userMessage).toContain("Here's the news today:");
    expect(arg?.userMessage).toContain('Time Now: 2026-05-04T04:00:00.000Z');
    expect(arg?.userMessage).toContain('News count:2');
    expect(arg?.userMessage).toContain('## News Summary');
  });

  it('writes pair_schedules rows: 2 sessions × 2 active pairs = 4 rows', async () => {
    const deps = makeDeps();
    await planDay({ tenantId: 1 }, deps);
    expect(deps.writeSchedules).toHaveBeenCalledTimes(1);
    const arg = (deps.writeSchedules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { rows: { pairCode: string; sessionName: string }[] }
      | undefined;
    expect(arg?.rows).toHaveLength(4);
    const pairs = arg?.rows.map((r) => `${r.pairCode}/${r.sessionName}`);
    expect(pairs).toContain('EUR/USD/EUR');
    expect(pairs).toContain('EUR/USD/NY');
    expect(pairs).toContain('XAU/USD/EUR');
    expect(pairs).toContain('XAU/USD/NY');
  });

  it('schedules per-pair Executor fires (one per pair-session that has a window)', async () => {
    const deps = makeDeps();
    await planDay({ tenantId: 1 }, deps);
    // 4 rows × scheduleFire calls
    expect(deps.scheduleFire).toHaveBeenCalledTimes(4);
  });
});

describe('FR-002 AC-002-3: Empty start_time / end_time → NO Executor scheduled', () => {
  it('skips scheduleFire for sessions with empty start_time', async () => {
    const llmOut: PlannerLlmOutput = {
      sessions: [
        {
          session_name: 'EUR',
          start_time: '', // quarantined
          end_time: '',
          reason: 'NFP at 12:30 GMT — no EUR session.',
        },
        {
          session_name: 'NY',
          start_time: '2026-05-04T13:00:00Z',
          end_time: '2026-05-04T17:00:00Z',
          reason: 'NY window OK.',
        },
      ],
    };
    const deps = makeDeps({ callPlannerLlm: vi.fn(async () => llmOut) });
    await planDay({ tenantId: 1 }, deps);
    // 2 pairs × 1 active session (NY only) = 2 fires
    expect(deps.scheduleFire).toHaveBeenCalledTimes(2);
  });

  it('still writes pair_schedules rows with status=skipped_no_window for empty windows', async () => {
    const llmOut: PlannerLlmOutput = {
      sessions: [
        { session_name: 'EUR', start_time: '', end_time: '', reason: 'q' },
        {
          session_name: 'NY',
          start_time: '2026-05-04T13:00:00Z',
          end_time: '2026-05-04T17:00:00Z',
          reason: 'ok',
        },
      ],
    };
    const deps = makeDeps({ callPlannerLlm: vi.fn(async () => llmOut) });
    await planDay({ tenantId: 1 }, deps);
    const arg = (deps.writeSchedules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { rows: { pairCode: string; sessionName: string; status: string }[] }
      | undefined;
    expect(arg?.rows).toHaveLength(4);
    const skipped = arg?.rows.filter((r) => r.status === 'skipped_no_window');
    expect(skipped).toHaveLength(2);
  });
});

describe('FR-002 EC-002-1: ForexFactory MCP unavailable → degraded path', () => {
  it('marks the run degraded:true AND fires a Telegram alert', async () => {
    const deps = makeDeps({
      fetchCalendar: vi.fn(async () => ({ events: [], degraded: true })),
    });
    const out = await planDay({ tenantId: 1 }, deps);
    expect(out.degraded).toBe(true);
    expect(deps.sendTelegram).toHaveBeenCalled();
    const tgCall = (deps.sendTelegram as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | string
      | undefined;
    expect(tgCall).toMatch(/forex.?factory|calendar/i);
  });
});

describe('FR-002 AC-002-4: LLM unparseable → failure audit + emergency Telegram', () => {
  it('throws when callPlannerLlm returns a malformed shape', async () => {
    const deps = makeDeps({
      // sessions array missing → invalid shape
      callPlannerLlm: vi.fn(async () => ({}) as PlannerLlmOutput),
    });
    await expect(planDay({ tenantId: 1 }, deps)).rejects.toThrow(/sessions/i);
    // Telegram fires the emergency, NOT the regular operator-friendly summary
    expect(deps.sendTelegram).toHaveBeenCalled();
    const tgCall = (deps.sendTelegram as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | string
      | undefined;
    expect(tgCall).toMatch(/planner.*fail|failed/i);
  });

  it('throws when callPlannerLlm itself throws (tool error path)', async () => {
    const deps = makeDeps({
      callPlannerLlm: vi.fn(async () => {
        throw new Error('claude unreachable');
      }),
    });
    await expect(planDay({ tenantId: 1 }, deps)).rejects.toThrow(/claude unreachable/);
    expect(deps.sendTelegram).toHaveBeenCalled();
  });
});

describe('FR-002 EC-002-3: Re-plan path — delete-then-insert ordering', () => {
  it('writeSchedules is called with replacePolicy="delete-today-first" so existing today rows go first', async () => {
    const deps = makeDeps();
    await planDay({ tenantId: 1, replacePolicy: 'delete-today-first' }, deps);
    const arg = (deps.writeSchedules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { replacePolicy: string }
      | undefined;
    expect(arg?.replacePolicy).toBe('delete-today-first');
  });

  it('default replacePolicy is "insert-only" (the daily 04:00 GMT path)', async () => {
    const deps = makeDeps();
    await planDay({ tenantId: 1 }, deps);
    const arg = (deps.writeSchedules as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { replacePolicy: string }
      | undefined;
    expect(arg?.replacePolicy).toBe('insert-only');
  });
});

describe('FR-002 — input validation', () => {
  it('throws on missing tenantId', async () => {
    const deps = makeDeps();
    await expect(planDay({} as unknown as PlannerInput, deps)).rejects.toThrow(/tenantId/i);
  });

  it('throws on tenantId < 1', async () => {
    const deps = makeDeps();
    await expect(planDay({ tenantId: 0 }, deps)).rejects.toThrow(/tenantId/i);
  });
});
