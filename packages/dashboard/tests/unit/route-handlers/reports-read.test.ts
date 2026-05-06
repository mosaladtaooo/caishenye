/**
 * /api/reports/[id] — FR-015 AC-015-1 read-side report fetch.
 *
 * Reads `executor_reports` row by id. If the row is "hot" (created within
 * AUDIT_HOT_DAYS, default 365), returns the inline JSON {markdown, summaryMd}
 * (server reads from Vercel Blob with the BLOB_READ_WRITE_TOKEN — mocked
 * here). If the row is "cold" (older than AUDIT_HOT_DAYS), returns a signed
 * URL to the cold-archive Blob mint (R6 transparent fetch).
 *
 * Auth: session-required. CSRF not needed (GET).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_COOKIE_NAME = '__Secure-authjs.session-token';
const SESSION_VAL = 'sess-abc';

let resolveOperatorSpy: ReturnType<typeof vi.fn>;
let getReportSpy: ReturnType<typeof vi.fn>;
let mintSignedUrlSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resolveOperatorSpy = vi.fn(async (sessionTok: string | undefined) => {
    if (sessionTok === undefined || sessionTok === '') return null;
    return { tenantId: 1, operatorUserId: 42 };
  });
  getReportSpy = vi.fn();
  mintSignedUrlSpy = vi.fn(async () => 'https://blob.vercel.app/signed-url-stub');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importRoute() {
  // FR-025 D3: auth resolver moved to lib/auth-js-session.
  vi.doMock('../../../lib/auth-js-session', () => ({
    resolveOperatorFromSession: resolveOperatorSpy,
  }));
  vi.doMock('../../../lib/override-bind', () => ({
    resolveOperatorFromSession: resolveOperatorSpy,
  }));
  vi.doMock('../../../lib/reports-read', () => ({
    getExecutorReportById: getReportSpy,
    mintBlobSignedUrl: mintSignedUrlSpy,
  }));
  return await import('../../../app/api/reports/[id]/route');
}

function buildReq(opts: { withSession?: boolean }): Request {
  const headers = new Headers();
  if (opts.withSession === true) {
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${SESSION_VAL}`);
  }
  return new Request('https://app.local/api/reports/123', { method: 'GET', headers });
}

describe('GET /api/reports/[id] — auth', () => {
  it('returns 401 without session', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({}), { params: Promise.resolve({ id: '123' }) });
    expect(res.status).toBe(401);
    expect(getReportSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/[id] — happy path (hot)', () => {
  it('returns 200 with inline markdown when report is fresh', async () => {
    getReportSpy = vi.fn(async () => ({
      id: 123,
      pair: 'EUR/USD',
      session: 'EUR',
      summaryMd: 'short summary',
      reportMdBlobUrl: 'https://blob.vercel.app/r/123.md',
      createdAt: new Date(),
      tenantId: 1,
    }));
    mintSignedUrlSpy = vi.fn(async () => 'https://blob.vercel.app/signed-url-hot');
    const route = await importRoute();
    const res = await route.GET(buildReq({ withSession: true }), {
      params: Promise.resolve({ id: '123' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hot: boolean;
      signedUrl: string;
      summaryMd: string;
    };
    expect(body.ok).toBe(true);
    expect(body.hot).toBe(true);
    expect(body.signedUrl).toBe('https://blob.vercel.app/signed-url-hot');
    expect(body.summaryMd).toBe('short summary');
  });
});

describe('GET /api/reports/[id] — cold-archive path', () => {
  it('returns 200 with hot=false when report is older than AUDIT_HOT_DAYS', async () => {
    process.env.AUDIT_HOT_DAYS = '30';
    const oldDate = new Date(Date.now() - 31 * 86_400_000);
    getReportSpy = vi.fn(async () => ({
      id: 123,
      pair: 'EUR/USD',
      session: 'EUR',
      summaryMd: 'old summary',
      reportMdBlobUrl: 'https://blob.vercel.app/r/123.md',
      createdAt: oldDate,
      tenantId: 1,
    }));
    mintSignedUrlSpy = vi.fn(async () => 'https://blob.vercel.app/signed-archive-stub');
    const route = await importRoute();
    const res = await route.GET(buildReq({ withSession: true }), {
      params: Promise.resolve({ id: '123' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hot: boolean; signedUrl: string };
    expect(body.ok).toBe(true);
    expect(body.hot).toBe(false);
    expect(body.signedUrl).toBe('https://blob.vercel.app/signed-archive-stub');
  });
});

describe('GET /api/reports/[id] — not found', () => {
  it('returns 404 when no row matches id', async () => {
    getReportSpy = vi.fn(async () => null);
    const route = await importRoute();
    const res = await route.GET(buildReq({ withSession: true }), {
      params: Promise.resolve({ id: '999' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/reports/[id] — invalid id', () => {
  it('returns 400 when id is not a number', async () => {
    const route = await importRoute();
    const res = await route.GET(buildReq({ withSession: true }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(400);
    expect(getReportSpy).not.toHaveBeenCalled();
  });
});
