/**
 * Direct Telegram Bot API alert path tests.
 *
 * The cron-runner emits alerts OUT-OF-BAND (NOT through the Channels session
 * loop) because the failure modes it guards against include "the Channels
 * session is dead." Direct sendMessage with bot token + operator chat id.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDirectAlert } from '../src/alert';

const tgToken = `${randomBytes(8).toString('hex')}:test-bot`;
const operatorChat = '12345';

let originalToken: string | undefined;
let originalChat: string | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalToken = process.env.TELEGRAM_BOT_TOKEN;
  originalChat = process.env.OPERATOR_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = tgToken;
  process.env.OPERATOR_CHAT_ID = operatorChat;
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.OPERATOR_CHAT_ID;
  else process.env.OPERATOR_CHAT_ID = originalChat;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendDirectAlert -- happy path', () => {
  it('POSTs to api.telegram.org/bot{token}/sendMessage with chat_id + text', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const ok = await sendDirectAlert('test alert text');
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${tgToken}/sendMessage`);
    const body = JSON.parse(init.body as string) as { chat_id: string; text: string };
    expect(body.chat_id).toBe(operatorChat);
    expect(body.text).toBe('test alert text');
  });
});

describe('sendDirectAlert -- error paths', () => {
  it('returns false (no throw) when fetch rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const ok = await sendDirectAlert('x');
    expect(ok).toBe(false);
  });

  it('returns false when Telegram returns non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 }));
    const ok = await sendDirectAlert('x');
    expect(ok).toBe(false);
  });

  it('returns false when TELEGRAM_BOT_TOKEN missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const ok = await sendDirectAlert('x');
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns false when OPERATOR_CHAT_ID missing', async () => {
    delete process.env.OPERATOR_CHAT_ID;
    const ok = await sendDirectAlert('x');
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
