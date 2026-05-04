/**
 * POST /api/internal/blob/upload — write executor reports to Vercel Blob.
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

  it('returns 500 when BLOB_READ_WRITE_TOKEN missing', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(500);
    expect(putSpy).not.toHaveBeenCalled();
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
  it('uploads with the prefixed path and returns the URL', async () => {
    putSpy.mockResolvedValue({
      url: 'https://blob.vercel-storage.com/executor-reports/1/2026-05-04/report-5.html-abc',
      pathname: 'executor-reports/1/2026-05-04/report-5.html-abc',
      contentType: 'text/html',
      contentDisposition: 'inline',
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
    expect(opts.token).toBe(blobToken);
    expect(opts.contentType).toBe('text/html');
    const responseBody = (await res.json()) as { url: string };
    expect(responseBody.url).toMatch(/blob\.vercel-storage\.com/);
  });
});

describe('POST /api/internal/blob/upload — upstream errors', () => {
  it('returns 502 when @vercel/blob put throws', async () => {
    putSpy.mockRejectedValue(new Error('blob: upload rejected'));
    const route = await importRoute();
    const res = await route.POST(
      buildReq(
        { filename: 'r.html', html: '<p/>', tenantId: 1, pairScheduleId: 5 },
        `Bearer ${fixtureBearer}`,
      ),
    );
    expect(res.status).toBe(502);
  });
});
