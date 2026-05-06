#!/usr/bin/env bun
/**
 * FR-024 D5 -- VPS-NSSM cron-runner main loop.
 *
 * Operator-managed entry point invoked by NSSM:
 *   AppDirectory=C:\caishen\caishenye\packages\cron-runner
 *   AppParameters=run start  (resolves to bun run scripts/loop.ts)
 *
 * Responsibilities (AC-024-1):
 *   1. Tight setInterval(60_000) loop. Each tick sequentially fetches
 *      /api/cron/fire-due-executors, /api/cron/close-due-sessions, then
 *      /api/cron/health (the inbound liveness ping for AC-024-3).
 *   2. Logs structured JSON via process.stdout.write per R7-a (NOT console.log
 *      -- mirrors the channels loop convention).
 *   3. Maintains per-endpoint consecutive-non-2xx counters for AC-024-8 +
 *      AC-024-9 alerting; emits direct Telegram Bot API alerts on threshold
 *      crossings (out-of-band, NOT through Channels session).
 *
 * Crash policy: NSSM Restart=always covers process-level crash. Inside the
 * loop, every fetch is wrapped in try/catch -- a single failed tick must
 * not bring down the runner; the next tick is the retry. Per constitution
 * section 17 catches log + return error result.
 *
 * Operator-supplied env (loaded via NSSM AppEnvironmentExtra):
 *   - CRON_SECRET           Vercel cron auth bearer
 *   - VERCEL_BASE_URL       e.g. https://caishenv2.vercel.app
 *   - TELEGRAM_BOT_TOKEN    For direct alert path
 *   - OPERATOR_CHAT_ID      Telegram chat id for alerts
 *   - CAISHEN_RUNNER_ID     Unique runner identity (e.g., "vps-windows-1")
 */

import { sendDirectAlert } from '../src/alert';
import { newCounters, recordTickResult } from '../src/counters';
import { runOneTick } from '../src/tick';

const TICK_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const cronSecret = process.env.CRON_SECRET ?? '';
  if (cronSecret.length === 0) {
    throw new Error('cron-runner: CRON_SECRET missing -- refusing to start');
  }
  const baseUrl = process.env.VERCEL_BASE_URL ?? '';
  if (baseUrl.length === 0) {
    throw new Error('cron-runner: VERCEL_BASE_URL missing -- refusing to start');
  }

  const counters = newCounters();
  let tickId = 0;

  process.stdout.write(
    `[cron-runner] starting; tick_interval_ms=${TICK_INTERVAL_MS} base_url=${baseUrl}\n`,
  );

  // Fire one tick immediately, then every 60s.
  const runTick = async (): Promise<void> => {
    tickId += 1;
    try {
      const payload = await runOneTick({ tickId });
      const tickResult = recordTickResult(counters, {
        'fire-due-executors': payload.fire_status,
        'close-due-sessions': payload.close_status,
        'cron/health': payload.health_status,
      });
      for (const alert of tickResult.alertsToEmit) {
        const text =
          alert.kind === 'db_write_failure'
            ? `[caishen] Cron-runner DB-write failures: cron_runner_health unreachable for ${alert.consecutive}+ min`
            : `[caishen] Cron-runner: ${alert.endpoint} returning ${alert.status} for ${alert.consecutive}+ consecutive ticks. Check CRON_SECRET on Vercel-vs-VPS.`;
        const ok = await sendDirectAlert(text);
        if (!ok) {
          process.stderr.write(`[cron-runner] alert send failed: ${text}\n`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[cron-runner] tick ${tickId} threw (continuing): ${msg}\n`);
    }
  };

  // First tick now; subsequent ticks every 60s.
  void runTick();
  setInterval(runTick, TICK_INTERVAL_MS);
}

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  main().catch((err) => {
    process.stderr.write(`[cron-runner] fatal: ${err}\n`);
    process.exit(1);
  });
}
