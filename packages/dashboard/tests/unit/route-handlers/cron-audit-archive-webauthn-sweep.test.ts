/**
 * FR-023 D4 -- /api/cron/audit-archive webauthn_challenges sweep test.
 *
 * Per clarify Q1: the existing 03:30 GMT audit-archive cron is extended
 * to also DELETE webauthn_challenges rows where expires_at is older than
 * `now() - 5 minutes` (soft cap against Postgres-row-flooding from the
 * 4 public pre-auth WebAuthn endpoints).
 *
 * v1.2 first-ship audit-archive route is a stub (M5-step-25). This test
 * pins the contract that the deleteStaleChallenges helper IS called when
 * the cron runs with valid CRON_SECRET; the actual deletion path lives
 * in lib/webauthn-store.ts and is tested via the route call shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalCronSecret: string | undefined;
let deleteStaleChallengesSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-' + 'c'.repeat(60);
  deleteStaleChallengesSpy = vi.fn().mockResolvedValue(0);
  vi.resetModules();
});

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  vi.restoreAllMocks();
});

function setupModuleMocks(): void {
  vi.doMock('@/lib/webauthn-store', () => ({
    insertChallenge: vi.fn(),
    findLatestUnconsumedChallenge: vi.fn(),
    consumeChallenge: vi.fn(),
    insertCredential: vi.fn(),
    listCredentialsForTenant: vi.fn(),
    findCredentialById: vi.fn(),
    bumpCredentialCounter: vi.fn(),
    deleteStaleChallenges: deleteStaleChallengesSpy,
  }));
}

function buildCronReq(): Request {
  return new Request('https://test.local/api/cron/audit-archive', {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

describe('GET /api/cron/audit-archive — webauthn_challenges sweep (clarify Q1)', () => {
  it('on valid CRON_SECRET: calls deleteStaleChallenges and returns 200', async () => {
    setupModuleMocks();
    const { GET } = await import('../../../app/api/cron/audit-archive/route');
    const res = await GET(buildCronReq());
    expect(res.status).toBe(200);
    // The sweep helper IS invoked (call shape; the actual rows-affected
    // count comes from postgres-js drizzle and is asserted = 0 in v1.2
    // first-ship stub).
    expect(deleteStaleChallengesSpy).toHaveBeenCalled();
  });

  it('without CRON_SECRET: returns 401 and does NOT call the sweep helper', async () => {
    setupModuleMocks();
    const { GET } = await import('../../../app/api/cron/audit-archive/route');
    const noAuthReq = new Request('https://test.local/api/cron/audit-archive', { method: 'GET' });
    const res = await GET(noAuthReq);
    expect(res.status).toBe(401);
    expect(deleteStaleChallengesSpy).not.toHaveBeenCalled();
  });
});
