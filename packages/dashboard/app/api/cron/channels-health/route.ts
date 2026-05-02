/**
 * /api/cron/channels-health — every 5 min (FR-005 AC-005-2).
 *
 * Polls the VPS healthcheck endpoint via Tailscale Funnel + bearer, records
 * the outcome to channels_health, and alerts via Telegram when liveness has
 * been false for >10 min consecutively.
 *
 * The endpoint URL + bearer come from env (HEALTHCHECK_URL + HEALTH_BEARER_TOKEN);
 * mocked in tests via vi.stubGlobal('fetch', ...).
 *
 * ADR-009 mute marker: suppresses the alert if `mute_alarm_until` is in the
 * future (operator silenced during scheduled maintenance / planned restart).
 *
 * R3 audit-or-abort: every cron tick inserts a channels_health row even
 * when the upstream fetch fails — operator visibility into "couldn't reach
 * the VPS at HH:MM" is the whole point of the table.
 */

import {
  insertChannelsHealthRow,
  isMutedAlarm,
  queryLastUnhealthyTransition,
} from '@/lib/channels-health-cron';
import { validateCronAuth } from '@/lib/cron-auth';
import { sendTelegramBroadcast } from '@/lib/telegram-broadcast';

const TENANT_ID = 1;
const HEALTH_FETCH_TIMEOUT_MS = 5_000;
/** Threshold at which we escalate to Telegram alert per AC-005-2. */
const UNHEALTHY_ALERT_THRESHOLD_MS = 10 * 60_000;

interface UpstreamHealth {
  ok: boolean;
  healthy: boolean;
  latencyMs: number;
  error: string | null;
}

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  const checkedAt = new Date();
  const upstream = await fetchHealth();

  await insertChannelsHealthRow({
    tenantId: TENANT_ID,
    checkedAt,
    healthyBool: upstream.healthy,
    latencyMs: upstream.ok ? upstream.latencyMs : null,
    error: upstream.error,
  });

  if (!upstream.healthy) {
    const transitionedAt = await queryLastUnhealthyTransition(TENANT_ID);
    if (transitionedAt !== null) {
      const downMs = checkedAt.getTime() - transitionedAt.getTime();
      if (downMs >= UNHEALTHY_ALERT_THRESHOLD_MS) {
        const muted = await isMutedAlarm(TENANT_ID, checkedAt);
        if (!muted) {
          const minutes = Math.round(downMs / 60_000);
          const errPart =
            upstream.error !== null && upstream.error.length > 0 ? ` (${upstream.error})` : '';
          await sendTelegramBroadcast(
            `[caishen] channels session unhealthy for ${minutes} min${errPart}`,
          );
        }
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      healthy: upstream.healthy,
      latencyMs: upstream.ok ? upstream.latencyMs : null,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function fetchHealth(): Promise<UpstreamHealth> {
  const url = process.env.HEALTHCHECK_URL ?? '';
  const bearer = process.env.HEALTH_BEARER_TOKEN ?? '';
  if (url.length === 0 || bearer.length === 0) {
    return {
      ok: false,
      healthy: false,
      latencyMs: 0,
      error: 'HEALTHCHECK_URL or HEALTH_BEARER_TOKEN missing in env',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_FETCH_TIMEOUT_MS);
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return {
        ok: false,
        healthy: false,
        latencyMs,
        error: `${resp.status} ${body.slice(0, 200)}`.trim(),
      };
    }

    const body = (await resp.json()) as { healthy?: unknown };
    const healthy = body.healthy === true;
    return { ok: true, healthy, latencyMs, error: null };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, healthy: false, latencyMs: 0, error: msg };
  }
}
