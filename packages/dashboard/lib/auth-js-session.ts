/**
 * auth-js-session -- Auth.js v5 session-cookie resolver.
 *
 * Single-responsibility module: take a session-cookie string and return
 * {tenantId, operatorUserId} OR null. Extracted from lib/override-bind.ts
 * during FR-025 D3 (cookie sweep) so the new lib/resolve-operator-auth.ts
 * helper can call it for the auth-js fallback path WITHOUT pulling in the
 * full override-bind module (which carries MT5 + Telegram + audit-row deps).
 *
 * Behaviour preserved verbatim from the v1.1 override-bind.resolveOperatorFromSession
 * implementation:
 *   - undefined / empty token  -> null (no cookie present)
 *   - AUTH_URL missing in env  -> throws (loud-fail per constitution section 15;
 *     misconfig must NOT silently let unauthenticated traffic through)
 *   - Cookie present but no row -> null
 *   - Cookie present + row     -> { tenantId, operatorUserId }
 *
 * Constitution section 4 multi-tenant: returns the explicit tenantId from
 * the joined users row.
 */

import { getTenantDb } from '@caishen/db/client';
import { eq } from 'drizzle-orm';

export interface ResolvedOperator {
  tenantId: number;
  operatorUserId: number;
}

export async function resolveOperatorFromSession(
  sessionToken: string | undefined,
): Promise<ResolvedOperator | null> {
  if (sessionToken === undefined || sessionToken.length === 0) return null;
  // Live wire-up lands when AUTH_URL is provided post-deploy. Until then
  // we fail closed (loud).
  const authUrl = process.env.AUTH_URL;
  if (authUrl === undefined || authUrl.length === 0) {
    throw new Error(
      'auth-js-session: AUTH_URL missing -- Auth.js session resolution requires it; refusing to authenticate',
    );
  }
  const tenantDb = getTenantDb(1);
  const { sessions, users } = await import('@caishen/db/schema/users');
  const rows = await tenantDb.drizzle
    .select({
      sessionUserId: sessions.userId,
      tenantId: users.tenantId,
      userId: users.id,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sessionToken, sessionToken));
  const row = rows[0];
  if (!row) return null;
  return { tenantId: row.tenantId, operatorUserId: row.userId };
}
