/**
 * Schedule dispatcher — selects between `claude /schedule` Bash and `/fire`
 * API for scheduling per-pair Executor one-offs.
 *
 * Decision logic (per FR-001 Spike 1):
 *   - Spike 1 PASSED (one-offs cap-exempt): use `claude /schedule` Bash so
 *     the schedule lives in Anthropic Routines' first-party schedule queue
 *     and doesn't burn cap slots.
 *   - Spike 1 FAILED (one-offs cap-counted): fall back to /fire API at
 *     session-start time so the cap accounting is visible to the operator.
 *   - Spike 1 PENDING: refuse to dispatch — the Planner reads outcomes
 *     before generating its schedule output, so this branch is reachable
 *     only if a fresh deploy hasn't run live spikes yet.
 *
 * The Planner consumes this module's `selectScheduleStrategy(outcomes)` to
 * pick a strategy once per fire, then `dispatchSchedule(input, strategy, deps)`
 * to actually schedule each pair_schedules row.
 */

export type ScheduleStrategy = 'claude_schedule_bash' | 'fire_api';

/**
 * FR-021 cap accounting: when the strategy selected based on Spike 1
 * outcome consumes a Max20x cap slot, we record it in cap_usage_local.
 * Cap-exempt strategy (Spike 1 PASS) writes a 'cap_exempt' row for audit
 * trail; cap-counted (Spike 1 FAIL/PARTIAL) writes the regular kind.
 */
export type CapBurnKind = 'executor_one_off_cap_counted' | 'executor_one_off_cap_exempt';

export function capBurnForStrategy(strategy: ScheduleStrategy): CapBurnKind {
  return strategy === 'claude_schedule_bash'
    ? 'executor_one_off_cap_exempt'
    : 'executor_one_off_cap_counted';
}

export interface SpikeOutcome {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'PENDING';
  evidence?: string;
}

export interface SpikeOutcomes {
  spike1: SpikeOutcome;
  spike2: SpikeOutcome;
  spike3: SpikeOutcome;
  spike4: SpikeOutcome;
}

export function selectScheduleStrategy(outcomes: SpikeOutcomes): ScheduleStrategy {
  const v = outcomes.spike1.verdict;
  if (v === 'PENDING') {
    throw new Error(
      'schedule-dispatcher: spike1 verdict is PENDING — cannot select strategy until live spike runs are recorded in spike-fr-001-outcomes.json',
    );
  }
  if (v === 'PASS') return 'claude_schedule_bash';
  // FAIL or PARTIAL — fall back to /fire so cap usage is visible.
  return 'fire_api';
}

export interface ScheduleDispatchInput {
  tenantId: number;
  pairCode: string;
  sessionName: string;
  fireAtIso: string;
  scheduledOneOffId: string;
}

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FireApiInput {
  tenantId: number;
  pairCode: string;
  sessionName: string;
  fireAtIso: string;
  scheduledOneOffId: string;
}

export type FireApiResult =
  | { ok: true; anthropicOneOffId: string }
  | { ok: false; errorMessage: string };

export interface ScheduleDispatcherDeps {
  runBash: (cmd: string) => Promise<BashResult>;
  fireApi: (arg: FireApiInput) => Promise<FireApiResult>;
  /** FR-021 instrumentation hook — best-effort cap burn record. */
  recordCapBurn?: (kind: CapBurnKind, ctx: ScheduleDispatchInput) => Promise<void>;
}

export interface ScheduleDispatchResult {
  dispatched: true;
  strategy: ScheduleStrategy;
  /** Set when strategy=fire_api succeeds; null for claude_schedule_bash. */
  anthropicOneOffId: string | null;
  /** FR-021 visibility — which cap kind this dispatch wrote (if any). */
  capBurn: CapBurnKind;
}

/**
 * Dispatch a schedule using the selected strategy.
 *
 * `claude_schedule_bash` invokes the Claude Code CLI's `/schedule` slash
 * command via Bash; the Anthropic Routines runtime handles the queue. The
 * scheduled_one_off_id passed in becomes the natural-language anchor in
 * the bash command, letting the Executor's pre-fire stale-check (R3) match
 * by ANTHROPIC_ONE_OFF_ID.
 *
 * `fire_api` POSTs to /v1/routines/{id}/fire at session-start time. The
 * caller (Planner) is responsible for the at-the-right-moment timing.
 */
export async function dispatchSchedule(
  input: ScheduleDispatchInput,
  strategy: ScheduleStrategy,
  deps: ScheduleDispatcherDeps,
): Promise<ScheduleDispatchResult> {
  const capBurn = capBurnForStrategy(strategy);

  if (strategy === 'claude_schedule_bash') {
    const cmd = buildClaudeScheduleCmd(input);
    const result = await deps.runBash(cmd);
    if (result.exitCode !== 0) {
      throw new Error(
        `schedule-dispatcher: claude /schedule exited ${result.exitCode}: ${result.stderr || result.stdout}`,
      );
    }
    if (deps.recordCapBurn) {
      await safeRecord(deps.recordCapBurn, capBurn, input);
    }
    return {
      dispatched: true,
      strategy: 'claude_schedule_bash',
      anthropicOneOffId: null,
      capBurn,
    };
  }

  // fire_api strategy.
  const fire = await deps.fireApi({
    tenantId: input.tenantId,
    pairCode: input.pairCode,
    sessionName: input.sessionName,
    fireAtIso: input.fireAtIso,
    scheduledOneOffId: input.scheduledOneOffId,
  });
  if (!fire.ok) {
    throw new Error(`schedule-dispatcher: fire api failed: ${fire.errorMessage}`);
  }
  if (deps.recordCapBurn) {
    await safeRecord(deps.recordCapBurn, capBurn, input);
  }
  return {
    dispatched: true,
    strategy: 'fire_api',
    anthropicOneOffId: fire.anthropicOneOffId,
    capBurn,
  };
}

async function safeRecord(
  fn: (kind: CapBurnKind, ctx: ScheduleDispatchInput) => Promise<void>,
  kind: CapBurnKind,
  ctx: ScheduleDispatchInput,
): Promise<void> {
  try {
    await fn(kind, ctx);
  } catch (e) {
    process.stderr.write(`[schedule-dispatcher] recordCapBurn failed: ${e}\n`);
  }
}

function buildClaudeScheduleCmd(input: ScheduleDispatchInput): string {
  // Claude Code CLI's /schedule command takes a natural-language description
  // + ISO timestamp. We tag with the scheduledOneOffId so R3 stale-check
  // can match.
  const desc = `executor-${input.pairCode}-${input.sessionName}-id-${input.scheduledOneOffId}`;
  return `claude /schedule "${desc}" --at "${input.fireAtIso}"`;
}
