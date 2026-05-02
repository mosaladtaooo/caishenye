/**
 * FR-005 channels-health cron — DB read/write helpers.
 *
 * Split out so the route handler stays thin + so unit tests can stub the DB
 * surface via `vi.doMock('../../lib/channels-health-cron', ...)`.
 *
 * Three primitives:
 *   - insertChannelsHealthRow: writes the per-cron-cycle audit row
 *   - queryLastUnhealthyTransition: finds the most recent moment liveness
 *     flipped from healthy=true to healthy=false (used to compute "have we
 *     been down >10 min?")
 *   - isMutedAlarm: ADR-009 mute marker check
 */

import { getTenantDb } from '@caishen/db/client';
import { channelsHealth } from '@caishen/db/schema/channels-health';
import { and, desc, eq, gt, sql } from 'drizzle-orm';

export interface InsertChannelsHealthArg {
  tenantId: number;
  checkedAt: Date;
  healthyBool: boolean;
  latencyMs: number | null;
  error: string | null;
}

/**
 * Insert one channels_health row per cron tick. Always inserts, even when
 * the upstream fetch failed — operator visibility into "couldn't reach VPS"
 * is the whole point of FR-005.
 */
export async function insertChannelsHealthRow(arg: InsertChannelsHealthArg): Promise<number> {
  const tenantDb = getTenantDb(arg.tenantId);
  const inserted = await tenantDb.drizzle
    .insert(channelsHealth)
    .values({
      tenantId: arg.tenantId,
      checkedAt: arg.checkedAt,
      healthyBool: arg.healthyBool,
      latencyMs: arg.latencyMs,
      error: arg.error,
    })
    .returning({ id: channelsHealth.id });
  const row = inserted[0];
  if (!row) {
    throw new Error('channels-health-cron: insert returned no row');
  }
  return row.id;
}

/**
 * Query the moment we transitioned from healthy=true to healthy=false.
 *
 * Logic: read the most recent run of consecutive healthy=false rows and
 * return the checked_at of the OLDEST of that run. If the most recent row
 * is healthy=true, returns null (we're not currently unhealthy). If the
 * most recent row is unhealthy AND there's no preceding healthy row at all,
 * returns null (we've never been healthy — first-deploy scenario; don't
 * alert until a healthy row exists, otherwise startup spam).
 */
export async function queryLastUnhealthyTransition(tenantId: number): Promise<Date | null> {
  const tenantDb = getTenantDb(tenantId);
  // Two recent rows are enough: most recent unhealthy run's start.
  const recentRows = await tenantDb.drizzle
    .select({
      checkedAt: channelsHealth.checkedAt,
      healthyBool: channelsHealth.healthyBool,
    })
    .from(channelsHealth)
    .where(eq(channelsHealth.tenantId, tenantId))
    .orderBy(desc(channelsHealth.checkedAt))
    .limit(50); // 50×5min = 4h window — enough to find any transition.

  // If no rows at all OR most recent is healthy → not currently unhealthy.
  if (recentRows.length === 0) return null;
  const head = recentRows[0];
  if (!head || head.healthyBool === true) return null;

  // Walk forward in time (rows are DESC by checkedAt; we walk top-to-bottom)
  // until we find the first healthy=true OR run out. The transition is the
  // checked_at of the LAST unhealthy in that run (the oldest unhealthy in
  // the current down-period).
  let oldestUnhealthy = head.checkedAt;
  for (const row of recentRows) {
    if (row.healthyBool === true) break;
    oldestUnhealthy = row.checkedAt;
  }
  return oldestUnhealthy;
}

/**
 * ADR-009 mute marker. Returns true if any channels_health row has
 * mute_alarm_until > now() (operator silenced alerts during scheduled
 * maintenance).
 */
export async function isMutedAlarm(tenantId: number, now: Date): Promise<boolean> {
  const tenantDb = getTenantDb(tenantId);
  const rows = await tenantDb.drizzle
    .select({ exists: sql<number>`1` })
    .from(channelsHealth)
    .where(and(eq(channelsHealth.tenantId, tenantId), gt(channelsHealth.muteAlarmUntil, now)))
    .limit(1);
  return rows.length > 0;
}
