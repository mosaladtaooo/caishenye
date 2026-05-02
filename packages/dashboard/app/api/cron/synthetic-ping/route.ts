/**
 * /api/cron/synthetic-ping — every 30 min (FR-005 AC-005-1 fallback).
 *
 * Posts a SYNTHETIC_PING message to TELEGRAM_DEBUG_CHANNEL_ID. The
 * Channels session on the VPS replies (or doesn't); the next
 * channels-health cron run sees the MAX(replied_at) timestamp updated and
 * confirms the session is live. The fallback covers quiet periods where
 * no operator-initiated messages would otherwise update the heartbeat.
 *
 * M4 step 24 wires the live Telegram POST. Scaffold returns OK.
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
