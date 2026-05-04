/**
 * POST /api/internal/blob/upload — write executor reports to Vercel Blob.
 *
 * Body: { filename, html, tenantId, pairScheduleId }
 *
 * Server-side prefixes the filename with `executor-reports/${tenantId}/
 * ${YYYY-MM-DD}/` — defence against path traversal. Routine supplies only
 * the basename. Slash characters in the basename → 400.
 */

import { put } from '@vercel/blob';
import { validateInternalAuth } from '@/lib/internal-auth';
import { jsonRes } from '@/lib/internal-route-helpers';

interface UploadBody {
  filename: string;
  html: string;
  tenantId: number;
  pairScheduleId: number;
}

function validateBody(raw: unknown): UploadBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.filename !== 'string' || r.filename.length === 0) return null;
  if (typeof r.html !== 'string') return null;
  if (typeof r.tenantId !== 'number') return null;
  if (typeof r.pairScheduleId !== 'number') return null;
  // Path-traversal guard: basename must not contain / or backslash, no .. segments.
  if (/[/\\]/.test(r.filename) || r.filename.includes('..')) return null;
  return {
    filename: r.filename,
    html: r.html,
    tenantId: r.tenantId,
    pairScheduleId: r.pairScheduleId,
  };
}

function todayGmt(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function POST(req: Request): Promise<Response> {
  const authFail = validateInternalAuth(req);
  if (authFail) return authFail;

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN ?? '';
  if (blobToken.length === 0) {
    return jsonRes(500, {
      error: 'blob/upload: server misconfigured (BLOB_READ_WRITE_TOKEN missing)',
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonRes(400, { error: 'invalid JSON body' });
  }

  const body = validateBody(raw);
  if (!body) {
    return jsonRes(400, {
      error: 'invalid body: require { filename (basename), html, tenantId, pairScheduleId }',
    });
  }

  const path = `executor-reports/${body.tenantId}/${todayGmt()}/${body.filename}`;

  try {
    const result = await put(path, body.html, {
      access: 'public',
      token: blobToken,
      contentType: 'text/html',
    });
    return jsonRes(200, { url: result.url, pathname: result.pathname });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRes(502, { error: `blob/upload: ${msg.slice(0, 256)}` });
  }
}
