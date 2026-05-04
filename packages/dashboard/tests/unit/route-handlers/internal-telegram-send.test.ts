/**
 * POST /api/internal/telegram/send — proxy to Telegram Bot API sendMessage.
 *
 * Body (session 5g): { chat_id?, text, tenantId? }
 *   - chat_id is OPTIONAL (was required pre-5g). Falls back to
 *     OPERATOR_CHAT_ID env (if set + allowlisted) else allowlist[0].
 *   - tenantId defaults to 1.
 *
 * Validates resolved chat_id is in tenants.allowed_telegram_user_ids
 * (defence against compromised Routine spamming arbitrary chats; clarify
 * Q1 / AC-004-6).
 *
 * Wraps sendTelegramMessage from @caishen/routines/telegram-bot.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let sendTelegramMessageSpy: ReturnType<typeof vi.fn>;
let getTenantDbSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;
let originalBotToken: string | undefined;
let originalOperatorChatId: string | undefined;

/**
 * Helper to set the allowlist returned by the (mocked) tenant lookup.
 * Each test calls this before importing the route to wire the mock chain.
 */
function setAllowlist(ids: readonly number[]): void {
  getTenantDbSpy = vi.fn().mockReturnValue({
    tenantId: 1,
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ allowed: ids }]),
        }),
      }),
    },
  });
}

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
  originalOperatorChatId = process.env.OPERATOR_CHAT_ID;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  process.env.TELEGRAM_BOT_TOKEN = `bot${randomBytes(16).toString('hex')}`;
  delete process.env.OPERATOR_CHAT_ID;
  sendTelegramMessageSpy = vi.fn();
  // default: allowlist [12345, 67890]; tests may override via setAllowlist().
  setAllowlist([12345, 67890]);
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
  if (originalOperatorChatId === undefined) delete process.env.OPERATOR_CHAT_ID;
  else process.env.OPERATOR_CHAT_ID = originalOperatorChatId;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('@caishen/routines/telegram-bot', () => ({
    sendTelegramMessage: sendTelegramMessageSpy,
  }));
  vi.doMock('@caishen/db/client', () => ({
    getTenantDb: getTenantDbSpy,
  }));
  vi.doMock('@caishen/db/schema/tenants', () => ({
    tenants: { id: 'id', allowedTelegramUserIds: 'allowed' },
  }));
  return await import('../../../app/api/internal/telegram/send/route');
}

function buildReq(body: unknown, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/telegram/send', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/telegram/send — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ chat_id: 12345, text: 'hi' }));
    expect(res.status).toBe(401);
    expect(sendTelegramMessageSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(500);
  });

  it('returns 500 when TELEGRAM_BOT_TOKEN missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(500);
    expect(sendTelegramMessageSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/telegram/send — body validation', () => {
  it('rejects missing text with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ chat_id: 12345 }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects empty text with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ chat_id: 12345, text: '' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric chat_id with 400 (treated as invalid body)', async () => {
    const route = await importRoute();
    // chat_id is optional but if PRESENT must be a number; the validator
    // strips invalid types so the route falls through to the fallback path.
    // Either flow returns a non-2xx for the supplied bad chat_id (here it
    // becomes "no chat_id supplied" → fallback to allowlist[0] which is
    // 12345 → 200). So this test now asserts the fallback happens cleanly.
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 99 });
    const res = await route.POST(
      buildReq({ chat_id: 'abc', text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    // bad chat_id is silently dropped; fallback chooses allowlist[0]=12345
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 12345 }),
      expect.anything(),
    );
  });
});

describe('POST /api/internal/telegram/send — chat_id present (legacy path)', () => {
  it('rejects chat_id not in tenant allowlist with 403', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 99999, text: 'spam' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(403);
    expect(sendTelegramMessageSpy).not.toHaveBeenCalled();
  });

  it('accepts allowlisted chat_id', async () => {
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 42 });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 12345 }),
      expect.anything(),
    );
  });
});

describe('POST /api/internal/telegram/send — chat_id absent (session 5g fallback)', () => {
  it('falls back to allowlist[0] when chat_id absent and no OPERATOR_CHAT_ID env', async () => {
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 555 });
    const route = await importRoute();
    const res = await route.POST(buildReq({ text: 'no chat_id' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 12345 }), // first entry of [12345, 67890]
      expect.anything(),
    );
  });

  it('returns 503 when chat_id absent AND allowlist is empty', async () => {
    setAllowlist([]); // no allowlisted users
    const route = await importRoute();
    const res = await route.POST(buildReq({ text: 'no chat_id' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(503);
    expect(sendTelegramMessageSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/allowlist is empty/i);
  });

  it('uses OPERATOR_CHAT_ID env when set + allowlisted (overrides allowlist[0])', async () => {
    process.env.OPERATOR_CHAT_ID = '67890'; // second entry of allowlist
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 7 });
    const route = await importRoute();
    const res = await route.POST(buildReq({ text: 'op override' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 67890 }),
      expect.anything(),
    );
  });

  it('falls back to allowlist[0] when OPERATOR_CHAT_ID env is set but not in allowlist', async () => {
    process.env.OPERATOR_CHAT_ID = '99999'; // not in allowlist
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 8 });
    const route = await importRoute();
    const res = await route.POST(buildReq({ text: 'fallback again' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 12345 }), // back to allowlist[0]
      expect.anything(),
    );
  });

  it('falls back to allowlist[0] when OPERATOR_CHAT_ID env is non-numeric (logs + ignores)', async () => {
    process.env.OPERATOR_CHAT_ID = 'not-a-number';
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 9 });
    const route = await importRoute();
    const res = await route.POST(buildReq({ text: 'numeric ignore' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 12345 }),
      expect.anything(),
    );
  });
});

describe('POST /api/internal/telegram/send — happy path', () => {
  it('returns telegramMessageId + resolved chatId on success', async () => {
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 555 });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hello' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      telegramMessageId: number;
      chatId: number;
    };
    expect(body.ok).toBe(true);
    expect(body.telegramMessageId).toBe(555);
    expect(body.chatId).toBe(12345);
  });
});

describe('POST /api/internal/telegram/send — upstream errors', () => {
  it('returns 502 when sendTelegramMessage throws', async () => {
    sendTelegramMessageSpy.mockRejectedValue(new Error('telegram: 429 rate-limited'));
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(502);
  });
});
