/**
 * /api/cron/audit-archive — daily at 03:30 GMT (ADR-006).
 *
 * Archives audit rows older than the configurable retention (default 365
 * days) to Vercel Blob; Postgres rows past the threshold are deleted.
 * The cold-archive recall path lives at /api/archive-fetch.
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
