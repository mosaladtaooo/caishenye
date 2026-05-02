/**
 * FR-019 — Direct Telegram Bot API client (per ADR-007).
 *
 * Why direct (not through Channels session):
 *   - Zero LLM tokens spent on templated outbound messages.
 *   - Outbound notifications still flow even when the Channels session is
 *     dead (RISK-002 mitigation).
 *   - The Channels session is the inbound surface only (slash commands +
 *     free-text Q&A from the operator).
 *
 * Behavior:
 *   - 5s timeout per attempt via AbortController.
 *   - Retry-with-exponential-backoff on 429 (rate-limited): 3 attempts,
 *     starting at retry_after-from-server (or 1s default), capped at 30s.
 *   - On success returns { ok: true, message_id }.
 *   - On exhausted retries throws Error("rate-limited: 3 attempts...").
 *   - Network/4xx/5xx (other than 429) → throw immediately.
 *
 * Constitution §17 — no `any`; uses unknown + narrow + structured types.
 */

export interface SendMessageInput {
  chatId: number;
  text: string;
}

export interface SendMessageResult {
  ok: true;
  message_id: number;
}

export interface SendDeps {
  fetch: typeof fetch;
  botToken: string;
  /** Injectable sleep so tests don't actually wait. */
  sleep: (ms: number) => Promise<void>;
}

const TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_BACKOFF_MS = 1_000;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface TelegramSendResultPayload {
  message_id: number;
}

/**
 * Send a Telegram message via the Bot API. Retries on 429.
 *
 * Returns the parsed `result` on success.
 * Throws Error on non-429 HTTP failures and on exhausted-429-retries.
 */
export async function sendTelegramMessage(
  input: SendMessageInput,
  deps: SendDeps,
): Promise<SendMessageResult> {
  const url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`;
  const body = JSON.stringify({ chat_id: input.chatId, text: input.text });

  let attempt = 0;
  let lastError: string | null = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const resp = await deps.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const parsed = (await resp.json()) as TelegramApiResponse<TelegramSendResultPayload>;

      if (resp.status === 429) {
        const retryAfterSec = parsed.parameters?.retry_after ?? 1;
        const backoff = Math.min(
          Math.max(retryAfterSec * 1000, DEFAULT_BACKOFF_MS * 2 ** (attempt - 1)),
          MAX_BACKOFF_MS,
        );
        lastError = `429 (retry_after=${retryAfterSec}s)`;
        if (attempt < MAX_ATTEMPTS) {
          await deps.sleep(backoff);
          continue;
        }
        throw new Error(`telegram-bot: rate-limited after ${MAX_ATTEMPTS} attempts (${lastError})`);
      }

      if (!resp.ok || !parsed.ok || !parsed.result) {
        throw new Error(
          `telegram-bot: send failed (status=${resp.status}, code=${parsed.error_code ?? 'unknown'}, desc=${parsed.description ?? ''})`,
        );
      }

      return { ok: true, message_id: parsed.result.message_id };
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') {
        // Timeout fires the abort — treat as a transient failure with backoff.
        if (attempt < MAX_ATTEMPTS) {
          await deps.sleep(DEFAULT_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`telegram-bot: timed out after ${MAX_ATTEMPTS} attempts`);
      }
      throw e;
    }
  }

  // Defensive — loop should always exit via return or throw.
  throw new Error(`telegram-bot: unexpected loop exit after ${attempt} attempts`);
}

// ────────────────────────────────────────────────────────────────────────────
// AC-019-2 + AC-019-3 message formatters
// ────────────────────────────────────────────────────────────────────────────

export interface ExecutorSuccessFields {
  pair: string;
  action: string;
  keyNumbers: string;
}

/**
 * Per AC-019-2: `{PAIR}\n{ACTION}\n{KEY_NUMBERS}\nSee /report {pair} for full reasoning`.
 */
export function formatExecutorSuccessMessage(f: ExecutorSuccessFields): string {
  return `${f.pair}\n${f.action}\n${f.keyNumbers}\nSee /report ${f.pair} for full reasoning`;
}

export interface ExecutorErrorFields {
  pair: string;
  errorMessage: string;
  routineRunId: number;
}

const ERROR_MESSAGE_MAX_LEN = 500;

/**
 * Per AC-019-3: `{PAIR} ERROR\n{error_message}\nAudit: routine_run_id={N}`.
 *
 * Defensive: errorMessage is truncated to 500 chars to keep total
 * message under Telegram's 4096-char limit AND to avoid leaking unbounded
 * stack traces into the operator's Telegram history.
 */
export function formatExecutorErrorMessage(f: ExecutorErrorFields): string {
  const truncated =
    f.errorMessage.length > ERROR_MESSAGE_MAX_LEN
      ? `${f.errorMessage.slice(0, ERROR_MESSAGE_MAX_LEN)}…`
      : f.errorMessage;
  return `${f.pair} ERROR\n${truncated}\nAudit: routine_run_id=${f.routineRunId}`;
}
