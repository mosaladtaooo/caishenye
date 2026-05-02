/**
 * MT5 REST client (server-only) — used by override route handlers + the
 * dashboard's read-only Overview/Per-pair pages.
 *
 * Per FR-009 + ADR-005: the operator's MT5 endpoint sits behind a Tailscale
 * Funnel + nginx bearer-proxy. This module just talks HTTPS to that
 * endpoint with a bearer token; all the deployment-side hardening lives in
 * infra/vps/.
 *
 * EC-003-1 retry-with-backoff (2× 10s) is implemented here so callers don't
 * each have to redo it. The override-handler treats a final retry exhaustion
 * as a write failure (boundary (c) — settle override row to success=false).
 */

const MT5_DEFAULT_TIMEOUT_MS = 10_000;
const MT5_MAX_ATTEMPTS = 3; // 1 initial + 2 retries per EC-003-1
const MT5_RETRY_BACKOFF_MS = 10_000;

export interface Mt5RequestOptions {
  /** Override timeout per request (defaults to 10s). */
  timeoutMs?: number;
  /** If true, skip retry-on-5xx (used for read-only paths where freshness wins). */
  skipRetry?: boolean;
}

function readEnv(): { baseUrl: string; bearer: string } {
  const baseUrl = process.env.MT5_BASE_URL ?? '';
  const bearer = process.env.MT5_BEARER_TOKEN ?? '';
  if (baseUrl.length === 0) {
    throw new Error('mt5: MT5_BASE_URL missing in env');
  }
  if (bearer.length === 0) {
    throw new Error('mt5: MT5_BEARER_TOKEN missing in env');
  }
  return { baseUrl, bearer };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function mt5Fetch(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: Mt5RequestOptions = {},
): Promise<unknown> {
  const { baseUrl, bearer } = readEnv();
  const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const timeout = options.timeoutMs ?? MT5_DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.skipRetry === true ? 1 : MT5_MAX_ATTEMPTS;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${bearer}`,
      };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body ?? {});
      }
      const res = await fetch(url, init);
      clearTimeout(timer);
      if (res.status >= 500 && attempt < maxAttempts) {
        // 5xx → retry per EC-003-1
        await sleep(MT5_RETRY_BACKOFF_MS);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`mt5: ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 256)}`);
      }
      return (await res.json()) as unknown;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(MT5_RETRY_BACKOFF_MS);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`mt5: ${method} ${path} failed`);
}

export async function mt5Get(path: string, options?: Mt5RequestOptions): Promise<unknown> {
  return mt5Fetch('GET', path, undefined, options);
}

export async function mt5Post(
  path: string,
  body: unknown,
  options?: Mt5RequestOptions,
): Promise<unknown> {
  return mt5Fetch('POST', path, body, options);
}
