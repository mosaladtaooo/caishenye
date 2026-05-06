/**
 * AC-023-2 + AC-023-6 -- WebAuthn register options + verify route tests.
 *
 * Covers the full register cycle:
 *   POST /api/auth/webauthn/register-options   -> options + challenge insert
 *   POST /api/auth/webauthn/register-verify    -> credential row insert + cookie mint
 *
 * The SimpleWebAuthn server lib is mocked via vi.doMock; tests assert SHAPE
 * (column-by-column equality on the DB inserts) and the mintOperatorCookie
 * boundary (Set-Cookie header presence + caishen-operator-session prefix).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalAuthSecret: string | undefined;
let originalAuthUrl: string | undefined;
let originalRpIdProd: string | undefined;
let originalVercelEnv: string | undefined;
let originalDashboardOrigin: string | undefined;

let webauthnGenerateRegOptionsSpy: ReturnType<typeof vi.fn>;
let webauthnVerifyRegSpy: ReturnType<typeof vi.fn>;

let challengesInsertSpy: ReturnType<typeof vi.fn>;
let challengesUpdateSpy: ReturnType<typeof vi.fn>;
let challengesSelectFirst: ReturnType<typeof vi.fn>;
let credentialsInsertSpy: ReturnType<typeof vi.fn>;
let credentialsSelectAll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalAuthSecret = process.env.AUTH_SECRET;
  originalAuthUrl = process.env.AUTH_URL;
  originalRpIdProd = process.env.WEBAUTHN_RP_ID_PROD;
  originalVercelEnv = process.env.VERCEL_ENV;
  originalDashboardOrigin = process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN;

  // Use a 32-byte secret so AUTH_SECRET passes mintOperatorCookie's check.
  process.env.AUTH_SECRET = 'a'.repeat(64);
  process.env.AUTH_URL = 'https://test.local';
  process.env.WEBAUTHN_RP_ID_PROD = 'caishenv2.vercel.app';
  process.env.VERCEL_ENV = 'production';
  process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN = 'https://caishenv2.vercel.app';

  webauthnGenerateRegOptionsSpy = vi.fn();
  webauthnVerifyRegSpy = vi.fn();

  challengesInsertSpy = vi.fn();
  challengesUpdateSpy = vi.fn();
  challengesSelectFirst = vi.fn();
  credentialsInsertSpy = vi.fn();
  credentialsSelectAll = vi.fn();

  vi.resetModules();
});

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
  if (originalRpIdProd === undefined) delete process.env.WEBAUTHN_RP_ID_PROD;
  else process.env.WEBAUTHN_RP_ID_PROD = originalRpIdProd;
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalDashboardOrigin === undefined) delete process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN;
  else process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN = originalDashboardOrigin;
  vi.restoreAllMocks();
});

function setupModuleMocks(): void {
  vi.doMock('@/lib/webauthn-server', () => ({
    webauthnGenerateRegOptions: webauthnGenerateRegOptionsSpy,
    webauthnVerifyReg: webauthnVerifyRegSpy,
    webauthnGenerateAuthOptions: vi.fn(),
    webauthnVerifyAuth: vi.fn(),
  }));
  vi.doMock('@/lib/webauthn-store', () => ({
    insertChallenge: challengesInsertSpy,
    findLatestUnconsumedChallenge: challengesSelectFirst,
    consumeChallenge: challengesUpdateSpy,
    insertCredential: credentialsInsertSpy,
    listCredentialsForTenant: credentialsSelectAll,
    findCredentialById: vi.fn(),
    bumpCredentialCounter: vi.fn(),
  }));
}

function buildPostReq(path: string, body: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/webauthn/register-options', () => {
  it('returns generated options and persists challenge with purpose=register', async () => {
    setupModuleMocks();
    credentialsSelectAll.mockResolvedValue([]); // no existing credentials -> excludeCredentials = []
    webauthnGenerateRegOptionsSpy.mockResolvedValue({
      challenge: 'ch-abc',
      rp: { id: 'caishenv2.vercel.app', name: '财神爷' },
      user: { id: 'uid', name: 'tao@belcort.com', displayName: 'tao@belcort.com' },
      pubKeyCredParams: [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      attestation: 'none',
      excludeCredentials: [],
    });
    challengesInsertSpy.mockResolvedValue(undefined);

    const { POST } = await import('../../../app/api/auth/webauthn/register-options/route');
    const res = await POST(buildPostReq('/api/auth/webauthn/register-options', {}));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.challenge).toBe('ch-abc');
    expect(body.rp.id).toBe('caishenv2.vercel.app');

    // Challenge persisted with purpose='register' + tenant_id=1.
    expect(challengesInsertSpy).toHaveBeenCalledTimes(1);
    const insertedRow = challengesInsertSpy.mock.calls[0]?.[0];
    expect(insertedRow.tenantId).toBe(1);
    expect(insertedRow.purpose).toBe('register');
    expect(insertedRow.challenge).toBe('ch-abc');
    expect(insertedRow.expiresAt instanceof Date).toBe(true);
  });

  it('rejects non-application/json with 415', async () => {
    setupModuleMocks();
    const { POST } = await import('../../../app/api/auth/webauthn/register-options/route');
    const req = new Request('https://test.local/api/auth/webauthn/register-options', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });
});

describe('POST /api/auth/webauthn/register-verify', () => {
  it('on verified=true: inserts credential row, marks challenge consumed, mints cookie', async () => {
    setupModuleMocks();
    challengesSelectFirst.mockResolvedValue({
      id: 99,
      tenantId: 1,
      challenge: 'ch-abc',
      purpose: 'register',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
    });
    webauthnVerifyRegSpy.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-id-base64',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'https://caishenv2.vercel.app',
        rpID: 'caishenv2.vercel.app',
      },
    });
    challengesUpdateSpy.mockResolvedValue(undefined);
    credentialsInsertSpy.mockResolvedValue(undefined);

    const { POST } = await import('../../../app/api/auth/webauthn/register-verify/route');
    const res = await POST(
      buildPostReq('/api/auth/webauthn/register-verify', {
        id: 'cred-id-base64',
        rawId: 'raw',
        type: 'public-key',
        response: {
          clientDataJSON: 'cdj',
          attestationObject: 'ao',
          transports: ['internal'],
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(credentialsInsertSpy).toHaveBeenCalledTimes(1);
    const credRow = credentialsInsertSpy.mock.calls[0]?.[0];
    expect(credRow.tenantId).toBe(1);
    expect(credRow.credentialId).toBe('cred-id-base64');
    expect(credRow.publicKey).toBeInstanceOf(Uint8Array);
    expect(credRow.counter).toBe(0);
    expect(credRow.transports).toEqual(['internal']);

    expect(challengesUpdateSpy).toHaveBeenCalledWith(99);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('caishen-operator-session=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('on verified=false: returns 400 with structured error.message and does not mint cookie', async () => {
    setupModuleMocks();
    challengesSelectFirst.mockResolvedValue({
      id: 99,
      tenantId: 1,
      challenge: 'ch-abc',
      purpose: 'register',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
    });
    webauthnVerifyRegSpy.mockResolvedValue({ verified: false });

    const { POST } = await import('../../../app/api/auth/webauthn/register-verify/route');
    const res = await POST(
      buildPostReq('/api/auth/webauthn/register-verify', {
        id: 'cred-id-base64',
        rawId: 'raw',
        type: 'public-key',
        response: { clientDataJSON: 'cdj', attestationObject: 'ao' },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(credentialsInsertSpy).not.toHaveBeenCalled();
  });
});
