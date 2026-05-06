/**
 * GET /api/cron/runner-watchdog -- AC-024-4 path 2 Vercel-cron backstop.
 *
 * v1.2 FR-024 D5: vercel.json schedules this route at `*\/30 * * * *` (every
 * 30 minutes; Hobby tier supports this cadence -- the Hobby restriction is
 * per-deployment cron count, NOT per-cron-cadence).
 *
 * The route queries MAX(pinged_at) FROM cron_runner_health WHERE tenant_id=$1
 * and decides:
 *   - max_pinged_at within the last 30 min  -> no alert (runner is alive)
 *   - max_pinged_at older than 30 min       -> 1 Telegram Bot API alert
 *   - no rows at all                         -> 1 alert (never received any pings)
 *
 * Telegram alert path: DIRECT Bot API (NOT through the Channels session,
 * because the failure mode this guards against is "cron-runner is dead and
 * the self-watch alert it would have emitted didn't fire either"). Uses
 * TELEGRAM_BOT_TOKEN + OPERATOR_CHAT_ID env vars.
 *
 * Constitution section 17: Telegram fetch failures are caught + logged +
 * surfaced in the response (alertError field) but do NOT crash the route.
 *
 * Auth: CRON_SECRET (Vercel-cron-style bearer).
 */

import { getTenantDb } from '@caishen/db/client';
import { cronRunnerHealth } from '@caishen/db/schema/cron-runner-health';
import { eq, sql } from 'drizzle-orm';
import { validateCronAuth } from '@/lib/cron-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const STALE_THRESHOLD_MS = 30 * 60_000; // 30 minutes
const DEFAULT_TENANT_ID = Number(process.env.DEFAULT_TENANT_ID ?? '1');

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  const tenantId =
    Number.isFinite(DEFAULT_TENANT_ID) && DEFAULT_TENANT_ID > 0 ? DEFAULT_TENANT_ID : 1;

  let maxPingedAt: Date | null = null;
  try {
    const tenantDb = getTenantDb(tenantId);
    const rows = (await tenantDb.drizzle
      .select({ maxPingedAt: sql<Date | null>`MAX(${cronRunnerHealth.pingedAt})` })
      .from(cronRunnerHealth)
      .where(eq(cronRunnerHealth.tenantId, tenantId))) as Array<{
      maxPingedAt: Date | null;
    }>;
    maxPingedAt = rows[0]?.maxPingedAt ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[cron/runner-watchdog] DB read failed: ${msg}\n`);
    return jsonRes(500, {
      error: `cron_runner_health max(pinged_at) query failed: ${msg.slice(0, 256)}`,
    });
  }

  // Decide alert policy.
  let shouldAlert = false;
  let alertText = '';
  const now = Date.now();
  if (maxPingedAt === null) {
    shouldAlert = true;
    alertText =
      '[caishen] Cron-runner watchdog: never received any pings -- runner may have never started';
  } else {
    const ageMs = now - new Date(maxPingedAt).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      shouldAlert = true;
      const lastIso = new Date(maxPingedAt).toISOString();
      alertText = `[caishen] Cron-runner ALL DEAD -- last ping ${lastIso}, 30+ min stale`;
    }
  }

  let alertEmitted = false;
  let alertError: string | undefined;
  if (shouldAlert) {
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
      const chatId = process.env.OPERATOR_CHAT_ID ?? '';
      if (botToken.length === 0 || chatId.length === 0) {
        alertError =
          'TELEGRAM_BOT_TOKEN or OPERATOR_CHAT_ID missing in env -- cannot emit watchdog alert';
        process.stderr.write(`[cron/runner-watchdog] ${alertError}\n`);
      } else {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: alertText }),
        });
        if (r.ok) {
          alertEmitted = true;
        } else {
          alertError = `Telegram Bot API HTTP ${r.status}`;
          process.stderr.write(`[cron/runner-watchdog] ${alertError}\n`);
        }
      }
    } catch (e) {
      alertError = e instanceof Error ? e.message : String(e);
      // Constitution section 17: log + return non-throwing 200 with the
      // alertError documented. The route's job is to return its own
      // observation, not crash on the alert path.
      process.stderr.write(`[cron/runner-watchdog] Telegram alert exception: ${alertError}\n`);
    }
  }

  return jsonRes(200, {
    ok: true,
    maxPingedAt: maxPingedAt === null ? null : new Date(maxPingedAt).toISOString(),
    shouldAlert,
    alertEmitted,
    ...(alertError !== undefined ? { alertError } : {}),
    server_time_gmt: new Date().toISOString(),
  });
}
