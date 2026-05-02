/**
 * GET /api/history/archive/[month] — FR-015 ADR-006 cold-archive recall.
 *
 * Mints a signed URL pointing to the monthly archive in Vercel Blob. The
 * audit-archive cron writes one tarball per (tenant, month) under
 * `archive/<tenantId>/<YYYY-MM>.tar.gz`; the path here is the lookup
 * surface.
 *
 * Auth: session-required. CSRF not needed (GET).
 *
 * Live blob mint (BLOB_READ_WRITE_TOKEN) is deferred to session 5; this
 * route returns the deterministic stub URL until then so the dashboard
 * History page can wire its cold-archive link without runtime credentials.
 */

import { resolveOperatorFromSession } from '@/lib/override-bind';
import { mintBlobSignedUrl } from '@/lib/reports-read';

const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];
const MONTH_REGEX = /^\d{4}-\d{2}$/;

interface RouteContext {
  params: Promise<{ month: string }>;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { month } = await ctx.params;
  if (!MONTH_REGEX.test(month)) {
    return jsonRes(400, { ok: false, error: 'invalid month format; expected YYYY-MM' });
  }

  let resolved: { tenantId: number } | null;
  try {
    resolved = await resolveOperatorFromSession(readSessionCookie(req));
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    return jsonRes(401, { ok: false, error: 'unauthorized' });
  }

  const blobPath = `archive/${resolved.tenantId}/${month}.tar.gz`;
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

function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie');
  if (raw === null) return undefined;
  const parts = raw.split(';').map((p) => p.trim());
  for (const name of SESSION_COOKIE_NAMES) {
    const match = parts.find((p) => p.startsWith(`${name}=`));
    if (match !== undefined) return match.slice(name.length + 1);
  }
  return undefined;
}
