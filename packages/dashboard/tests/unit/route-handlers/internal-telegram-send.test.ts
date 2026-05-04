/**
 * POST /api/internal/telegram/send — proxy to Telegram Bot API sendMessage.
 *
 * Body: { chat_id, text, tenantId? } — tenantId defaults to 1.
 * Validates chat_id is in tenants.allowed_telegram_user_ids (defence
 * against compromised Routine spamming arbitrary chats).
 * Wraps sendTelegramMessage from @caishen/routines/telegram-bot.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');

let sendTelegramMessageSpy: ReturnType<typeof vi.fn>;
let getTenantDbSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;
let originalBotToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  process.env.TELEGRAM_BOT_TOKEN = `bot${randomBytes(16).toString('hex')}`;
  sendTelegramMessageSpy = vi.fn();
  // default: allowlist [12345, 67890]
  getTenantDbSpy = vi.fn().mockReturnValue({
    tenantId: 1,
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ allowed: [12345, 67890] }]),
        }),
      }),
    },
  });
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
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
  it('rejects missing chat_id with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ text: 'hi' }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects missing text with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(buildReq({ chat_id: 12345 }, `Bearer ${fixtureBearer}`));
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric chat_id with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 'abc', text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/internal/telegram/send — allowlist enforcement', () => {
  it('rejects chat_id not in tenant allowlist with 403', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 99999, text: 'spam' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(403);
    expect(sendTelegramMessageSpy).not.toHaveBeenCalled();
  });

  it('accepts chat_id in tenant allowlist', async () => {
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 42 });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hi' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    expect(sendTelegramMessageSpy).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/internal/telegram/send — happy path', () => {
  it('returns telegramMessageId on success', async () => {
    sendTelegramMessageSpy.mockResolvedValue({ ok: true, message_id: 555 });
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ chat_id: 12345, text: 'hello' }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; telegramMessageId: number };
    expect(body.ok).toBe(true);
    expect(body.telegramMessageId).toBe(555);
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
