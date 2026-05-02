/**
 * FR-002 — Daily Planner Routine body.
 *
 * Runs INSIDE an Anthropic Routine as a Bash step (`bun run packages/
 * routines/src/planner.ts` — see scripts.planner in package.json). The
 * Routine itself is configured in the Anthropic console with the verbatim
 * planner-systemprompt.md (AC-002-1 — covered by Tier 1 prompt-preserve
 * test) + the ForexFactory MCP connector + bearer token.
 *
 * This body file's job:
 *   1. Load active pairs from `pair_configs` for the tenant.
 *   2. Fetch news (24h window) + ForexFactory calendar.
 *   3. Build the user message (`Here's the news today: ...` template) the
 *      planner-systemprompt expects.
 *   4. Call the Planner LLM (the wrapper that invokes `claude --print`
 *      against this routine's pre-configured prompt).
 *   5. Parse the structured output (`output.sessions[]`).
 *   6. Write `pair_schedules` rows for every (active pair × session) cross
 *      product. Empty start/end times → row written with status=skipped_no_window
 *      and NO Executor scheduling (AC-002-3).
 *   7. Schedule per-pair Executor one-offs via the schedule-fire selector.
 *   8. On any failure, emit a failure audit row + emergency Telegram (AC-002-4).
 *   9. On ForexFactory MCP unavailability, mark the run degraded:true + send
 *      a non-emergency Telegram alert (EC-002-1).
 *
 * Constitution §3 audit-or-abort wraps this body via `withAuditOrAbort`.
 * That wrapper happens at the CALLER layer (a thin entrypoint script that
 * imports planDay + does:
 *   await withAuditOrAbort(db, {routineName: 'planner', ...},
 *                          (ctx) => planDay({tenantId: 1, runId: ctx.routineRunId}, deps))
 * ). Here we focus on the orchestration logic.
 *
 * EC-002-3 re-plan path: caller passes replacePolicy='delete-today-first'
 * — writeSchedules deletes today's rows for the tenant THEN inserts new ones.
 * AC-018-2 / AC-018-2-b race-window pre-fire stale-check happens in the
 * Executor body, not here.
 */

import type { NewsRenderResult } from './news';
import { renderNewsMarkdown } from './news';
import type { PromptRole } from './prompt-loader';

/** Active pair row as the queries/pairs helper returns it. */
export interface ActivePair {
  pairCode: string;
  mt5Symbol: string;
  sessionsJson: string[];
  activeBool: boolean;
  tenantId: number;
}

/** ForexFactory calendar fetch — minimal shape; expand in FR-002 wiring step. */
export interface CalendarResult {
  events: readonly { time: string; impact: string; title: string }[];
  /** True when the MCP was unreachable; routine proceeds with empty events. */
  degraded: boolean;
}

/** Planner-LLM output schema — preserved verbatim from n8n agent.json. */
export interface PlannerLlmOutput {
  sessions?: readonly {
    session_name: string;
    /** ISO 8601 GMT, or "" to signal "no window for this session". */
    start_time: string;
    end_time: string;
    reason: string;
  }[];
}

/** Wire-format row passed to writeSchedules. */
export interface ScheduleRow {
  tenantId: number;
  pairCode: string;
  sessionName: string;
  startTimeGmt: string | null;
  endTimeGmt: string | null;
  status: 'scheduled' | 'skipped_no_window';
  reason: string;
}

export interface WriteSchedulesArg {
  tenantId: number;
  date: string;
  rows: ScheduleRow[];
  replacePolicy: 'insert-only' | 'delete-today-first';
}

export interface ScheduleFireArg {
  tenantId: number;
  pairCode: string;
  sessionName: string;
  startTimeGmt: string;
  endTimeGmt: string;
}

export interface PlannerInput {
  tenantId: number;
  /** EC-002-3 re-plan path. Defaults to 'insert-only' for daily 04:00 GMT runs. */
  replacePolicy?: 'insert-only' | 'delete-today-first';
}

export interface PlannerDeps {
  /** Frozen-clock injection; defaults to () => new Date() in production wire-up. */
  now: () => Date;
  loadActivePairs: (tenantId: number) => Promise<readonly ActivePair[]>;
  fetchNews: () => Promise<NewsRenderResult>;
  fetchCalendar: () => Promise<CalendarResult>;
  callPlannerLlm: (req: {
    systemPrompt: string;
    userMessage: string;
    calendar: CalendarResult;
  }) => Promise<PlannerLlmOutput>;
  writeSchedules: (arg: WriteSchedulesArg) => Promise<void>;
  scheduleFire: (arg: ScheduleFireArg) => Promise<void>;
  /** AC-002-4 / EC-002-1 alert path. */
  sendTelegram: (message: string) => Promise<void>;
  loadSystemPrompt: (role: PromptRole) => string;
}

export interface PlannerResult {
  rows: number;
  fires: number;
  degraded: boolean;
}

/**
 * Pure-orchestrator entry point. Caller wraps in withAuditOrAbort so the
 * audit-row insert happens BEFORE any of these steps runs.
 */
