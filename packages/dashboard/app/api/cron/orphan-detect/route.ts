/**
 * /api/cron/orphan-detect — daily at 04:15 GMT (NFR-004).
 *
 * Finds routine_runs stuck in 'running' status past the threshold (the
 * audit UPDATE failed mid-run, or the work() crashed without re-throwing
 * cleanly). Reconciles by querying the cap-counter and writing a
 * synthetic 'failed' close-out + Telegram alert.
 *
 * Also picks up override_actions rows where success=null (R3-followup
 * orphan recovery from the split-tx flow).
 */

import { validateCronAuth } from '@/lib/cron-auth';

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;
  return new Response(JSON.stringify({ ok: true, todo: 'M5-step-25' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
