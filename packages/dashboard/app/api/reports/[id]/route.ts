/**
 * /api/reports/[id] -- FR-015 AC-015-1.
 *
 * Read one executor_reports row by id, tenant-scoped via session resolution.
 * Hot vs cold (AUDIT_HOT_DAYS) decides whether the response signals
 * `hot: true` (inline-render path) or `hot: false` (cold-archive transparent
 * fetch path). Both branches return a signed Blob URL (1h expiry).
 *
 * Auth: session-required. CSRF not needed (GET).
 *
 * v1.2 FR-025 D3: auth swept to lib/resolve-operator-auth.
 */

import { getExecutorReportById, mintBlobSignedUrl } from '@/lib/reports-read';
import { resolveOperatorAuth } from '@/lib/resolve-operator-auth';

const AUDIT_HOT_DAYS_DEFAULT = 365;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const auth = await resolveOperatorAuth(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: auth.reason }), {
      status: auth.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const tenantId = auth.operator.tenantId;

  const row = await getExecutorReportById(id, tenantId);
  if (row === null) {
    return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const hotDays = parseInt(process.env.AUDIT_HOT_DAYS ?? String(AUDIT_HOT_DAYS_DEFAULT), 10);
  const ageDays = (Date.now() - new Date(row.createdAt).getTime()) / (24 * 3_600_000);
  const hot = ageDays <= hotDays;

  const signedUrl = await mintBlobSignedUrl(row.reportMdBlobUrl ?? '');

  return new Response(
    JSON.stringify({
      ok: true,
      hot,
      pair: row.pair,
      session: row.session,
      summaryMd: row.summaryMd,
      signedUrl,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
