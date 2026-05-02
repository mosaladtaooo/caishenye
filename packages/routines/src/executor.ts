/**
 * FR-003 — Per-pair Executor Routine body.
 *
 * Runs INSIDE an Anthropic Routine as a Bash step, fired as a one-off by
 * the Planner. The Routine itself is configured with the verbatim SPARTAN
 * prompt + ForexFactory MCP + MT5 REST connector (AC-003-1 — Tier 1
 * prompt-preserve test already passing).
 *
 * Body responsibilities:
 *   1. R3 pre-fire stale-check (FIRST 20 LINES of executor.ts as the
 *      contract specifies). isStalePlan returns true if the pair_schedules
 *      row is missing, status='cancelled', or the env-injected
 *      ANTHROPIC_ONE_OFF_ID doesn't match scheduled_one_off_id. On stale,
 *      noop with reason='stale-plan-noop' — feeds AC-018-2-b race-window.
 *   2. Build user message (LET'S START template; XAU/USD critical-instruction
 *      block injected for that pair only). AC-003-2.
 *   3. Call the Executor LLM (via injected dep — wrapper for the routine's
 *      pre-configured prompt; the LLM does the actual MT5 calls).
 *   4. Symbol guard (AC-003-3): for XAU/USD, every recorded MT5 tool-call
 *      symbol field MUST equal "XAUUSD" exactly. If anything = "XAUUSDF"
 *      or any other value, throw — this is the belt-and-suspenders guard
 *      EC-011-1 mentions.
 *   5. AC-003-4 fan-out: upload report → insert executor_reports row with
 *      blob URL → insert orders row → fire Telegram (AC-003-5).
 *   6. EC-003-2: rejected_by_risk / no_trade decisions get an orders row
 *      with the right type + status='rejected' (or appropriate).
 *
 * Constitution §3 audit-or-abort wraps this body via `withAuditOrAbort` at
 * the CALLER layer (entrypoint script). The routineRunId from that wrapper
 * is passed in via input.routineRunId so executor_reports can FK back.
 */

import type { PromptRole } from './prompt-loader';

/** A single MT5 tool call recorded by the LLM run — symbol field is mandatory. */
export interface ExecutorToolCall {
  tool: string;
  symbol: string;
  volume?: number;
  ticket?: number;
}

/** LLM decision shape — the Executor extracts this from the LLM's structured output. */
export interface ExecutorLlmDecision {
  action:
    | 'market_buy'
    | 'market_sell'
    | 'limit_buy'
    | 'limit_sell'
    | 'stop_buy'
    | 'stop_sell'
    | 'no_trade'
    | 'rejected_by_risk';
  symbol: string;
  volume?: number;
  price?: number;
  sl?: number;
  tp?: number;
  rationale: string;
  reportMarkdown: string;
  toolCalls: readonly ExecutorToolCall[];
}

export interface ScheduleRowSnapshot {
  status: 'scheduled' | 'cancelled' | 'fired' | 'skipped_no_window';
  scheduledOneOffId: string;
}

export interface ExecutorInput {
  tenantId: number;
  pairCode: string;
  /** MT5 symbol (e.g., 'EURUSD' or 'XAUUSD'); seeded from pair_configs. */
  mt5Symbol: string;
  sessionName: string;
  /** Audit row ID this run was wrapped in (from withAuditOrAbort). */
  routineRunId: number;
  /** $ANTHROPIC_ONE_OFF_ID injected by the routine fire — key to R3 stale-check. */
  oneOffId: string;
}

export interface UploadReportArg {
  path: string;
  body: string;
  contentType: string;
}

export interface InsertExecutorReportRowArg {
  tenantId: number;
  routineRunId: number;
  pair: string;
  session: string;
  reportMdBlobUrl: string;
  summaryMd: string;
  actionTaken: string;
}

export interface InsertOrderRowArg {
  tenantId: number;
  pair: string;
  mt5Symbol: string;
  type: ExecutorLlmDecision['action'];
  status: 'open' | 'rejected' | 'cancelled' | 'closed';
  volume?: number;
  price?: number;
  sl?: number;
  tp?: number;
  sourceTable: string;
  sourceId: number;
  /** Recorded for AC-003-3 audit verification. */
  toolCalls: readonly ExecutorToolCall[];
}

export interface ExecutorDeps {
  now: () => Date;
  /** R3 pre-fire stale-check input: today's schedule row for (tenant, pair, session). */
  loadScheduleRow: (
    tenantId: number,
    pairCode: string,
    sessionName: string,
    date: string,
  ) => Promise<ScheduleRowSnapshot | null>;
  callExecutorLlm: (req: {
    systemPrompt: string;
    userMessage: string;
    pairCode: string;
  }) => Promise<ExecutorLlmDecision>;
  uploadReport: (arg: UploadReportArg) => Promise<string>;
  insertExecutorReportRow: (arg: InsertExecutorReportRowArg) => Promise<number>;
  insertOrderRow: (arg: InsertOrderRowArg) => Promise<number>;
  sendTelegram: (message: string) => Promise<void>;
  loadSystemPrompt: (role: PromptRole) => string;
}

export interface ExecutorResult {
  /** 'normal' OR 'stale-plan-noop' (R3 short-circuit) OR 'rejected'. */
  reason: 'normal' | 'stale-plan-noop' | 'rejected';
  orderId?: number;
  reportBlobUrl?: string;
}

/**
 * R3 PRE-FIRE STALE-CHECK — the first 20 lines of the runExecutor body
 * delegate to this. Public for direct unit testing per AC-018-2-b.
 */
