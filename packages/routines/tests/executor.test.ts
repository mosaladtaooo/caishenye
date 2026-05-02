/**
 * FR-003 — Per-pair Executor Routine body.
 *
 * AC-003-1: Executor uses verbatim spartan-systemprompt.md (Tier 1
 *           prompt-preserve test already passing).
 * AC-003-2: User message uses the exact n8n template shape:
 *             LET'S START
 *             Current Analysis Pair :
 *             {PAIR_NAME}
 *
 *             [if XAU/USD: critical instruction block]
 *
 *             Time Now: {NOW_GMT}
 * AC-003-3: For XAU/USD runs, MT5 tool calls use the exact symbol "XAUUSD"
 *           (no XAUUSDF). Hard test on the symbol value of every MT5 call.
 * AC-003-4: Executor writes report (Vercel Blob), executor_reports row,
 *           orders row, routine_runs audit. The orchestrator delegates each
 *           write to an injected dep; tests assert the calls happen.
 * AC-003-5: Telegram fires via Channels (or direct Bot API fallback).
 *
 * EC-003-1: MT5 5xx → retry 2× with 10s backoff. (Retry policy belongs in
 *           the mt5.ts client; the orchestrator just reports degraded:true
 *           if the client surface returns a degraded-marked result.)
 * EC-003-2: SPARTAN risk-rule rejection → orders row written with
 *           type='rejected_by_risk' + status='rejected'.
 *
 * R3 (build order): first 20 lines of executor.ts is a pre-fire stale-check
 * — feeds AC-018-2-b race-window test. The check reads pair_schedules for
 * today + this pair; if status='cancelled' OR scheduled_one_off_id !==
 * the env-injected ANTHROPIC_ONE_OFF_ID, the executor noops with
 * output_json.reason='stale-plan-noop' and writes ZERO MT5 calls.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildExecutorUserMessage,
  type ExecutorDeps,
  type ExecutorInput,
  type ExecutorLlmDecision,
  isStalePlan,
  runExecutor,
} from '../src/executor';

const FIXED_NOW = new Date('2026-05-04T07:30:00.000Z');
const ONE_OFF_ID = 'one-off-abc123';

const HEALTHY_SCHEDULE_ROW = {
  status: 'scheduled' as const,
  scheduledOneOffId: ONE_OFF_ID,
};

const SAMPLE_DECISION: ExecutorLlmDecision = {
  action: 'market_buy',
  symbol: 'EURUSD',
  volume: 0.1,
  sl: 1.078,
  tp: 1.085,
  rationale: 'EUR session open; momentum bullish; SL at 1.0780.',
  reportMarkdown: '# EUR/USD Executor Report\n\n...',
  toolCalls: [
    { tool: 'mt5_get_position', symbol: 'EURUSD' },
    { tool: 'mt5_place_order', symbol: 'EURUSD', volume: 0.1 },
  ],
};

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    now: () => FIXED_NOW,
    loadScheduleRow: vi.fn(async () => HEALTHY_SCHEDULE_ROW),
    callExecutorLlm: vi.fn(async () => SAMPLE_DECISION),
    uploadReport: vi.fn(async () => 'https://blob.vercel.app/reports/1/2026-05-04/EURUSD-EUR.md'),
    insertExecutorReportRow: vi.fn(async () => 1),
    insertOrderRow: vi.fn(async () => 1),
    sendTelegram: vi.fn(async () => undefined),
    loadSystemPrompt: vi.fn(() => 'SPARTAN PROMPT VERBATIM (long)'),
    ...overrides,
  };
}

const DEFAULT_INPUT: ExecutorInput = {
  tenantId: 1,
  pairCode: 'EUR/USD',
  mt5Symbol: 'EURUSD',
  sessionName: 'EUR',
  routineRunId: 100,
  oneOffId: ONE_OFF_ID,
};

describe('FR-003 AC-003-2: user message template shape', () => {
  it("builds the exact LET'S START template with pair + time", () => {
    const msg = buildExecutorUserMessage('EUR/USD', FIXED_NOW);
    const lines = msg.split('\n');
    expect(lines[0]).toBe("LET'S START");
    expect(lines[1]).toBe('Current Analysis Pair :');
    expect(lines[2]).toBe('EUR/USD');
    expect(msg).toContain('Time Now: 2026-05-04T07:30:00.000Z');
  });

  it('includes the XAU/USD critical-instruction block ONLY for XAU/USD', () => {
    const xauMsg = buildExecutorUserMessage('XAU/USD', FIXED_NOW);
    expect(xauMsg).toContain('CRITICAL INSTRUCTION');
    expect(xauMsg).toContain('XAUUSD');
    expect(xauMsg).toContain('DO NOT use "XAUUSDF"');

    const eurMsg = buildExecutorUserMessage('EUR/USD', FIXED_NOW);
    expect(eurMsg).not.toContain('CRITICAL INSTRUCTION');
    expect(eurMsg).not.toContain('XAUUSDF');
  });
});

describe('FR-003 AC-003-3: XAU/USD MT5 tool calls use XAUUSD exactly (HARD test)', () => {
  it('the symbol field of every recorded MT5 tool call equals "XAUUSD" (not XAUUSDF)', async () => {
    const xauDecision: ExecutorLlmDecision = {
      ...SAMPLE_DECISION,
      symbol: 'XAUUSD',
      toolCalls: [
        { tool: 'mt5_get_position', symbol: 'XAUUSD' },
        { tool: 'mt5_get_candles', symbol: 'XAUUSD' },
        { tool: 'mt5_place_order', symbol: 'XAUUSD', volume: 0.1 },
      ],
    };
    const deps = makeDeps({ callExecutorLlm: vi.fn(async () => xauDecision) });
    await runExecutor({ ...DEFAULT_INPUT, pairCode: 'XAU/USD', mt5Symbol: 'XAUUSD' }, deps);
    const orderArg = (deps.insertOrderRow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { mt5Symbol: string; toolCalls: { symbol: string }[] }
      | undefined;
    expect(orderArg?.mt5Symbol).toBe('XAUUSD');
    // Hard-equality: NOT a substring check — XAUUSDF would pass a `.includes`.
    expect(orderArg?.mt5Symbol === 'XAUUSDF').toBe(false);
    // Every tool call symbol must equal XAUUSD exactly.
    for (const tc of orderArg?.toolCalls ?? []) {
      expect(tc.symbol).toBe('XAUUSD');
      expect(tc.symbol === 'XAUUSDF').toBe(false);
    }
  });

  it('throws if the LLM decision returns XAUUSDF for an XAU/USD run (defense-in-depth)', async () => {
    const wrongDecision: ExecutorLlmDecision = {
      ...SAMPLE_DECISION,
      symbol: 'XAUUSDF', // would-be silent disaster
      toolCalls: [{ tool: 'mt5_place_order', symbol: 'XAUUSDF', volume: 0.1 }],
    };
    const deps = makeDeps({ callExecutorLlm: vi.fn(async () => wrongDecision) });
    await expect(
      runExecutor({ ...DEFAULT_INPUT, pairCode: 'XAU/USD', mt5Symbol: 'XAUUSD' }, deps),
    ).rejects.toThrow(/XAUUSD/);
    // No order row must have been inserted.
    expect(deps.insertOrderRow).not.toHaveBeenCalled();
  });
});

describe('FR-003 AC-003-4: end-of-run write fan-out', () => {
  it('uploads report, inserts executor_reports row, inserts orders row, sends Telegram', async () => {
    const deps = makeDeps();
    await runExecutor(DEFAULT_INPUT, deps);
    expect(deps.uploadReport).toHaveBeenCalledTimes(1);
    expect(deps.insertExecutorReportRow).toHaveBeenCalledTimes(1);
    expect(deps.insertOrderRow).toHaveBeenCalledTimes(1);
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1);
  });

  it('uploadReport is called BEFORE insertExecutorReportRow (so the row carries the URL)', async () => {
    const deps = makeDeps();
    await runExecutor(DEFAULT_INPUT, deps);
    const upload = (deps.uploadReport as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const insert = (deps.insertExecutorReportRow as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(upload ?? Number.POSITIVE_INFINITY).toBeLessThan(insert ?? -1);
  });

  it('blob path is reports/{tenantId}/{date}/{mt5Symbol}-{session}.md', async () => {
    const deps = makeDeps();
    await runExecutor(DEFAULT_INPUT, deps);
    const arg = (deps.uploadReport as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { path: string }
      | undefined;
    expect(arg?.path).toBe('reports/1/2026-05-04/EURUSD-EUR.md');
  });
});

describe('FR-003 AC-003-5: Telegram message format', () => {
  it('the Telegram body contains pair + action + a /report hint', async () => {
    const deps = makeDeps();
    await runExecutor(DEFAULT_INPUT, deps);
    const msg = (deps.sendTelegram as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | string
      | undefined;
    expect(msg).toContain('EUR/USD');
    expect(msg).toMatch(/market_buy|executor done|action/i);
    expect(msg).toMatch(/\/report/);
  });
});

describe('FR-003 EC-003-2: risk-rule rejection path', () => {
  it('places an orders row with type="rejected_by_risk" and status="rejected"', async () => {
    const rejectedDecision: ExecutorLlmDecision = {
      ...SAMPLE_DECISION,
      action: 'rejected_by_risk',
      symbol: 'EURUSD',
      volume: undefined,
      sl: undefined,
      tp: undefined,
      rationale: 'Volatility too high; would breach 5% rule.',
      toolCalls: [{ tool: 'mt5_get_balance', symbol: 'EURUSD' }],
    };
    const deps = makeDeps({ callExecutorLlm: vi.fn(async () => rejectedDecision) });
    await runExecutor(DEFAULT_INPUT, deps);
    const orderArg = (deps.insertOrderRow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { type: string; status: string }
      | undefined;
    expect(orderArg?.type).toBe('rejected_by_risk');
    expect(orderArg?.status).toBe('rejected');
  });

  it('also covers the no_trade decision (LLM decided no entry)', async () => {
    const noTradeDecision: ExecutorLlmDecision = {
      ...SAMPLE_DECISION,
      action: 'no_trade',
      volume: undefined,
      sl: undefined,
      tp: undefined,
      rationale: 'No clear setup.',
    };
    const deps = makeDeps({ callExecutorLlm: vi.fn(async () => noTradeDecision) });
    await runExecutor(DEFAULT_INPUT, deps);
    const orderArg = (deps.insertOrderRow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { type: string; status: string }
      | undefined;
    expect(orderArg?.type).toBe('no_trade');
  });
});

describe('R3 pre-fire stale-check (feeds AC-018-2-b race-window)', () => {
  it('isStalePlan returns true when status === "cancelled"', () => {
    expect(isStalePlan({ status: 'cancelled', scheduledOneOffId: ONE_OFF_ID }, ONE_OFF_ID)).toBe(
      true,
    );
  });

  it('isStalePlan returns true when scheduledOneOffId !== current oneOffId', () => {
    expect(isStalePlan({ status: 'scheduled', scheduledOneOffId: 'different' }, ONE_OFF_ID)).toBe(
      true,
    );
  });

  it('isStalePlan returns false on a healthy match', () => {
    expect(isStalePlan({ status: 'scheduled', scheduledOneOffId: ONE_OFF_ID }, ONE_OFF_ID)).toBe(
      false,
    );
  });

  it('isStalePlan returns true if the schedule row is missing entirely', () => {
    expect(isStalePlan(null, ONE_OFF_ID)).toBe(true);
  });

  it('runExecutor short-circuits when isStalePlan(true): zero MT5 calls + reason="stale-plan-noop"', async () => {
    const deps = makeDeps({
      loadScheduleRow: vi.fn(async () => ({
        status: 'cancelled' as const,
        scheduledOneOffId: ONE_OFF_ID,
      })),
    });
    const result = await runExecutor(DEFAULT_INPUT, deps);
    expect(result.reason).toBe('stale-plan-noop');
    expect(deps.callExecutorLlm).not.toHaveBeenCalled();
    expect(deps.insertOrderRow).not.toHaveBeenCalled();
    expect(deps.uploadReport).not.toHaveBeenCalled();
  });

  it('runExecutor short-circuits when oneOffId mismatches the schedule row', async () => {
    const deps = makeDeps({
      loadScheduleRow: vi.fn(async () => ({
        status: 'scheduled' as const,
        scheduledOneOffId: 'different-one-off',
      })),
    });
    const result = await runExecutor(DEFAULT_INPUT, deps);
    expect(result.reason).toBe('stale-plan-noop');
    expect(deps.callExecutorLlm).not.toHaveBeenCalled();
  });
});

describe('FR-003 — input validation', () => {
  it('throws on missing tenantId', async () => {
    const deps = makeDeps();
    await expect(runExecutor({} as unknown as ExecutorInput, deps)).rejects.toThrow(/tenantId/i);
  });

  it('throws on missing pairCode', async () => {
    const deps = makeDeps();
    await expect(
      runExecutor({ ...DEFAULT_INPUT, pairCode: '' as unknown as string }, deps),
    ).rejects.toThrow(/pairCode/i);
  });

  it('throws on missing oneOffId (R3 pre-fire check requires it)', async () => {
    const deps = makeDeps();
    await expect(
      runExecutor({ ...DEFAULT_INPUT, oneOffId: '' as unknown as string }, deps),
    ).rejects.toThrow(/oneOffId/i);
  });
});
