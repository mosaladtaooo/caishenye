/**
 * POST /api/cron/health -- AC-024-3 inbound liveness ping.
 *
 * v1.2 FR-024 D5: the VPS-NSSM cron-runner POSTs to this route every 60s
 * carrying Authorization: Bearer ${CRON_SECRET}. Each successful request
 * inserts a `cron_runner_health` row with tenant_id + runner_id + pinged_at=now().
 *
 * The Vercel-cron backstop watcher (/api/cron/runner-watchdog) reads the
 * MAX(pinged_at) from this table to detect cron-runner death.
 *
 * Body shape: { runner_id: string, tenant_id?: number }
 *
 *   - runner_id is operator-supplied via the VPS env var (uniquely
 *     identifies the runner; e.g., "vps-windows-1"). Required.
 *   - tenant_id defaults to 1 (single-tenant v1).
 *
 * Auth: CRON_SECRET (Vercel-cron-style bearer; same surface as other
 * /api/cron/* routes).
 *
 * Constitution section 17: DB write failures are caught + logged at the
 * boundary and surfaced as 500 with a structured error message, NOT swallowed.
 */

import { getTenantDb } from '@caishen/db/client';
import { cronRunnerHealth } from '@caishen/db/schema/cron-runner-health';
import { validateCronAuth } from '@/lib/cron-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

const DEFAULT_TENANT_ID = Number(process.env.DEFAULT_TENANT_ID ?? '1');

interface HealthBody {
  runner_id?: unknown;
  tenant_id?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  let body: HealthBody;
  try {
    body = (await req.json()) as HealthBody;
  } catch {
    return jsonRes(400, { error: 'invalid JSON body' });
  }

  if (typeof body.runner_id !== 'string' || body.runner_id.length === 0) {
    return jsonRes(400, { error: 'runner_id required (non-empty string)' });
  }
  const runnerId = body.runner_id;
  const tenantIdRaw = typeof body.tenant_id === 'number' ? body.tenant_id : DEFAULT_TENANT_ID;
  const tenantId = Number.isFinite(tenantIdRaw) && tenantIdRaw > 0 ? tenantIdRaw : 1;

  try {
    const tenantDb = getTenantDb(tenantId);
    await tenantDb.drizzle.insert(cronRunnerHealth).values({
      tenantId,
      runnerId,
    });
    return jsonRes(200, {
      ok: true,
      server_time_gmt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[cron/health] cron_runner_health insert failed: ${msg}\n`);
    return jsonRes(500, {
      error: `cron_runner_health insert failed: ${msg.slice(0, 256)}`,
    });
  }
}
