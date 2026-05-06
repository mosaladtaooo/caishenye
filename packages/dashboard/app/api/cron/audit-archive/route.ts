/**
 * /api/cron/audit-archive — daily at 03:30 GMT (ADR-006).
 *
 * Archives audit rows older than the configurable retention (default 365
 * days) to Vercel Blob; Postgres rows past the threshold are deleted.
 * The cold-archive recall path lives at /api/archive-fetch.
 *
 * v1.2 FR-023 D4 (clarify Q1) extension: this same cron also DELETEs
 * webauthn_challenges rows whose expires_at is older than now() - 5 min
 * (the challenge TTL is 5 min; the grace window protects against late
 * verify attempts). Soft cap against Postgres-row-flooding from the 4
 * public pre-auth WebAuthn endpoints.
 *
 * Per-IP rate-limit on /api/auth/webauthn/* is deferred to v1.3 (KI-010).
 */

import { validateCronAuth } from '@/lib/cron-auth';
import { deleteStaleChallenges } from '@/lib/webauthn-store';

const TENANT_ID = 1; // v1 single-tenant
const WEBAUTHN_SWEEP_GRACE_MS = 5 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  const authFail = validateCronAuth(req);
  if (authFail) return authFail;

  let webauthnSweepCount: number;
  try {
    webauthnSweepCount = await deleteStaleChallenges(TENANT_ID, WEBAUTHN_SWEEP_GRACE_MS);
  } catch (e) {
    process.stderr.write(
      `[cron/audit-archive] webauthn-sweep failed (best-effort): ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
    webauthnSweepCount = -1;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      todo: 'M5-step-25',
      webauthn_challenges_swept: webauthnSweepCount,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
