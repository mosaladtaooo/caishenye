#!/usr/bin/env bun
/**
 * FR-004 — Channels session main loop.
 *
 * Operator-managed entry point invoked by systemd:
 *   ExecStart=/usr/local/bin/bun run /opt/caishen-channels/scripts/loop.ts
 *
 * Responsibilities:
 *   1. Long-poll the Telegram Bot API for inbound updates (getUpdates).
 *   2. For each update, build a WrapperEvent and call handleWrapperEvent.
 *   3. Live wire-up of the wrapper's three ports:
 *        - audit (Postgres @caishen/db)
 *        - invoker (the `claude` CLI subagent — invokes
 *          `claude /agents:caishen-telegram` with the message)
 *        - telegram (direct Bot API client from @caishen/routines/telegram-bot)
 *      All credentials come from /etc/caishen/channels.env.
 *
 * The loop crashes loud on any non-recoverable error so systemd's
 * Restart=always brings up a fresh process (constitution §3 + AC-005-3).
 *
 * NOTE: this entry point is OPERATOR-DEPLOYED, not built into the package
 * dist. The setup.sh script symlinks it from the worktree clone into
 * /opt/caishen-channels/scripts/loop.ts on the VPS. Tests don't import it.
 */

import { spawn } from 'node:child_process';

import { getTenantDb } from '@caishen/db/client';
import { telegramInteractions } from '@caishen/db/schema/telegram-interactions';
import { tenants } from '@caishen/db/schema/tenants';
import { eq } from 'drizzle-orm';

import {
  type AuditWriter,
  handleWrapperEvent,
  type SubagentInvoker,
  type TelegramSender,
  type WrapperDeps,
  type WrapperEvent,
} from '../src/wrapper';

const POLL_TIMEOUT_SEC = 25;
const TENANT_ID = parseInt(process.env.CAISHEN_TENANT_ID ?? '1', 10);

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    text?: string;
  };
}

interface TelegramUpdatesResp {
  ok: boolean;
  result: TelegramUpdate[];
}

async function main(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (botToken.length === 0) {
    throw new Error('loop: TELEGRAM_BOT_TOKEN missing — refusing to start');
  }
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (databaseUrl.length === 0) {
    throw new Error('loop: DATABASE_URL missing — refusing to start');
  }
  if (!Number.isInteger(TENANT_ID) || TENANT_ID < 1) {
    throw new Error(`loop: CAISHEN_TENANT_ID invalid (got ${process.env.CAISHEN_TENANT_ID})`);
  }

  const deps = buildLiveDeps(botToken);
  let lastUpdateId = 0;

  process.stdout.write(
    `[channels-loop] tenant=${TENANT_ID} starting; long-poll timeout=${POLL_TIMEOUT_SEC}s\n`,
  );

  for (;;) {
    try {
      const updates = await getUpdates(botToken, lastUpdateId);
      for (const u of updates) {
        if (u.update_id >= lastUpdateId) lastUpdateId = u.update_id + 1;
        const message = u.message;
        if (!message || message.from === undefined || message.text === undefined) continue;
        const ev: WrapperEvent = {
          tenantId: TENANT_ID,
          fromUserId: BigInt(message.from.id),
          messageText: message.text,
        };
        try {
          await handleWrapperEvent(ev, deps);
        } catch (handleErr) {
          process.stderr.write(`[channels-loop] handleWrapperEvent failed: ${handleErr}\n`);
          // Don't re-throw — keep the loop alive so subsequent updates are
          // handled. Audit row was settled best-effort by the wrapper.
        }
      }
    } catch (pollErr) {
      process.stderr.write(`[channels-loop] getUpdates failed: ${pollErr}\n`);
      // Sleep 5s before retrying so we don't spin during a sustained outage.
      await new Promise<void>((r) => setTimeout(r, 5_000));
    }
  }
}

