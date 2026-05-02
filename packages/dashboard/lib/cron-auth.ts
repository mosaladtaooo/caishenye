/**
 * Cron-secret validator. Every /api/cron/* handler runs this BEFORE doing
 * any work; Vercel's cron infra hits the route with `Authorization: Bearer
 * <CRON_SECRET>`, so we verify the bearer matches process.env.CRON_SECRET.
 *
 * Returns null on success, a 401 Response on failure (caller returns it).
 */

import { timingSafeEqual } from 'node:crypto';

export function validateCronAuth(req: Request): Response | null {
  const expected = process.env.CRON_SECRET ?? '';
  if (expected.length === 0) {
    return new Response(JSON.stringify({ error: 'server misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  const auth = req.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) {
    return new Response(JSON.stringify({ error: 'cron auth missing' }), { status: 401 });
  }
  const supplied = auth.slice(prefix.length);
  // Timing-safe compare; padding to equal length avoids the early-out shortcut.
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return new Response(JSON.stringify({ error: 'cron auth mismatch' }), { status: 401 });
  }
  if (!timingSafeEqual(a, b)) {
    return new Response(JSON.stringify({ error: 'cron auth mismatch' }), { status: 401 });
  }
  return null;
}
