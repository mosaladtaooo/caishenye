/**
 * GET /api/history/archive/[month] -- FR-015 ADR-006 cold-archive recall.
 *
 * Mints a signed URL pointing to the monthly archive in Vercel Blob. The
 * audit-archive cron writes one tarball per (tenant, month) under
 * `archive/<tenantId>/<YYYY-MM>.tar.gz`; the path here is the lookup
 * surface.
 *
 * Auth: session-required. CSRF not needed (GET).
 *
 * v1.2 FR-025 D3: auth swept to lib/resolve-operator-auth.
 */

import { mintBlobSignedUrl } from '@/lib/reports-read';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

const MONTH_REGEX = /^\d{4}-\d{2}$/;

interface RouteContext {
  params: Promise<{ month: string }>;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { month } = await ctx.params;
  if (!MONTH_REGEX.test(month)) {
    return jsonRes(400, { ok: false, error: 'invalid month format; expected YYYY-MM' });
  }

  const auth = await resolveOperatorAuth(req);
  if (!auth.ok) {
    return jsonRes(auth.status, { ok: false, error: auth.reason });
  }
  const tenantId = auth.operator.tenantId;

  const blobPath = `archive/${tenantId}/${month}.tar.gz`;
  const signedUrl = await mintBlobSignedUrl(`https://blob.vercel.app/${blobPath}`);

  return jsonRes(200, {
    ok: true,
    month,
    blobPath,
    signedUrl,
  });
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
