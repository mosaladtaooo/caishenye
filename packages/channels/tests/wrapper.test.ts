/**
 * FR-004 channels wrapper tests — RED phase.
 *
 * The wrapper is the bridge between Telegram inbound messages (delivered via
 * Telegram Bot API webhook OR long-poll, OR via Vercel synthetic-ping cron)
 * and the operator's caishen-telegram subagent.
 *
 * Per AC-007-2: BEFORE handing the message to the subagent, the wrapper
 * MUST insert a `telegram_interactions` row with received_at + raw text.
 * If THAT insert throws, the subagent MUST NOT be invoked (audit-or-abort).
 *
 * Per AC-005-1 (R5): SYNTHETIC_PING messages get the same audit row, but
 * with command_parsed='SYNTHETIC_PING' BEFORE the subagent sees them. The
 * subagent immediately replies with a no-op (just updates replied_at). This
 * keeps MAX(replied_at) fresh during quiet operator hours.
 *
 * Per AC-004-6: messages from non-allowlisted Telegram user IDs are
 * audit-logged (command_parsed='REJECTED_NOT_ALLOWED') and the subagent is
 * NOT invoked. The reply text is shipped via the same Telegram bot.
 *
 * The wrapper is pure TS — DI for db client + subagent invocation +
 * telegram sender, all stub-able in tests. Live wire-up is the systemd unit's
 * bash entry point (separate file).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type AuditWriter,
  handleWrapperEvent,
  parseCommand,
  type SubagentInvoker,
  type TelegramSender,
  type WrapperDeps,
  type WrapperEvent,
} from '../src/wrapper';

describe('wrapper.parseCommand', () => {
  it('extracts slash command from "/status"', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'slash', command: '/status', argv: [] });
  });

  it('extracts slash command + args from "/report EUR/USD"', () => {
    expect(parseCommand('/report EUR/USD')).toEqual({
      kind: 'slash',
      command: '/report',
      argv: ['EUR/USD'],
    });
  });

  it('treats free text as FREE_TEXT', () => {
    expect(parseCommand('hi caishen, how are positions doing?')).toEqual({
      kind: 'free_text',
    });
  });

  it('treats SYNTHETIC_PING marker as SYNTHETIC_PING', () => {
    expect(parseCommand('__SYNTHETIC_PING__')).toEqual({ kind: 'synthetic_ping' });
  });

  it('treats empty string as FREE_TEXT', () => {
    expect(parseCommand('')).toEqual({ kind: 'free_text' });
  });

  it('handles whitespace-trimmed slash command', () => {
    expect(parseCommand('  /balance  ')).toEqual({
      kind: 'slash',
      command: '/balance',
      argv: [],
    });
  });
});

function buildWrapperDeps(opts: {
  rejectAudit?: boolean;
  rejectInvoke?: boolean;
  rejectSettle?: boolean;
  rejectTelegram?: boolean;
  allowlist?: readonly bigint[];
  invokerReply?: string;
}): {
  deps: WrapperDeps;
  auditInsertCalls: Parameters<AuditWriter['insert']>[0][];
  auditUpdateCalls: Parameters<AuditWriter['update']>[0][];
  invokeCalls: Parameters<SubagentInvoker['invoke']>[0][];
  telegramCalls: Parameters<TelegramSender['send']>[0][];
} {
  const auditInsertCalls: Parameters<AuditWriter['insert']>[0][] = [];
  const auditUpdateCalls: Parameters<AuditWriter['update']>[0][] = [];
  const invokeCalls: Parameters<SubagentInvoker['invoke']>[0][] = [];
  const telegramCalls: Parameters<TelegramSender['send']>[0][] = [];

  const deps: WrapperDeps = {
    audit: {
      insert: vi.fn(async (row) => {
        auditInsertCalls.push(row);
        if (opts.rejectAudit) throw new Error('postgres: insert failed');
        return 999;
      }),
      update: vi.fn(async (row) => {
        auditUpdateCalls.push(row);
        if (opts.rejectSettle) throw new Error('postgres: update failed');
      }),
    },
    invoker: {
      invoke: vi.fn(async (arg) => {
        invokeCalls.push(arg);
        if (opts.rejectInvoke) throw new Error('subagent: invoke failed');
        return { replyText: opts.invokerReply ?? 'reply: ok' };
      }),
    },
    telegram: {
      send: vi.fn(async (arg) => {
        telegramCalls.push(arg);
        if (opts.rejectTelegram) throw new Error('telegram: 502');
      }),
    },
    loadAllowlist: vi.fn(async () => opts.allowlist ?? [BigInt(123456789)]),
    now: () => new Date('2026-05-04T12:00:00Z'),
  };

  return { deps, auditInsertCalls, auditUpdateCalls, invokeCalls, telegramCalls };
}

describe('wrapper.handleWrapperEvent — happy path', () => {
  it('inserts audit row BEFORE invoking subagent (constitution §3 audit-or-abort)', async () => {
    const order: string[] = [];
    const { deps } = buildWrapperDeps({});
    deps.audit.insert = vi.fn(async () => {
      order.push('audit_insert');
      return 1;
    });
    deps.invoker.invoke = vi.fn(async () => {
      order.push('invoke');
      return { replyText: 'ok' };
    });

    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '/status',
    };
    await handleWrapperEvent(ev, deps);

    expect(order).toEqual(['audit_insert', 'invoke']);
  });

  it('updates audit row with replied_at + reply_text after subagent completes', async () => {
    const { deps, auditUpdateCalls, telegramCalls } = buildWrapperDeps({
      invokerReply: '*Status — 2026-05-04*',
    });
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '/status',
    };
    await handleWrapperEvent(ev, deps);

    expect(auditUpdateCalls).toHaveLength(1);
    const upd = mustHave(auditUpdateCalls, 0);
    expect(upd.id).toBe(999);
    expect(upd.replyText).toBe('*Status — 2026-05-04*');
    expect(upd.repliedAt).toBeInstanceOf(Date);
    expect(telegramCalls).toHaveLength(1);
    expect(mustHave(telegramCalls, 0).text).toBe('*Status — 2026-05-04*');
    expect(mustHave(telegramCalls, 0).chatId).toBe(123456789);
  });

  it('parses /status command correctly into command_parsed=/status', async () => {
    const { deps, auditInsertCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '/status',
    };
    await handleWrapperEvent(ev, deps);

    expect(mustHave(auditInsertCalls, 0).commandParsed).toBe('/status');
  });

  it('parses free text correctly into command_parsed=FREE_TEXT', async () => {
    const { deps, auditInsertCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: 'how are we today?',
    };
    await handleWrapperEvent(ev, deps);

    expect(mustHave(auditInsertCalls, 0).commandParsed).toBe('FREE_TEXT');
  });
});

describe('wrapper.handleWrapperEvent — AC-004-6 allowlist', () => {
  it('rejects messages from non-allowlisted user IDs without invoking subagent', async () => {
    const { deps, auditInsertCalls, invokeCalls, telegramCalls } = buildWrapperDeps({
      allowlist: [BigInt(123456789)],
    });
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(999), // NOT on allowlist
      messageText: '/status',
    };
    await handleWrapperEvent(ev, deps);

    expect(auditInsertCalls).toHaveLength(1);
    expect(mustHave(auditInsertCalls, 0).commandParsed).toBe('REJECTED_NOT_ALLOWED');
    expect(invokeCalls).toHaveLength(0);
    // The wrapper still sends a polite Telegram refusal back to the rejected
    // user so they know what happened (per AC-004-6 + clarify Q1).
    expect(telegramCalls).toHaveLength(1);
    expect(mustHave(telegramCalls, 0).chatId).toBe(999);
    expect(mustHave(telegramCalls, 0).text).toMatch(/permission|not allowed|allowlist/i);
  });

  it('inserts audit row with REJECTED_NOT_ALLOWED reply_text and replied_at on rejection', async () => {
    const { deps, auditUpdateCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(999),
      messageText: '/status',
    };
    await handleWrapperEvent(ev, deps);

    expect(auditUpdateCalls).toHaveLength(1);
    expect(mustHave(auditUpdateCalls, 0).repliedAt).toBeInstanceOf(Date);
    expect(mustHave(auditUpdateCalls, 0).replyText).toMatch(/permission|not allowed|allowlist/i);
  });
});

describe('wrapper.handleWrapperEvent — SYNTHETIC_PING (R5)', () => {
  it('routes __SYNTHETIC_PING__ marker as command_parsed=SYNTHETIC_PING', async () => {
    const { deps, auditInsertCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '__SYNTHETIC_PING__',
    };
    await handleWrapperEvent(ev, deps);

    expect(mustHave(auditInsertCalls, 0).commandParsed).toBe('SYNTHETIC_PING');
  });

  it('SYNTHETIC_PING does NOT invoke subagent (no LLM tokens burned)', async () => {
    const { deps, invokeCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '__SYNTHETIC_PING__',
    };
    await handleWrapperEvent(ev, deps);

    expect(invokeCalls).toHaveLength(0);
  });

  it('SYNTHETIC_PING updates audit replied_at (the heartbeat itself)', async () => {
    const { deps, auditUpdateCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '__SYNTHETIC_PING__',
    };
    await handleWrapperEvent(ev, deps);

    expect(auditUpdateCalls).toHaveLength(1);
    expect(mustHave(auditUpdateCalls, 0).repliedAt).toBeInstanceOf(Date);
    // Reply text is null since no Telegram reply for synthetic-ping (the
    // ping's only purpose is to update the heartbeat row).
    expect(mustHave(auditUpdateCalls, 0).replyText).toBeNull();
  });

  it('SYNTHETIC_PING does NOT send a telegram reply (heartbeat-only)', async () => {
    const { deps, telegramCalls } = buildWrapperDeps({});
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '__SYNTHETIC_PING__',
    };
    await handleWrapperEvent(ev, deps);

    expect(telegramCalls).toHaveLength(0);
  });
});

describe('wrapper.handleWrapperEvent — audit-or-abort failure modes', () => {
  it('audit insert fails → throws → subagent NOT invoked (constitution §3)', async () => {
    const { deps, invokeCalls, telegramCalls } = buildWrapperDeps({ rejectAudit: true });
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '/status',
    };
    await expect(handleWrapperEvent(ev, deps)).rejects.toThrow(/postgres: insert failed/);

    expect(invokeCalls).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);
  });

  it('subagent invoke fails → audit row settled with reply_text=null + error_message', async () => {
    const { deps, auditUpdateCalls } = buildWrapperDeps({ rejectInvoke: true });
    const ev: WrapperEvent = {
      tenantId: 1,
      fromUserId: BigInt(123456789),
      messageText: '/status',
    };
    await expect(handleWrapperEvent(ev, deps)).rejects.toThrow(/subagent: invoke failed/);

    // The wrapper updates the audit row to settle it as failed BEFORE
    // re-throwing, so the row doesn't stay 'in flight' forever.
    expect(auditUpdateCalls).toHaveLength(1);
    expect(mustHave(auditUpdateCalls, 0).repliedAt).toBeInstanceOf(Date);
    expect(mustHave(auditUpdateCalls, 0).replyText).toBeNull();
  });
});

/**
 * Type-narrow helper: assert array index N is defined and return it. Lets
 * tsc strict mode see a non-undefined value after a length check.
 */
function mustHave<T>(arr: readonly T[], idx: number): T {
  const v = arr[idx];
  if (v === undefined) {
    throw new Error(`expected arr[${idx}] to be defined; arr.length=${arr.length}`);
  }
  return v;
}
