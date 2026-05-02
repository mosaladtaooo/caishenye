/**
 * /api/cron/cap-rollup — daily at 12:00 GMT (FR-021 AC-021-1).
 *
 * Rolls cap_usage_local rows for the prior 24h into a single cap_usage row
 * (per ADR-008, local-counters-only). Triggers Telegram alert tiers if
 * daily_used breaches 12 / 14 / 15 thresholds.
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
