/**
 * /api/cron/channels-health — every 5 min (FR-005 AC-005-2).
 *
 * Reads MAX(replied_at) FROM telegram_interactions WHERE tenant_id = $1
 * (R5 — synthetic-ping cron acts as the heartbeat in quiet periods).
 * If the most recent reply is older than the threshold, fires an alert.
 *
 * M4 step 24 wires the live DB query + alert. Scaffold returns OK.
 */

import { validateCronAuth } from '@/lib/cron-auth';

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;
  return new Response(JSON.stringify({ ok: true, todo: 'M4-step-24' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
