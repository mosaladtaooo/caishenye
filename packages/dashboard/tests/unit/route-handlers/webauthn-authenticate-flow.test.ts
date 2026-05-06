/**
 * AC-023-2 + AC-023-6 -- WebAuthn authenticate options + verify route tests.
 *
 *   POST /api/auth/webauthn/authenticate-options -> options + challenge insert
 *   POST /api/auth/webauthn/authenticate-verify  -> counter bump + cookie mint
 *
 * The credential row's counter MUST advance to authenticationInfo.newCounter
 * on success; tests assert the SHAPE of the bumpCredentialCounter call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalAuthSecret: string | undefined;
let originalAuthUrl: string | undefined;
let originalRpIdProd: string | undefined;
let originalVercelEnv: string | undefined;
let originalDashboardOrigin: string | undefined;

let webauthnGenerateAuthOptionsSpy: ReturnType<typeof vi.fn>;
let webauthnVerifyAuthSpy: ReturnType<typeof vi.fn>;

let challengesInsertSpy: ReturnType<typeof vi.fn>;
let challengesUpdateSpy: ReturnType<typeof vi.fn>;
let challengesSelectFirst: ReturnType<typeof vi.fn>;
let credentialsSelectAll: ReturnType<typeof vi.fn>;
let findCredentialByIdSpy: ReturnType<typeof vi.fn>;
let bumpCredentialCounterSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalAuthSecret = process.env.AUTH_SECRET;
  originalAuthUrl = process.env.AUTH_URL;
  originalRpIdProd = process.env.WEBAUTHN_RP_ID_PROD;
  originalVercelEnv = process.env.VERCEL_ENV;
  originalDashboardOrigin = process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN;

  process.env.AUTH_SECRET = 'a'.repeat(64);
  process.env.AUTH_URL = 'https://test.local';
  process.env.WEBAUTHN_RP_ID_PROD = 'caishenv2.vercel.app';
  process.env.VERCEL_ENV = 'production';
  process.env.NEXT_PUBLIC_DASHBOARD_ORIGIN = 'https://caishenv2.vercel.app';

  webauthnGenerateAuthOptionsSpy = vi.fn();
  webauthnVerifyAuthSpy = vi.fn();
  challengesInsertSpy = vi.fn();
  challengesUpdateSpy = vi.fn();
  challengesSelectFirst = vi.fn();
  credentialsSelectAll = vi.fn();
  findCredentialByIdSpy = vi.fn();
  bumpCredentialCounterSpy = vi.fn();

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
    webauthnGenerateRegOptions: vi.fn(),
    webauthnVerifyReg: vi.fn(),
    webauthnGenerateAuthOptions: webauthnGenerateAuthOptionsSpy,
    webauthnVerifyAuth: webauthnVerifyAuthSpy,
  }));
  vi.doMock('@/lib/webauthn-store', () => ({
    insertChallenge: challengesInsertSpy,
    findLatestUnconsumedChallenge: challengesSelectFirst,
    consumeChallenge: challengesUpdateSpy,
    insertCredential: vi.fn(),
    listCredentialsForTenant: credentialsSelectAll,
    findCredentialById: findCredentialByIdSpy,
    bumpCredentialCounter: bumpCredentialCounterSpy,
  }));
}

function buildPostReq(path: string, body: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/webauthn/authenticate-options', () => {
  it('returns generated options and persists challenge with purpose=authenticate', async () => {
    setupModuleMocks();
    credentialsSelectAll.mockResolvedValue([
      {
        credentialId: 'cred-id-base64',
        transports: ['internal'],
      },
    ]);
    webauthnGenerateAuthOptionsSpy.mockResolvedValue({
      challenge: 'ch-xyz',
      rpId: 'caishenv2.vercel.app',
      allowCredentials: [{ id: 'cred-id-base64', type: 'public-key' }],
      userVerification: 'preferred',
    });
    challengesInsertSpy.mockResolvedValue(undefined);

    const { POST } = await import('../../../app/api/auth/webauthn/authenticate-options/route');
    const res = await POST(buildPostReq('/api/auth/webauthn/authenticate-options', {}));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.challenge).toBe('ch-xyz');

    expect(challengesInsertSpy).toHaveBeenCalledTimes(1);
    const insertedRow = challengesInsertSpy.mock.calls[0]?.[0];
    expect(insertedRow.tenantId).toBe(1);
    expect(insertedRow.purpose).toBe('authenticate');
    expect(insertedRow.challenge).toBe('ch-xyz');
  });
});

describe('POST /api/auth/webauthn/authenticate-verify', () => {
  it('on verified=true: bumps counter, marks challenge consumed, mints cookie', async () => {
    setupModuleMocks();
    challengesSelectFirst.mockResolvedValue({
      id: 88,
      tenantId: 1,
      challenge: 'ch-xyz',
      purpose: 'authenticate',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
    });
    findCredentialByIdSpy.mockResolvedValue({
      id: 7,
      tenantId: 1,
      credentialId: 'cred-id-base64',
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 5,
      transports: ['internal'],
      nickname: 'phone',
      createdAt: new Date(),
      lastUsedAt: null,
    });
    webauthnVerifyAuthSpy.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'cred-id-base64',
        newCounter: 6,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'https://caishenv2.vercel.app',
        rpID: 'caishenv2.vercel.app',
      },
    });
    challengesUpdateSpy.mockResolvedValue(undefined);
    bumpCredentialCounterSpy.mockResolvedValue(undefined);

    const { POST } = await import('../../../app/api/auth/webauthn/authenticate-verify/route');
    const res = await POST(
      buildPostReq('/api/auth/webauthn/authenticate-verify', {
        id: 'cred-id-base64',
        rawId: 'raw',
        type: 'public-key',
        response: {
          clientDataJSON: 'cdj',
          authenticatorData: 'ad',
          signature: 'sig',
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(bumpCredentialCounterSpy).toHaveBeenCalledTimes(1);
    expect(bumpCredentialCounterSpy.mock.calls[0]?.[0]).toBe(7); // credential row id
    expect(bumpCredentialCounterSpy.mock.calls[0]?.[1]).toBe(6); // newCounter
    expect(challengesUpdateSpy).toHaveBeenCalledWith(88);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('caishen-operator-session=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('on verified=false: returns 400 with error.message and does not mint cookie', async () => {
    setupModuleMocks();
    challengesSelectFirst.mockResolvedValue({
      id: 88,
      tenantId: 1,
      challenge: 'ch-xyz',
      purpose: 'authenticate',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
    });
    findCredentialByIdSpy.mockResolvedValue({
      id: 7,
      tenantId: 1,
      credentialId: 'cred-id-base64',
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 5,
      transports: ['internal'],
      nickname: null,
      createdAt: new Date(),
      lastUsedAt: null,
    });
    webauthnVerifyAuthSpy.mockResolvedValue({ verified: false });

    const { POST } = await import('../../../app/api/auth/webauthn/authenticate-verify/route');
    const res = await POST(
      buildPostReq('/api/auth/webauthn/authenticate-verify', {
        id: 'cred-id-base64',
        rawId: 'raw',
        type: 'public-key',
        response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(bumpCredentialCounterSpy).not.toHaveBeenCalled();
  });
});
