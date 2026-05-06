/**
 * EC-023-2..EC-023-5 -- WebAuthn edge-case routing tests.
 *
 *   EC-023-2: counter regression -> 401 + writeAuthAuditRow with R10
 *             column-shape: { event_type:'auth_counter_regression',
 *             tenant_id, details_json:{ credential_id, stored_counter,
 *             attempted_counter, request_path }}
 *   EC-023-3: SimpleWebAuthn THROWS on malformed input -> 400
 *   EC-023-4: challenge older than 5 min -> 400 'expired_challenge'
 *             challenge already consumed -> 400 'consumed_challenge'
 *   EC-023-5: covered by resolve-rp-id.test.ts (rpID mismatch is rp-id
 *             misconfig, not a per-request edge case)
 *
 * The auth-audit module is mocked so the spy can assert column-by-column
 * equality on the row shape (R10).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalAuthSecret: string | undefined;
let originalAuthUrl: string | undefined;
let originalRpIdProd: string | undefined;
let originalVercelEnv: string | undefined;
let originalDashboardOrigin: string | undefined;

let webauthnVerifyAuthSpy: ReturnType<typeof vi.fn>;
let webauthnVerifyRegSpy: ReturnType<typeof vi.fn>;

let challengesUpdateSpy: ReturnType<typeof vi.fn>;
let challengesSelectFirst: ReturnType<typeof vi.fn>;
let findCredentialByIdSpy: ReturnType<typeof vi.fn>;
let bumpCredentialCounterSpy: ReturnType<typeof vi.fn>;

let writeAuthAuditRowSpy: ReturnType<typeof vi.fn>;

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

  webauthnVerifyAuthSpy = vi.fn();
  webauthnVerifyRegSpy = vi.fn();
  challengesUpdateSpy = vi.fn();
  challengesSelectFirst = vi.fn();
  findCredentialByIdSpy = vi.fn();
  bumpCredentialCounterSpy = vi.fn();
  writeAuthAuditRowSpy = vi.fn();

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

function setupAuthVerifyMocks(): void {
  vi.doMock('@/lib/webauthn-server', () => ({
    webauthnGenerateRegOptions: vi.fn(),
    webauthnVerifyReg: webauthnVerifyRegSpy,
    webauthnGenerateAuthOptions: vi.fn(),
    webauthnVerifyAuth: webauthnVerifyAuthSpy,
  }));
  vi.doMock('@/lib/webauthn-store', () => ({
    insertChallenge: vi.fn(),
    findLatestUnconsumedChallenge: challengesSelectFirst,
    consumeChallenge: challengesUpdateSpy,
    insertCredential: vi.fn(),
    listCredentialsForTenant: vi.fn().mockResolvedValue([]),
    findCredentialById: findCredentialByIdSpy,
    bumpCredentialCounter: bumpCredentialCounterSpy,
  }));
  vi.doMock('@/lib/auth-audit', () => ({
    writeAuthAuditRow: writeAuthAuditRowSpy,
  }));
}

function buildPostReq(path: string, body: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(body),
  });
}

describe('EC-023-2 — counter regression on authenticate-verify', () => {
  it('returns 401 + writes auth_counter_regression audit row (R10 column shape)', async () => {
    setupAuthVerifyMocks();
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
      counter: 42,
      transports: ['internal'],
      nickname: null,
      createdAt: new Date(),
      lastUsedAt: null,
    });
    // SimpleWebAuthn returns verified:true but newCounter (41) < stored (42).
    webauthnVerifyAuthSpy.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'cred-id-base64',
        newCounter: 41,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'https://caishenv2.vercel.app',
        rpID: 'caishenv2.vercel.app',
      },
    });

    const { POST } = await import('../../../app/api/auth/webauthn/authenticate-verify/route');
    const res = await POST(
      buildPostReq('/api/auth/webauthn/authenticate-verify', {
        id: 'cred-id-base64',
        rawId: 'raw',
        type: 'public-key',
        response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(bumpCredentialCounterSpy).not.toHaveBeenCalled();

    // R10 column-shape: column-by-column equality on the audit row.
    expect(writeAuthAuditRowSpy).toHaveBeenCalledTimes(1);
    expect(writeAuthAuditRowSpy.mock.calls[0]?.[0]).toEqual({
      event_type: 'auth_counter_regression',
      tenant_id: 1,
      details_json: {
        credential_id: 'cred-id-base64',
        stored_counter: 42,
        attempted_counter: 41,
        request_path: '/api/auth/webauthn/authenticate-verify',
      },
    });
  });
});

describe('EC-023-3 — SimpleWebAuthn throws on malformed input', () => {
  it('caught at boundary -> returns 400 with error message (no stack leak)', async () => {
    setupAuthVerifyMocks();
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
    webauthnVerifyAuthSpy.mockRejectedValue(new Error('malformed signature'));

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
    const body = await res.json();
    expect(body.error).toContain('malformed signature');
    // No stack trace leaked (we send only error.message).
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});

describe('EC-023-4 — expired or consumed challenge', () => {
  it('challenge older than 5 min -> 400 expired_challenge', async () => {
    setupAuthVerifyMocks();
    challengesSelectFirst.mockResolvedValue({
      id: 88,
      tenantId: 1,
      challenge: 'ch-xyz',
      purpose: 'authenticate',
      createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      expiresAt: new Date(Date.now() - 5 * 60 * 1000), // expired 5 min ago
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
    const body = await res.json();
    expect(body.error).toMatch(/expired/i);
    expect(webauthnVerifyAuthSpy).not.toHaveBeenCalled();
  });

  it('no matching unconsumed challenge -> 400 missing_challenge', async () => {
    setupAuthVerifyMocks();
    challengesSelectFirst.mockResolvedValue(null);

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
    const body = await res.json();
    expect(body.error).toMatch(/no.*challenge|missing/i);
  });
});

describe('EC-023-2 (register variant) — wrong tenant_id on credential lookup', () => {
  it('credential row tenant_id != request tenant_id -> 401', async () => {
    setupAuthVerifyMocks();
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
      tenantId: 999, // mismatched tenant
      credentialId: 'cred-id-base64',
      publicKey: new Uint8Array([1, 2, 3, 4]),
      counter: 5,
      transports: ['internal'],
      nickname: null,
      createdAt: new Date(),
      lastUsedAt: null,
    });

    const { POST } = await import('../../../app/api/auth/webauthn/authenticate-verify/route');
    const res = await POST(
      buildPostReq('/api/auth/webauthn/authenticate-verify', {
        id: 'cred-id-base64',
        rawId: 'raw',
        type: 'public-key',
        response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
      }),
    );
    expect(res.status).toBe(401);
    expect(webauthnVerifyAuthSpy).not.toHaveBeenCalled();
  });
});