export function isStalePlan(row: ScheduleRowSnapshot | null, currentOneOffId: string): boolean {
  if (row === null) return true;
  if (row.status === 'cancelled') return true;
  if (row.scheduledOneOffId !== currentOneOffId) return true;
  return false;
}

/**
 * Build the Executor's user message in the verbatim n8n template shape.
 *
 * AC-003-2: exact format. The XAU/USD critical-instruction block is
 * inlined ONLY for XAU/USD (matching what the n8n parameters.text branch
 * does today).
 */
export function buildExecutorUserMessage(pairCode: string, now: Date): string {
  const lines: string[] = ["LET'S START", 'Current Analysis Pair :', pairCode, ''];
  if (pairCode === 'XAU/USD') {
    lines.push(
      '⚠️ CRITICAL INSTRUCTION: When executing the MetaTrader tool for this asset, you MUST use the exact symbol "XAUUSD". DO NOT use "XAUUSDF" under any circumstances.',
    );
    lines.push('');
  }
  lines.push(`Time Now: ${now.toISOString()}`);
  return lines.join('\n');
}

export async function runExecutor(
  input: ExecutorInput,
  deps: ExecutorDeps,
): Promise<ExecutorResult> {
  validateInput(input);

  // 1. R3 PRE-FIRE STALE-CHECK (first 20 lines per the contract's build order).
  const today = toGmtDateString(deps.now());
  const scheduleRow = await deps.loadScheduleRow(
    input.tenantId,
    input.pairCode,
    input.sessionName,
    today,
  );
  if (isStalePlan(scheduleRow, input.oneOffId)) {
    // Caller's audit row will record output_json={reason:'stale-plan-noop'}.
    // Zero MT5 calls, zero side effects — race-window safe (AC-018-2-b).
    return { reason: 'stale-plan-noop' };
  }

  // 2. Build user message + load verbatim SPARTAN prompt.
  const userMessage = buildExecutorUserMessage(input.pairCode, deps.now());
  const systemPrompt = deps.loadSystemPrompt('executor');

  // 3. Call the Executor LLM. Failure propagates to caller's
  //    withAuditOrAbort which marks the audit row failed + EC-003-3
  //    runtime-budget recovery happens via dashboard manual re-fire.
  const decision = await deps.callExecutorLlm({
    systemPrompt,
    userMessage,
    pairCode: input.pairCode,
  });

  // 4. AC-003-3 SYMBOL GUARD — belt-and-suspenders, defense-in-depth on
  //    top of the SPARTAN prompt. For XAU/USD, the Executor MUST use
  //    "XAUUSD" exactly (no "XAUUSDF") in EVERY tool call symbol field.
  if (input.pairCode === 'XAU/USD') {
    if (decision.symbol !== 'XAUUSD') {
      throw new Error(
        `executor: AC-003-3 violation — XAU/USD decision symbol must be "XAUUSD" exactly, got "${decision.symbol}"`,
      );
    }
    for (const tc of decision.toolCalls) {
      if (tc.symbol !== 'XAUUSD') {
        throw new Error(
          `executor: AC-003-3 violation — XAU/USD MT5 tool call symbol must be "XAUUSD" exactly, got "${tc.symbol}" on ${tc.tool}`,
        );
      }
    }
  }

  // 5. AC-003-4 fan-out: upload report → DB rows → Telegram.
  const blobPath = `reports/${input.tenantId}/${today}/${input.mt5Symbol}-${input.sessionName}.md`;
  const blobUrl = await deps.uploadReport({
    path: blobPath,
    body: decision.reportMarkdown,
    contentType: 'text/markdown',
  });

  const summaryMd = decision.rationale;
  const reportRowId = await deps.insertExecutorReportRow({
    tenantId: input.tenantId,
    routineRunId: input.routineRunId,
    pair: input.pairCode,
    session: input.sessionName,
    reportMdBlobUrl: blobUrl,
    summaryMd,
    actionTaken: decision.action,
  });

  const orderStatus: InsertOrderRowArg['status'] =
    decision.action === 'rejected_by_risk'
      ? 'rejected'
      : decision.action === 'no_trade'
        ? 'rejected'
        : 'open';

  const orderId = await deps.insertOrderRow({
    tenantId: input.tenantId,
    pair: input.pairCode,
    mt5Symbol: input.mt5Symbol,
    type: decision.action,
    status: orderStatus,
    volume: decision.volume,
    price: decision.price,
    sl: decision.sl,
    tp: decision.tp,
    sourceTable: 'executor_reports',
    sourceId: reportRowId,
    toolCalls: decision.toolCalls,
  });

  // AC-003-5 — Telegram fire. Direct Bot API path; the Channels-session
  // surface separately ingests the same audit trail.
  await deps.sendTelegram(
    `${input.pairCode} executor done — ${decision.action}, see /report ${input.pairCode}`,
  );

  return {
    reason:
      decision.action === 'rejected_by_risk' || decision.action === 'no_trade'
        ? 'rejected'
        : 'normal',
    orderId,
    reportBlobUrl: blobUrl,
  };
}

function validateInput(input: ExecutorInput): void {
  if (!input || typeof input.tenantId !== 'number' || input.tenantId < 1) {
    throw new Error(`executor: tenantId must be a positive integer; got ${JSON.stringify(input)}`);
  }
  if (!input.pairCode || input.pairCode.length === 0) {
    throw new Error('executor: pairCode must be a non-empty string');
  }
  if (!input.oneOffId || input.oneOffId.length === 0) {
    throw new Error('executor: oneOffId must be a non-empty string (R3 stale-check requires it)');
  }
}

function toGmtDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  process.stdout.write(
    'executor.ts: this is the body module. Wire-up entrypoint pending Spike 3 + FR-009 credentials.\n',
  );
}
