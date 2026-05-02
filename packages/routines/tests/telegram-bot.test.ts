/**
 * FR-019 — Direct Telegram Bot API (no Channels-session conduit; ADR-007).
 *
 * AC-019-1: Direct POST to https://api.telegram.org/bot{TOKEN}/sendMessage.
 *           5s timeout. Zero LLM tokens (no LLM in the loop).
 * AC-019-2: Executor success message body matches n8n format roughly:
 *             {PAIR}\n{ACTION}\n{KEY_NUMBERS}\nSee /report {pair} for full reasoning
 * AC-019-3: Executor error message body:
 *             {PAIR} ERROR\n{error_message}\nAudit: routine_run_id={N}
 * EC-019-1: Rate-limited → retry with exponential backoff (3 attempts, max 30s).
 *
 * Tests stub `fetch` so they don't need a real bot token. The fixture
 * label below is obviously not a real bot token (real ones are 8-10 digit
 * id + colon + 35 alphanumeric).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  formatExecutorErrorMessage,
  formatExecutorSuccessMessage,
  type SendDeps,
  sendTelegramMessage,
} from '../src/telegram-bot';

const TEST_FIXTURE_BEARER_LABEL = 'TEST_FIXTURE_BOT_LABEL_NOT_REAL';
const FAKE_CHAT_ID = 123456789;

function ok(body: unknown = { ok: true, result: { message_id: 42 } }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tooMany(retryAfter = 1): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function makeDeps(over: Partial<SendDeps> = {}): SendDeps {
  return {
    fetch: vi.fn(async () => ok()) as unknown as typeof fetch,
    botToken: TEST_FIXTURE_BEARER_LABEL,
    sleep: vi.fn(async () => undefined),
    ...over,
  };
}

describe('FR-019 AC-019-1: sendTelegramMessage POST shape', () => {
  it('POSTs to https://api.telegram.org/bot{TOKEN}/sendMessage', async () => {
    const fetchMock = vi.fn(async () => ok()) as unknown as typeof fetch;
    const deps = makeDeps({ fetch: fetchMock });

    await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'hello' }, deps);

    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TEST_FIXTURE_BEARER_LABEL}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
      }),
    );
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: FAKE_CHAT_ID, text: 'hello' });
  });

  it('returns the parsed response on success (ok=true)', async () => {
    const deps = makeDeps();
    const result = await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'hi' }, deps);
    expect(result.ok).toBe(true);
    expect(result.message_id).toBe(42);
  });
});

describe('FR-019 EC-019-1: rate-limit retry-with-backoff', () => {
  it('retries up to 3 times on 429, then succeeds', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call < 3) return tooMany();
      return ok();
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    const result = await sendTelegramMessage(
      { chatId: FAKE_CHAT_ID, text: 'hi' },
      { fetch: fetchMock, botToken: TEST_FIXTURE_BEARER_LABEL, sleep },
    );

    expect(result.ok).toBe(true);
    expect(call).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2); // backoff between attempts
  });

  it('throws after 3 attempts when all are rate-limited', async () => {
    const fetchMock = vi.fn(async () => tooMany()) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(
      sendTelegramMessage(
        { chatId: FAKE_CHAT_ID, text: 'hi' },
        { fetch: fetchMock, botToken: TEST_FIXTURE_BEARER_LABEL, sleep },
      ),
    ).rejects.toThrow(/rate.*limit|429/i);
  });

  it('uses the retry_after value from the 429 response (capped at 30s)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call < 2) return tooMany(5); // server says wait 5 seconds
      return ok();
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await sendTelegramMessage(
      { chatId: FAKE_CHAT_ID, text: 'hi' },
      { fetch: fetchMock, botToken: TEST_FIXTURE_BEARER_LABEL, sleep },
    );

    expect(sleep).toHaveBeenCalledTimes(1);
    const [waitedMs] = (sleep as unknown as { mock: { calls: number[][] } }).mock.calls[0] ?? [];
    expect(waitedMs).toBeGreaterThanOrEqual(5000);
    expect(waitedMs).toBeLessThanOrEqual(30000);
  });
});

describe('FR-019 AC-019-1: 5s timeout per attempt', () => {
  it('attaches an AbortSignal to the fetch call', async () => {
    let receivedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal ?? null;
      return ok();
    }) as unknown as typeof fetch;

    const deps = makeDeps({ fetch: fetchMock });
    await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'hi' }, deps);

    expect(receivedSignal).not.toBeNull();
    // Signal presence proves the abort path is wired; full timeout-fires
    // verification would need vi.useFakeTimers + a non-resolving fetch,
    // which we leave for an integration suite. Unit assertion is signal != null.
  });
});

describe('FR-019 AC-019-2: Executor success message format', () => {
  it('formats: {PAIR}\\n{ACTION}\\n{KEY_NUMBERS}\\nSee /report {pair} for full reasoning', () => {
    const msg = formatExecutorSuccessMessage({
      pair: 'EUR/USD',
      action: 'opened LONG @ 1.0820',
      keyNumbers: 'SL 1.0795, TP 1.0870',
    });
    expect(msg).toBe(
      'EUR/USD\nopened LONG @ 1.0820\nSL 1.0795, TP 1.0870\nSee /report EUR/USD for full reasoning',
    );
  });

  it('handles "no trade" decisions cleanly', () => {
    const msg = formatExecutorSuccessMessage({
      pair: 'XAU/USD',
      action: 'no trade — wait for NY OB retest',
      keyNumbers: 'no order placed',
    });
    expect(msg).toMatch(/^XAU\/USD\n/);
    expect(msg).toMatch(/no trade/);
    expect(msg).toMatch(/See \/report XAU\/USD/);
  });
});

describe('FR-019 AC-019-3: Executor error message format', () => {
  it('formats: {PAIR} ERROR\\n{error_message}\\nAudit: routine_run_id={N}', () => {
    const msg = formatExecutorErrorMessage({
      pair: 'EUR/USD',
      errorMessage: 'mt5_timeout: 5s budget exceeded',
      routineRunId: 4242,
    });
    expect(msg).toBe('EUR/USD ERROR\nmt5_timeout: 5s budget exceeded\nAudit: routine_run_id=4242');
  });

  it('truncates very long error messages to 500 chars (defensive)', () => {
    const long = 'x'.repeat(1000);
    const msg = formatExecutorErrorMessage({
      pair: 'EUR/USD',
      errorMessage: long,
      routineRunId: 1,
    });
    // Total message ≤ ~600 chars (pair + ERROR + truncated error + audit).
    expect(msg.length).toBeLessThan(600);
    expect(msg).toMatch(/EUR\/USD ERROR/);
    expect(msg).toMatch(/Audit: routine_run_id=1/);
  });
});
