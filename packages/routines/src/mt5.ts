/**
 * MT5 REST client for Routines (Planner + Executor).
 *
 * The Executor calls this from inside its Routine Bash step to read pre-fire
 * state and place orders. Per FR-009 + ADR-005 the MT5 endpoint is reachable
 * via Tailscale Funnel + nginx bearer-proxy; this client just talks HTTPS to
 * the configured MT5_BASE_URL with the operator-issued bearer.
 *
 * EC-003-1: 5xx responses retry with exponential backoff (2 retries, 10s base).
 * Constitution §17: no `any`; all responses are unknown until narrowed.
 *
 * Symmetric with packages/dashboard/lib/mt5-server.ts but for the Routine
 * runtime — separate copies because routines runs server-side under Bun and
 * the dashboard runs under Next.js Edge/Node; they share no module space.
 */

const MT5_DEFAULT_TIMEOUT_MS = 10_000;
const MT5_MAX_ATTEMPTS = 3; // 1 initial + 2 retries per EC-003-1
const MT5_BASE_BACKOFF_MS = 10_000;

export interface Mt5RequestOptions {
  timeoutMs?: number;
  /** Skip retry-on-5xx (used for read paths where freshness wins). */
  skipRetry?: boolean;
}

export interface Mt5Deps {
  fetch: typeof fetch;
  baseUrl: string;
  bearer: string;
  /** Injectable sleep so tests don't actually wait. */
  sleep: (ms: number) => Promise<void>;
}

export function readEnvMt5(): { baseUrl: string; bearer: string } {
  const baseUrl = process.env.MT5_BASE_URL ?? '';
  const bearer = process.env.MT5_BEARER_TOKEN ?? '';
  if (baseUrl.length === 0) throw new Error('mt5: MT5_BASE_URL missing in env');
  if (bearer.length === 0) throw new Error('mt5: MT5_BEARER_TOKEN missing in env');
  return { baseUrl, bearer };
}

async function mt5Fetch(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  deps: Mt5Deps,
  options: Mt5RequestOptions = {},
): Promise<unknown> {
  const url = `${deps.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const timeout = options.timeoutMs ?? MT5_DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.skipRetry === true ? 1 : MT5_MAX_ATTEMPTS;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${deps.bearer}`,
      };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body ?? {});
      }
      const res = await deps.fetch(url, init);
      clearTimeout(timer);
      if (res.status >= 500 && attempt < maxAttempts) {
        await deps.sleep(MT5_BASE_BACKOFF_MS * attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`mt5: ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 256)}`);
      }
      return (await res.json()) as unknown;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < maxAttempts) {
        await deps.sleep(MT5_BASE_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`mt5: ${method} ${path} failed`);
}

export async function mt5Get(
  path: string,
  deps: Mt5Deps,
  options?: Mt5RequestOptions,
): Promise<unknown> {
  return mt5Fetch('GET', path, undefined, deps, options);
}

export async function mt5Post(
  path: string,
  body: unknown,
  deps: Mt5Deps,
  options?: Mt5RequestOptions,
): Promise<unknown> {
  return mt5Fetch('POST', path, body, deps, options);
}
