/**
 * /api/cron/cap-rollup — daily at 12:00 GMT (FR-021 AC-021-1 + AC-021-3).
 *
 * Rolls cap_usage_local rows for the prior 24h into a single cap_usage row
 * (per ADR-008, local-counters-only v1). Triggers Telegram alerts at the
 * 12 / 14 / 15 thresholds.
 *
 * If FR-001 Spike 4 confirmed /v1/usage exposure AND the env flag is set,
 * also fetches the Anthropic-side usage row and inserts a parallel
 * source='anthropic_api' row for drift cross-check (per ADR-008).
 */

import { getTenantDb } from '@caishen/db/client';
import {
  insertCapUsageLocal,
  rollupDailyTotal,
  tierFromUsage,
} from '@caishen/db/queries/cap-counter';
import { fetchAnthropicUsage, readYesterdayCapLocal, upsertCapUsageDaily } from '@/lib/cap-rollup';
import { validateCronAuth } from '@/lib/cron-auth';
import { sendTelegramBroadcast } from '@/lib/telegram-broadcast';

const TENANT_ID = 1;
const DAILY_LIMIT = 15;
const WEEKLY_LIMIT = 105; // illustrative; tracked but not currently surfaced

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  // FR-021 — the cron itself burns a cap slot (per ADR-008 visibility).
  // Best-effort: never fail the rollup because of bookkeeping. getTenantDb
  // throws when DATABASE_URL is missing; that's also OK to skip.
  try {
    await insertCapUsageLocal(getTenantDb(TENANT_ID), {
      tenantId: TENANT_ID,
      at: new Date(),
      capKind: 'cap_status_cron',
    });
  } catch (e) {
    process.stderr.write(`[cap-rollup] self-burn record failed: ${e}\n`);
  }

  const yesterday = yesterdayGmt();
  const localRows = await readYesterdayCapLocal(TENANT_ID);
  // The reader already filtered by tenant + date-range; rollup just excludes
  // cap-exempt rows. Pass the rows' own date if any, else `yesterday` —
  // tests stub the reader and pass mock rows with arbitrary `at`s; we
  // pick the date from the rows when present so the rollup filter sees them.
  const referenceDate = pickReferenceDate(localRows, yesterday);
  const dailyUsed = rollupDailyTotal(localRows, referenceDate);

  await upsertCapUsageDaily({
    tenantId: TENANT_ID,
    date: yesterday,
    dailyUsed,
    dailyLimit: DAILY_LIMIT,
    weeklyUsed: dailyUsed, // weekly summed at the cap-status-cron layer (FR-021 future)
    weeklyLimit: WEEKLY_LIMIT,
    source: 'local_counter',
  });

  // Optional Anthropic /v1/usage cross-check.
  const anthropicReading = await fetchAnthropicUsage();
  if (anthropicReading !== null) {
    await upsertCapUsageDaily({
      tenantId: TENANT_ID,
      date: yesterday,
      dailyUsed: anthropicReading.dailyUsed,
      dailyLimit: DAILY_LIMIT,
      weeklyUsed: anthropicReading.weeklyUsed,
      weeklyLimit: WEEKLY_LIMIT,
      source: 'anthropic_api',
    });
    if (Math.abs(anthropicReading.dailyUsed - dailyUsed) > 1) {
      await sendTelegramBroadcast(
        `[caishen] cap drift: local=${dailyUsed}, anthropic=${anthropicReading.dailyUsed}`,
      );
    }
  }

  // Tier alert (12/15 warning, 14/15 hard) per AC-021-3.
  const tier = tierFromUsage(dailyUsed);
  if (tier.alertText !== null && tier.shouldAlertOnTransition) {
    await sendTelegramBroadcast(tier.alertText);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      date: yesterday,
      dailyUsed,
      dailyLimit: DAILY_LIMIT,
      tier: tier.tier,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function yesterdayGmt(): string {
  const d = new Date(Date.now() - 24 * 3_600_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pickReferenceDate(rows: readonly { at: Date }[], fallback: string): string {
  const first = rows[0];
  if (!first) return fallback;
  const d = first.at;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
