/**
 * Direct Telegram Bot API alert path for the cron-runner.
 *
 * NOT routed through the Channels session loop -- the failures we alert
 * on include "Channels session dead", so the alert path must be independent.
 *
 * Env: TELEGRAM_BOT_TOKEN + OPERATOR_CHAT_ID (operator-supplied via the
 * VPS-managed env file consumed by the NSSM service).
 *
 * Returns true on successful sendMessage 200; false on any failure (no
 * throw). Caller logs alongside its tick payload.
 */

const TG_TIMEOUT_MS = 5_000;

export async function sendDirectAlert(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.OPERATOR_CHAT_ID ?? '';
  if (token.length === 0 || chatId.length === 0) {
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}
