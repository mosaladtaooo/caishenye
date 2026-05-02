/**
 * FR-004 channels wrapper — Telegram event → caishen-telegram subagent.
 *
 * The wrapper is invoked by the systemd-managed Bun entry point (the unit
 * file `infra/vps/systemd/caishen-channels.service` runs `bun run packages/
 * channels/scripts/loop.ts` which long-polls the Telegram Bot API + the
 * /api/cron/synthetic-ping path's outbound POSTs). For each inbound event,
 * the wrapper runs through:
 *
 *   1. Audit-or-abort INSERT into telegram_interactions (constitution §3 +
 *      AC-007-2 + R5). If THIS throws, we re-throw before invoking the
 *      subagent — no LLM tokens burned on a row we can't audit.
 *   2. Allowlist check against tenants.allowed_telegram_user_ids. If not on
 *      list, settle audit row with command_parsed='REJECTED_NOT_ALLOWED' and
 *      ship a polite refusal via Telegram (per AC-004-6 + clarify Q1).
 *   3. SYNTHETIC_PING short-circuit: NO subagent invocation, NO Telegram
 *      reply. Just settle the audit row's replied_at — that's the heartbeat
 *      MAX(replied_at) the FR-005 health-check reads (R5 + AC-005-1).
 *   4. Otherwise: invoke the caishen-telegram subagent (operator-managed
 *      yaml at /opt/caishen-channels/agents/), pass the message body, get
 *      a reply, settle audit row with replied_at + reply_text + send the
 *      reply via the Telegram Bot API.
 *
 * If ANY of (audit insert / subagent invoke) throws after audit insert
 * succeeded, we ATTEMPT to settle the audit row with an empty reply_text
 * so the row doesn't stay 'in flight' forever, then re-throw.
 *
 * DI throughout — every external surface (db, subagent, telegram, allowlist,
 * clock) is a port. Live wire-up lives in scripts/loop.ts (operator-side).
 */

export type ParsedCommand =
  | { kind: 'slash'; command: string; argv: readonly string[] }
  | { kind: 'free_text' }
  | { kind: 'synthetic_ping' };

const SYNTHETIC_PING_MARKER = '__SYNTHETIC_PING__';

/**
 * Parse the inbound Telegram message text into a structured command shape.
 *
 * Slash commands match `/<word>(\s+<argv>)*` after trimming. Empty / non-
 * slash text is FREE_TEXT. The synthetic-ping marker is a special token the
 * Vercel synthetic-ping cron writes — we route it before the slash check.
 */
export function parseCommand(messageText: string): ParsedCommand {
  const trimmed = messageText.trim();
  if (trimmed === SYNTHETIC_PING_MARKER) return { kind: 'synthetic_ping' };
  if (trimmed.length === 0) return { kind: 'free_text' };
  if (!trimmed.startsWith('/')) return { kind: 'free_text' };
  // Slash command. Split on whitespace; first segment is the command.
  const parts = trimmed.split(/\s+/);
  const command = parts[0] ?? '/';
  const argv = parts.slice(1);
  return { kind: 'slash', command, argv };
}

export interface WrapperEvent {
  tenantId: number;
  fromUserId: bigint;
  messageText: string;
}

export interface AuditInsertArg {
  tenantId: number;
  receivedAt: Date;
  fromUserId: bigint;
  messageText: string;
  /** Slash command name OR FREE_TEXT / SYNTHETIC_PING / REJECTED_NOT_ALLOWED. */
  commandParsed: string;
}

export interface AuditUpdateArg {
  id: number;
  repliedAt: Date;
  /** null when no reply was shipped (SYNTHETIC_PING heartbeat OR invoke failure). */
  replyText: string | null;
  /** Free-form summary of bash invocations or sub-tools the subagent made. */
  toolCallsMadeJson: unknown;
}

export interface AuditWriter {
  insert: (row: AuditInsertArg) => Promise<number>;
  update: (row: AuditUpdateArg) => Promise<void>;
}

export interface SubagentInvokeArg {
  tenantId: number;
  fromUserId: bigint;
  parsed: ParsedCommand;
  rawText: string;
  /** Audit row ID for the subagent to back-reference. */
  telegramInteractionId: number;
}

export interface SubagentInvokeResult {
  replyText: string;
  /** Optional summary of bash invocations the subagent ran. */
  toolCallsMadeJson?: unknown;
}

export interface SubagentInvoker {
  invoke: (arg: SubagentInvokeArg) => Promise<SubagentInvokeResult>;
}

export interface TelegramSendArg {
  chatId: number;
  text: string;
}

export interface TelegramSender {
  send: (arg: TelegramSendArg) => Promise<void>;
}

export interface WrapperDeps {
  audit: AuditWriter;
  invoker: SubagentInvoker;
  telegram: TelegramSender;
  loadAllowlist: (tenantId: number) => Promise<readonly bigint[]>;
  now: () => Date;
}

const REJECT_NOT_ALLOWED_TEXT =
  "Sorry, your Telegram user ID isn't on this tenant's allowlist. " +
  'Ask the operator to add you via setup.sh.';

/**
 * Process one inbound event end-to-end. Idempotent at the audit-row level
 * (re-running with the same event will produce a second row — that's
 * intentional; orphan-detect cron and dashboard pagination handle it).
 */