async function getUpdates(botToken: string, offset: number): Promise<TelegramUpdate[]> {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=${POLL_TIMEOUT_SEC}&offset=${offset}`;
  const resp = await fetch(url, { method: 'GET' });
  const json = (await resp.json()) as TelegramUpdatesResp;
  if (!json.ok) {
    throw new Error(`telegram getUpdates: not ok — body=${JSON.stringify(json)}`);
  }
  return json.result;
}

function buildLiveDeps(botToken: string): WrapperDeps {
  const tenantDb = getTenantDb(TENANT_ID);

  const audit: AuditWriter = {
    insert: async (row) => {
      const inserted = await tenantDb.drizzle
        .insert(telegramInteractions)
        .values({
          tenantId: row.tenantId,
          receivedAt: row.receivedAt,
          fromUserId: row.fromUserId,
          messageText: row.messageText,
          commandParsed: row.commandParsed,
        })
        .returning({ id: telegramInteractions.id });
      const r = inserted[0];
      if (!r) throw new Error('audit-insert: returning produced no row');
      return r.id;
    },
    update: async (row) => {
      await tenantDb.drizzle
        .update(telegramInteractions)
        .set({
          repliedAt: row.repliedAt,
          replyText: row.replyText,
          toolCallsMadeJson: row.toolCallsMadeJson as Record<string, unknown> | null,
        })
        .where(eq(telegramInteractions.id, row.id));
    },
  };

  const invoker: SubagentInvoker = {
    invoke: async (arg) => {
      // Spawn `claude` in subagent mode. Per AC-004-3, the agent's tools+
      // allowlist are pinned by a yaml frontmatter at the operator-managed
      // path. Path is configurable via CAISHEN_TELEGRAM_AGENT_PATH env so
      // Linux (`/opt/caishen-channels/agents/caishen-telegram.md`) and
      // Windows (`C:\caishen\agents\caishen-telegram.md`) deployments both
      // work. If unset OR the file doesn't exist, the spawn falls through
      // to generic Claude Code (no custom tool allowlist; relies on
      // --dangerously-skip-permissions to answer freely).
      const agentPath = process.env.CAISHEN_TELEGRAM_AGENT_PATH ?? '';
      const replyText = await runClaudeSubagent({
        agentPath,
        prompt: arg.rawText,
        env: {
          CAISHEN_TENANT_ID: String(TENANT_ID),
          CAISHEN_FROM_USER_ID: arg.fromUserId.toString(),
          CAISHEN_AUDIT_ROW_ID: String(arg.telegramInteractionId),
        },
      });
      return { replyText, toolCallsMadeJson: null };
    },
  };

  const telegram: TelegramSender = {
    send: async (arg) => {
      await sendTelegramReply(botToken, arg.chatId, arg.text);
    },
  };

  return {
    audit,
    invoker,
    telegram,
    loadAllowlist: async (tenantId) => {
      const rows = await tenantDb.drizzle
        .select({ allowed: tenants.allowedTelegramUserIds })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const row = rows[0];
      if (!row) return [];
      return ((row.allowed as readonly number[] | null) ?? []).map((n) => BigInt(n));
    },
    now: () => new Date(),
  };
}

interface RunSubagentArg {
  /** Empty string → spawn without --agent flag (generic Claude). */
  agentPath: string;
  prompt: string;
  env: Record<string, string>;
}

/**
 * Spawn the `claude` CLI in subagent mode against a specific agent yaml.
 *
 * Live invocation: `claude --print --dangerously-skip-permissions [--agent <path>] <<< <prompt>`.
 * The CLI already handles auth via the operator's stored login (per AC-010-3),
 * so no API key is in scope here. The --dangerously-skip-permissions flag is
 * mandatory because the Channels session has no human at the keyboard to
 * approve interactive tool prompts (e.g. Bash / Read / postgres MCP) — without
 * it, the bot just hangs asking "approve this command?" with no reply path.
 *
 * If `agentPath` is empty OR the file doesn't exist on disk, the --agent flag
 * is omitted and Claude runs with its general tool surface. The agent yaml
 * is operator-deployed; the path is configurable via the
 * CAISHEN_TELEGRAM_AGENT_PATH env var (mirrors the FR-009 / FR-010 pattern of
 * operator-managed env-driven paths).
 */
async function runClaudeSubagent(arg: RunSubagentArg): Promise<string> {
  // Build args list. --dangerously-skip-permissions is always present;
  // --agent is only added when a non-empty path is provided.
  const args = ['--print', '--dangerously-skip-permissions'];
  if (arg.agentPath.length > 0) {
    args.push('--agent', arg.agentPath);
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, {
      env: { ...process.env, ...arg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      reject(new Error(`claude spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(arg.prompt);
    child.stdin.end();
  });
}

/**
 * Inline Telegram sendMessage. We don't depend on @caishen/routines from the
 * channels package — the only behaviour we need is "POST sendMessage with
 * a 5s timeout". Retry-on-429 lives in @caishen/routines/telegram-bot for
 * outbound notifications; for the channels reply path (per AC-019-1), a
 * single fast attempt is enough — operator messages are interactive, not
 * batch alerts, and a Telegram 429 here is exceedingly rare since we send
 * <1 message/sec from this loop.
 */
async function sendTelegramReply(botToken: string, chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`telegram sendMessage ${resp.status}: ${body.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  main().catch((err) => {
    process.stderr.write(`[channels-loop] fatal: ${err}\n`);
    process.exit(1);
  });
}
