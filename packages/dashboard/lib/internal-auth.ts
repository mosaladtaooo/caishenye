/**
 * Internal-API bearer validator for /api/internal/* routes (ADR-012 proxy
 * pattern).
 *
 * Every Routine-side curl call carries `Authorization: Bearer
 * ${INTERNAL_API_TOKEN}`; this helper compares timing-safe against
 * process.env.INTERNAL_API_TOKEN.
 *
 * Returns null on success, a Response on failure (caller returns it as-is).
 *
 * Behaviour matrix:
 *   - INTERNAL_API_TOKEN env missing/empty → 500 (constitution §15 LOUD)
 *   - Authorization header missing → 401
 *   - Header lacks "Bearer " prefix (or wrong case) → 401
 *   - Bearer length differs → 401 (early return; avoids a false-equal
 *     timing oracle on length)
 *   - Bearer differs by content → 401 (timing-safe via node:crypto)
 *   - Bearer matches → null (success)
 *
 * Mirrors the shape of cron-auth.ts. Pinned to uppercase "Bearer " for
 * consistency; if we later loosen, the matching test inverts.
 */

import { timingSafeEqual } from 'node:crypto';

const SCHEME_PREFIX = 'Bearer ';

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function validateInternalAuth(req: Request): Response | null {
  const expected = process.env.INTERNAL_API_TOKEN ?? '';
  if (expected.length === 0) {
    return jsonError(500, 'server misconfigured: INTERNAL_API_TOKEN missing');
  }

  const auth = req.headers.get('authorization') ?? '';
  if (auth.length === 0) {
    return jsonError(401, 'unauthorized: missing bearer');
  }
  if (!auth.startsWith(SCHEME_PREFIX)) {
    return jsonError(401, 'unauthorized: missing or invalid scheme');
  }

  const supplied = auth.slice(SCHEME_PREFIX.length);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return jsonError(401, 'unauthorized: bearer length mismatch');
  }
  if (!timingSafeEqual(a, b)) {
    return jsonError(401, 'unauthorized: bearer mismatch');
  }
  return null;
}