export async function planDay(input: PlannerInput, deps: PlannerDeps): Promise<PlannerResult> {
  if (!input || typeof input.tenantId !== 'number' || input.tenantId < 1) {
    throw new Error(`planDay: tenantId must be a positive integer; got ${JSON.stringify(input)}`);
  }
  const replacePolicy = input.replacePolicy ?? 'insert-only';

  // 1. Load active pairs (constitution §4: per-tenant scope).
  const pairs = await deps.loadActivePairs(input.tenantId);

  // 2. Fetch news + calendar in parallel — both are independent.
  const [news, calendar] = await Promise.all([deps.fetchNews(), deps.fetchCalendar()]);

  if (calendar.degraded) {
    // EC-002-1 — non-fatal: proceed with calendar=[] but mark + alert.
    await safeNotify(
      deps.sendTelegram,
      `[caishen] Planner running degraded — ForexFactory calendar unavailable; using news-only signal.`,
    );
  }

  // 3. Build the user message in the exact shape planner-systemprompt expects.
  const now = deps.now();
  const userMessage = buildPlannerUserMessage(now, news);

  // 4. Call the Planner LLM. Failures here go through the AC-002-4 path.
  let llmOut: PlannerLlmOutput;
  try {
    const systemPrompt = deps.loadSystemPrompt('planner');
    llmOut = await deps.callPlannerLlm({ systemPrompt, userMessage, calendar });
  } catch (e) {
    await safeNotify(
      deps.sendTelegram,
      `[caishen] Planner FAILED: LLM call threw — ${stringifyError(e)}`,
    );
    throw e;
  }

  // 5. Validate the output shape (AC-002-4 — unparseable → failure path).
  if (!llmOut || !Array.isArray(llmOut.sessions)) {
    await safeNotify(
      deps.sendTelegram,
      `[caishen] Planner FAILED: LLM output missing 'sessions' array — output was ${JSON.stringify(
        llmOut,
      )}`,
    );
    throw new Error('planDay: LLM output missing required `sessions` array');
  }

  // 6. Cross-product (active pairs × sessions) → schedule rows.
  const todayDateString = toGmtDateString(now);
  const rows: ScheduleRow[] = [];
  for (const pair of pairs) {
    for (const session of llmOut.sessions) {
      // Only emit a row if the pair OPTED INTO this session (e.g., USD/CAD
      // is NY-only and skips EUR even if the planner returns an EUR window).
      if (!pair.sessionsJson.includes(session.session_name)) continue;
      const isEmpty = session.start_time === '' || session.end_time === '';
      rows.push({
        tenantId: input.tenantId,
        pairCode: pair.pairCode,
        sessionName: session.session_name,
        startTimeGmt: isEmpty ? null : session.start_time,
        endTimeGmt: isEmpty ? null : session.end_time,
        status: isEmpty ? 'skipped_no_window' : 'scheduled',
        reason: session.reason,
      });
    }
  }

  await deps.writeSchedules({
    tenantId: input.tenantId,
    date: todayDateString,
    rows,
    replacePolicy,
  });

  // 7. Fire the per-pair Executor one-offs (only for rows with a window).
  let fires = 0;
  for (const row of rows) {
    if (row.status !== 'scheduled' || !row.startTimeGmt || !row.endTimeGmt) continue;
    await deps.scheduleFire({
      tenantId: input.tenantId,
      pairCode: row.pairCode,
      sessionName: row.sessionName,
      startTimeGmt: row.startTimeGmt,
      endTimeGmt: row.endTimeGmt,
    });
    fires += 1;
  }

  return { rows: rows.length, fires, degraded: calendar.degraded };
}

/**
 * Render the user message in the verbatim shape planner-systemprompt expects:
 *
 *   Here's the news today:
 *   Time Now: {NOW_GMT}
 *   News count:{NEWS_COUNT}
 *   {NEWS_MARKDOWN}
 *
 * The exact format (including the lack of space after `News count:`) is
 * load-bearing — that's how the existing n8n workflow passes it.
 */
export function buildPlannerUserMessage(now: Date, news: NewsRenderResult): string {
  return [
    "Here's the news today:",
    `Time Now: ${now.toISOString()}`,
    `News count:${news.news_count}`,
    news.markdown,
  ].join('\n');
}

/**
 * GMT date as YYYY-MM-DD, derived from a JS Date. Used as the partition key
 * for `pair_schedules`. Constitution §5: GMT/UTC, never local.
 */
export function toGmtDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Telegram notify that swallows its own errors — alerting must never
 * cancel the routine result. AC-002-4 / EC-002-1 callers rely on this.
 */
async function safeNotify(send: PlannerDeps['sendTelegram'], msg: string): Promise<void> {
  try {
    await send(msg);
  } catch (e) {
    process.stderr.write(`[planner] safeNotify failed: ${stringifyError(e)}\n`);
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

// Re-export for callers that want everything via planner.ts.
export { renderNewsMarkdown };

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  // Wire-up entry point lives in a separate file because it depends on
  // process.env (DATABASE_URL, TELEGRAM_BOT_TOKEN, etc.) which Spike 3 +
  // FR-009 will provision. Until then, the entry point is a no-op informer.
  process.stdout.write(
    'planner.ts: this is the body module. Wire-up entry pending Spike 3 + FR-009 credentials.\n',
  );
}
