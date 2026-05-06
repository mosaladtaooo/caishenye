/**
 * POST /api/internal/blob/upload — write executor reports to Vercel Blob.
 *
 * Body: { filename, html, tenantId, pairScheduleId }
 *
 * Server-side prefixes the filename with `executor-reports/${tenantId}/
 * ${YYYY-MM-DD}/` — defence against path traversal. Routine supplies only
 * the basename. Slash characters in the basename → 400.
 *
 * v1.2 (FR-026 / KI-008) error matrix:
 *   - missing INTERNAL_API_TOKEN env       → 500 (constitution §15 LOUD)
 *   - missing bearer / wrong bearer        → 401
 *   - invalid JSON / shape / path-traversal → 400
 *   - missing BLOB_READ_WRITE_TOKEN env    → 503 (was 500 in v1.1; see
 *     contract.md AC-026-2 — the deliberate v1.2 wire-shape change. 503
 *     is correct because the dependency is unavailable, not because the
 *     server itself is broken)
 *   - body > 4_500_000 bytes               → 413 BEFORE put() (Vercel
 *     functions body limit per @vercel/blob docs; client should switch
 *     to multipart/client-upload)
 *   - upstream throws with 401 hint        → 502 with rotated-token
 *     guidance ("re-pull via 'vercel env pull'")
 *   - upstream throws otherwise            → 502 with structured
 *     upstream_error field for log traceability
 *   - happy path                           → 200 with {url, pathname, size}
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

/** Vercel Functions body-size limit per @vercel/blob docs. */
const MAX_BODY_BYTES = 4_500_000;

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

/**
 * Detect whether an upstream error from @vercel/blob's put() represents a
 * 401 Unauthorized (the "BLOB_READ_WRITE_TOKEN was rotated server-side
 * without local update" failure mode per EC-026-2). The library throws
 * either a vanilla Error whose message contains "401" / "Unauthorized",
 * or a BlobError with a `.status` field. Match either.
 */
function isUpstream401(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const candidate = e as { status?: unknown; message?: unknown };
  if (typeof candidate.status === 'number' && candidate.status === 401) return true;
  if (typeof candidate.message === 'string') {
    if (/\b401\b/.test(candidate.message)) return true;
    if (/Unauthorized/i.test(candidate.message)) return true;
  }
  return false;
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
    return jsonRes(400, {
      error: 'invalid body: require { filename (basename), html, tenantId, pairScheduleId }',
    });
  }

  // EC-026-1 oversize guard — bytewise length, NOT char count, so multibyte
  // UTF-8 still maps to the wire body Vercel actually receives.
  const htmlByteLength = Buffer.byteLength(body.html, 'utf8');
  if (htmlByteLength > MAX_BODY_BYTES) {
    return jsonRes(413, {
      error: 'Payload Too Large',
      detail: `html body is ${htmlByteLength} bytes; maximum is ${MAX_BODY_BYTES} (Vercel Functions body limit)`,
    });
  }

  // AC-026-2 (b) wire-shape change: missing token → 503 (NOT 500). The
  // dependency is unavailable; the function itself is fine.
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN ?? '';
  if (blobToken.length === 0) {
    return jsonRes(503, {
      error: 'BLOB_READ_WRITE_TOKEN missing — re-pull via `vercel env pull`',
    });
  }

  const path = `executor-reports/${body.tenantId}/${todayGmt()}/${body.filename}`;

  try {
    const result = await put(path, body.html, {
      access: 'public',
      // AC-026-1 (a): explicit token from env on every put() call (not
      // relying on @vercel/blob's implicit env pickup so test-time mock
      // assertions can verify exact token plumb-through).
      token: blobToken,
      contentType: 'text/html',
    });
    // `size` reports the bytes we just uploaded. @vercel/blob's `PutBlobResult`
    // exposes `url / downloadUrl / pathname / contentType / contentDisposition /
    // etag` only — it does NOT echo a content-length field. We already computed
    // `htmlByteLength` for the EC-026-1 oversize guard above, so reuse it as the
    // authoritative byte count (it is the wire-body length the route accepted).
    return jsonRes(200, {
      url: result.url,
      pathname: result.pathname,
      size: htmlByteLength,
    });
  } catch (e) {
    const upstreamMessage = e instanceof Error ? e.message : String(e);
    // Constitution §17 — log the boundary error before returning. The route
    // itself returns a structured 502 (caller-actionable); operator triage
    // path is via Vercel logs.
    process.stderr.write(`[blob/upload] upstream error: ${upstreamMessage}\n`);

    // EC-026-2 — token rotated server-side: surface specific guidance.
    if (isUpstream401(e)) {
      return jsonRes(502, {
        upstream_error:
          "Token rejected by Blob backend — re-pull via 'vercel env pull' and redeploy",
      });
    }

    // AC-026-2 (c) — generic upstream failure: structured upstream_error.
    return jsonRes(502, {
      upstream_error: upstreamMessage.slice(0, 256),
    });
  }
}
