/**
 * POST /api/auth/operator-logout — clear the operator session cookie.
 *
 * No body, no auth required (clearing your own cookie is always safe).
 */

import { buildClearCookieHeader } from '@/lib/operator-session';

export async function POST(req: Request): Promise<Response> {
  const isSecure = (req.headers.get('x-forwarded-proto') ?? 'https') === 'https';
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': buildClearCookieHeader(isSecure),
    },
  });
}