export async function handleWrapperEvent(ev: WrapperEvent, deps: WrapperDeps): Promise<void> {
  const parsed = parseCommand(ev.messageText);

  // 1. Decide command_parsed BEFORE the audit insert so the row reflects
  //    the routing decision (slash command name OR special token).
  const commandParsed = await classifyCommandParsed(ev, parsed, deps);

  // 2. Audit-or-abort INSERT — constitution §3. If this throws, we have not
  //    yet invoked the subagent NOR sent a Telegram reply: nothing to roll
  //    back. Re-throw so systemd's per-event handler logs + retries.
  const receivedAt = deps.now();
  const auditId = await deps.audit.insert({
    tenantId: ev.tenantId,
    receivedAt,
    fromUserId: ev.fromUserId,
    messageText: ev.messageText,
    commandParsed,
  });

  // 3. Branch on routing decision.
  if (commandParsed === 'REJECTED_NOT_ALLOWED') {
    // Allowlist refusal: ship a polite reply + settle audit row.
    await safeSettle(deps, auditId, REJECT_NOT_ALLOWED_TEXT);
    // The Telegram send is best-effort — we log + don't re-throw if it
    // fails since the audit row is already settled with the refusal text.
    await safeTelegramSend(deps, {
      chatId: bigIntToChatId(ev.fromUserId),
      text: REJECT_NOT_ALLOWED_TEXT,
    });
    return;
  }

  if (parsed.kind === 'synthetic_ping') {
    // R5 heartbeat: no subagent, no Telegram reply. Just settle the audit
    // row's replied_at so MAX(replied_at) ticks forward.
    await deps.audit.update({
      id: auditId,
      repliedAt: deps.now(),
      replyText: null,
      toolCallsMadeJson: null,
    });
    return;
  }

  // 4. Operator path — invoke the subagent.
  let invokeResult: SubagentInvokeResult;
  try {
    invokeResult = await deps.invoker.invoke({
      tenantId: ev.tenantId,
      fromUserId: ev.fromUserId,
      parsed,
      rawText: ev.messageText,
      telegramInteractionId: auditId,
    });
  } catch (e) {
    // Best-effort settle: mark replied_at with no reply_text so the row
    // doesn't sit in 'in flight' state forever. Then re-throw so the
    // caller (systemd loop) logs + restarts.
    await safeSettle(deps, auditId, null);
    throw e;
  }

  // 5. Settle audit row + ship Telegram reply.
  await deps.audit.update({
    id: auditId,
    repliedAt: deps.now(),
    replyText: invokeResult.replyText,
    toolCallsMadeJson: invokeResult.toolCallsMadeJson ?? null,
  });

  await deps.telegram.send({
    chatId: bigIntToChatId(ev.fromUserId),
    text: invokeResult.replyText,
  });
}

/**
 * Decide what to write into command_parsed for this event.
 *   - SYNTHETIC_PING marker → 'SYNTHETIC_PING'
 *   - non-allowlisted user  → 'REJECTED_NOT_ALLOWED'
 *   - slash command         → '/<command>' verbatim
 *   - free text             → 'FREE_TEXT'
 */
async function classifyCommandParsed(
  ev: WrapperEvent,
  parsed: ParsedCommand,
  deps: WrapperDeps,
): Promise<string> {
  if (parsed.kind === 'synthetic_ping') return 'SYNTHETIC_PING';
  // Allowlist check. SYNTHETIC_PING bypasses the allowlist (the cron is the
  // only sender of that token; the operator's bot account is allowlisted).
  const allowlist = await deps.loadAllowlist(ev.tenantId);
  if (!allowlist.some((id) => id === ev.fromUserId)) {
    return 'REJECTED_NOT_ALLOWED';
  }
  if (parsed.kind === 'slash') return parsed.command;
  return 'FREE_TEXT';
}

/**
 * Best-effort audit-row settle. Swallows errors — the caller's primary
 * failure path takes precedence. Used by the failure branches and the
 * allowlist-refusal branch.
 */
async function safeSettle(deps: WrapperDeps, id: number, replyText: string | null): Promise<void> {
  try {
    await deps.audit.update({
      id,
      repliedAt: deps.now(),
      replyText,
      toolCallsMadeJson: null,
    });
  } catch (settleErr) {
    process.stderr.write(
      `[wrapper] safeSettle failed for audit_id=${id}: ${stringifyError(settleErr)}\n`,
    );
  }
}

async function safeTelegramSend(deps: WrapperDeps, arg: TelegramSendArg): Promise<void> {
  try {
    await deps.telegram.send(arg);
  } catch (sendErr) {
    process.stderr.write(`[wrapper] telegram send failed: ${stringifyError(sendErr)}\n`);
  }
}

/**
 * Telegram chat IDs are 64-bit signed integers. The from_user_id column
 * stores them as bigint. The Telegram Bot API expects a JS number for
 * `chat_id` (it'll lose precision above 2^53 — but operator IDs are well
 * within range; super-group IDs can exceed but we only DM users here).
 */
function bigIntToChatId(id: bigint): number {
  // Range guard: Telegram user IDs fit comfortably within 2^53.
  if (id > BigInt(Number.MAX_SAFE_INTEGER) || id < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`wrapper: telegram user id ${id} exceeds safe integer range`);
  }
  return Number(id);
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
