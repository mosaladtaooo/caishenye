/**
 * cron-runner per-tick logic.
 *
 * AC-024-1: each tick sequentially fetches the 3 Vercel cron endpoints with
 * CRON_SECRET bearer, then logs a structured 6-key JSON line to stdout.
 *
 * R7-a stdout-shape pin: uses process.stdout.write (NOT console.log -- the
 * channels loop precedent is process.stdout.write per round-2 review of
 * packages/channels/scripts/loop.ts). This MUST be honored so the test
 * spy works.
 *
 * Constitution section 17: every fetch is wrapped in try/catch -- a failing
 * fetch must not bring down the whole runner; the next tick is the retry.
 * Status sentinel 0 is used when no HTTP response was received (network
 * error, abort, etc.); the counters module distinguishes 0 from an actual
 * 5xx for alert-policy purposes.
 */

const FETCH_TIMEOUT_MS = 30_000;

const FIRE = 'fire-due-executors' as const;
const CLOSE = 'close-due-sessions' as const;
const HEALTH = 'cron/health' as const;

export interface TickPayload {
  ts: string;
  tick_id: number;
  fire_status: number;
  close_status: number;
  health_status: number;
  duration_ms: number;
}

export interface RunOneTickArg {
  tickId: number;
}

async function fetchOne(path: string, body?: unknown): Promise<number> {
  const baseUrl = process.env.VERCEL_BASE_URL ?? 'https://caishenv2.vercel.app';
  const cronSecret = process.env.CRON_SECRET ?? '';
  if (cronSecret.length === 0) {
    process.stderr.write('[cron-runner] CRON_SECRET missing -- cannot fetch\n');
    return 0;
  }
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${cronSecret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      signal: controller.signal,
    };
    if (body !== undefined) (init as { body?: string }).body = JSON.stringify(body);
    const r = await fetch(url, init);
    clearTimeout(timer);
    return r.status;
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[cron-runner] fetch ${path} failed: ${msg}\n`);
    return 0;
  }
}

export async function runOneTick(arg: RunOneTickArg): Promise<TickPayload> {
  const t0 = Date.now();
  const ts = new Date(t0).toISOString();
  const runnerId = process.env.CAISHEN_RUNNER_ID ?? 'vps-windows-default';

  const fireStatus = await fetchOne('/api/cron/fire-due-executors');
  const closeStatus = await fetchOne('/api/cron/close-due-sessions');
  const healthStatus = await fetchOne('/api/cron/health', { runner_id: runnerId });
  const durationMs = Date.now() - t0;

  const payload: TickPayload = {
    ts,
    tick_id: arg.tickId,
    fire_status: fireStatus,
    close_status: closeStatus,
    health_status: healthStatus,
    duration_ms: durationMs,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return payload;
}

/** Endpoint name keys used by the counters module. */
export const ENDPOINT_NAMES = { FIRE, CLOSE, HEALTH } as const;
