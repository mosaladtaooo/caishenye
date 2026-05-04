/**
 * POST /api/internal/postgres/query — named-query allowlist proxy.
 *
 * Body: { name: <allowlisted>, params: object }.
 *
 * No raw SQL. Every supported operation is implemented as a strongly-typed
 * function in lib/internal-postgres-queries.ts (the named-query allowlist).
 *
 * Tenant scoping: params.tenantId MUST equal DEFAULT_TENANT_ID env (1 in
 * v1). Adding a second tenant later means swapping this for token-derived
 * resolution, but for v1 the hard-pin is simpler and audit-clear.
 */

import { validateInternalAuth } from '@/lib/internal-auth';
import { KNOWN_QUERY_NAMES, runNamedQuery } from '@/lib/internal-postgres-queries';
import { jsonRes } from '@/lib/internal-route-helpers';

interface QueryBody {
  name: string;
  params: Record<string, unknown>;
}

function validateBody(raw: unknown): QueryBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  if (!r.params || typeof r.params !== 'object') return null;
  return { name: r.name, params: r.params as Record<string, unknown> };
}

function defaultTenantId(): number {
  const raw = process.env.DEFAULT_TENANT_ID ?? '1';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export async function POST(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRes(400, { error: 'invalid JSON body' });
  }

  const body = validateBody(raw);
  if (!body) {
    return jsonRes(400, { error: 'invalid body: require { name: string, params: object }' });
  }

  if (!KNOWN_QUERY_NAMES.includes(body.name)) {
    return jsonRes(400, {
      error: `unknown query name "${body.name}" — must be one of ${KNOWN_QUERY_NAMES.join(',')}`,
    });
  }

  if (typeof body.params.tenantId !== 'number') {
    return jsonRes(400, { error: 'params.tenantId required (number)' });
  }

  const expected = defaultTenantId();
  if (body.params.tenantId !== expected) {
    return jsonRes(403, {
      error: `tenantId ${body.params.tenantId} not authorised — expected ${expected}`,
    });
  }

  try {
    const result = await runNamedQuery({ name: body.name, params: body.params });
    return jsonRes(200, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(500, { error: `postgres/query: ${msg.slice(0, 256)}` });
  }
}
