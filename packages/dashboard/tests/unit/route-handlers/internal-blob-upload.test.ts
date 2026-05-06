/**
 * POST /api/internal/blob/upload — write executor reports to Vercel Blob.
 *
 * v1.2 (FR-026 / KI-008) extensions:
 *  - missing BLOB_READ_WRITE_TOKEN  → 503 (was 500 in v1.1; deliberate wire-shape change)
 *  - oversize body (>4_500_000)     → 413 BEFORE put() (functions body limit)
 *  - upstream throws with 401 hint  → 502 with structured upstream_error
 *  - generic upstream throw         → 502 with structured upstream_error
 *  - happy path                     → 200 with {url, pathname, size}
 *
 * Body: { filename: string, html: string, tenantId: number, pairScheduleId: number }.
 * filename is server-side prefixed with `executor-reports/${tenantId}/${YYYY-MM-DD}/`
 * (defence against path traversal — Routine supplies only the basename).
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureBearer = randomBytes(32).toString('hex');
const blobToken = `vercel_blob_rw_${randomBytes(16).toString('hex')}`;

let putSpy: ReturnType<typeof vi.fn>;
let originalToken: string | undefined;
let originalBlobToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.INTERNAL_API_TOKEN;
  originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.INTERNAL_API_TOKEN = fixtureBearer;
  process.env.BLOB_READ_WRITE_TOKEN = blobToken;
  putSpy = vi.fn();
  vi.resetModules();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
  else process.env.INTERNAL_API_TOKEN = originalToken;
  if (originalBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
  vi.restoreAllMocks();
});

async function importRoute() {
  vi.doMock('@vercel/blob', () => ({
    put: putSpy,
  }));
  return await import('../../../app/api/internal/blob/upload/route');
}

function buildReq(body: unknown, headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set('Authorization', headerValue);
  headers.set('content-type', 'application/json');
  return new Request('https://app.local/api/internal/blob/upload', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/blob/upload — auth', () => {
  it('returns 401 without bearer', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 }),
    );
    expect(res.status).toBe(401);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when INTERNAL_API_TOKEN missing', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(500);
  });

  it('returns 503 when BLOB_READ_WRITE_TOKEN missing (FR-026 AC-026-2 — wire-shape change from v1.1 500)', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(503);
    expect(putSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/BLOB_READ_WRITE_TOKEN missing/);
  });
});

describe('POST /api/internal/blob/upload — body validation', () => {
  it('rejects missing filename with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ html: '<p/>', tenantId: 1, pairScheduleId: 5 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing html with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ filename: 'r.html', tenantId: 1, pairScheduleId: 5 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing tenantId with 400', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq({ filename: 'r.html', html: '<p/>', pairScheduleId: 5 }, `Bearer ${fixtureBearer}`),
    );
    expect(res.status).toBe(400);
  });

  it('rejects path-traversal in filename with 400 (../)', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: '../etc/passwd', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('rejects path-traversal in filename with 400 (slash present)', async () => {
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'subdir/r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/internal/blob/upload — happy path', () => {
  it('uploads with the prefixed path and returns the URL + size (AC-026-2 a)', async () => {
    // PutBlobResult shape per @vercel/blob v2 type defs: url + downloadUrl +
    // pathname + contentType + contentDisposition + etag. NO contentLength
    // field — the route surfaces the request body byte length itself (see
    // route.ts AC-026-2 happy-path comment + tsc-cleanup commit).
    putSpy.mockResolvedValue({
      url: 'https://blob.vercel-storage.com/executor-reports/1/2026-05-04/report-5.html-abc',
      downloadUrl:
        'https://blob.vercel-storage.com/executor-reports/1/2026-05-04/report-5.html-abc?download=1',
      pathname: 'executor-reports/1/2026-05-04/report-5.html-abc',
      contentType: 'text/html',
      contentDisposition: 'inline',
      etag: '"abc123"',
    });
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'report-5.html', html: '<p>hi</p>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [path, body, opts] = putSpy.mock.calls[0] as [
      string,
      string,
      { access: string; token: string; contentType: string },
    ];
    expect(path).toMatch(/^executor-reports\/1\/\d{4}-\d{2}-\d{2}\/report-5\.html$/);
    expect(body).toBe('<p>hi</p>');
    expect(opts.access).toBe('public');
    // AC-026-1 (a): explicit token from env on every put() call.
    expect(opts.token).toBe(blobToken);
    expect(opts.contentType).toBe('text/html');
    const responseBody = (await res.json()) as { url: string; pathname: string; size: number };
    expect(responseBody.url).toMatch(/blob\.vercel-storage\.com/);
    expect(responseBody.pathname).toBe('executor-reports/1/2026-05-04/report-5.html-abc');
    // `size` is the exact byte length of the request body we sent: '<p>hi</p>'
    // is 9 ASCII bytes. The route reuses the EC-026-1 oversize-guard byte count.
    expect(responseBody.size).toBe(Buffer.byteLength('<p>hi</p>', 'utf8'));
  });
});

describe('POST /api/internal/blob/upload — oversize (EC-026-1)', () => {
  it('returns 413 BEFORE put() when html exceeds 4_500_000 bytes', async () => {
    const route = await importRoute();
    // 4.5MB + 1 byte payload — Vercel functions body limit per @vercel/blob docs.
    const oversize = 'x'.repeat(4_500_001);
    const res = await route.POST(
      buildReq(
        { filename: 'big.html', html: oversize, tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(413);
    expect(putSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Payload Too Large/);
  });
});

describe('POST /api/internal/blob/upload — upstream errors', () => {
  it('returns 502 with structured upstream_error when @vercel/blob put throws generic error (AC-026-2 c)', async () => {
    putSpy.mockRejectedValue(new Error('blob: upload rejected'));
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { upstream_error: string };
    expect(body.upstream_error).toContain('blob: upload rejected');
  });

  it('returns 502 with rotated-token guidance when upstream throws 401 Unauthorized (EC-026-2)', async () => {
    putSpy.mockRejectedValue(new Error('401 Unauthorized'));
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { upstream_error: string };
    expect(body.upstream_error).toMatch(/Token rejected by Blob backend/);
    expect(body.upstream_error).toMatch(/vercel env pull/);
  });

  it('returns 502 with rotated-token guidance when upstream throws object with status=401 (EC-026-2 alt)', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    putSpy.mockRejectedValue(err);
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { upstream_error: string };
    expect(body.upstream_error).toMatch(/Token rejected by Blob backend/);
  });
});
