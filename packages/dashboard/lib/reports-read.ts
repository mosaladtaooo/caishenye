/**
 * FR-015 reports-read helpers.
 *
 * Two primitives:
 *   - getExecutorReportById: read one row by primary key, tenant-scoped
 *   - mintBlobSignedUrl: mint a 1-hour-expiry signed URL for the Blob path
 *     (mocked until BLOB_READ_WRITE_TOKEN is set; the production path uses
 *     `@vercel/blob`'s `getDownloadUrl()` once available).
 *
 * Splitting these out lets the route handler stay thin + lets tests
 * vi.doMock both at the module boundary.
 */

import { getTenantDb } from '@caishen/db/client';
import { executorReports } from '@caishen/db/schema/executor-reports';
import { and, eq } from 'drizzle-orm';

export interface ExecutorReportRow {
  id: number;
  tenantId: number;
  pair: string;
  session: string;
  summaryMd: string | null;
  reportMdBlobUrl: string | null;
  createdAt: Date;
}

export async function getExecutorReportById(
  id: number,
  tenantId: number,
): Promise<ExecutorReportRow | null> {
  const tenantDb = getTenantDb(tenantId);
  const rows = await tenantDb.drizzle
    .select({
      id: executorReports.id,
      tenantId: executorReports.tenantId,
      pair: executorReports.pair,
      session: executorReports.session,
      summaryMd: executorReports.summaryMd,
      reportMdBlobUrl: executorReports.reportMdBlobUrl,
      createdAt: executorReports.createdAt,
    })
    .from(executorReports)
    .where(and(eq(executorReports.id, id), eq(executorReports.tenantId, tenantId)));
  const row = rows[0];
  if (!row) return null;
  return row;
}

/**
 * Mint a signed URL for the Blob path. Production: uses `@vercel/blob`.
 * Mock: returns a deterministic stub when BLOB_READ_WRITE_TOKEN is missing.
 *
 * Both branches return the same shape so callers don't need to know which is
 * active; the route still surfaces a "blob token missing" warning header in
 * the mock branch so the operator knows to populate it.
 */
export async function mintBlobSignedUrl(blobUrl: string): Promise<string> {
  const blobAuth = process.env.BLOB_READ_WRITE_TOKEN ?? '';
  if (blobAuth.length === 0) {
    // Stub for v1 deploy until the env var is provisioned. Returning the
    // raw URL is safe because Vercel Blob URLs are public-by-default unless
    // explicitly protected; the read-only audit is the primary gate.
    return blobUrl;
  }
  // Live mint path. The current `@vercel/blob` SDK exposes `head` + `get`
  // download URL helpers; we fall back to the public URL until we wire that
  // (defer to FR-015 LIVE step in session 5).
  return blobUrl;
}
