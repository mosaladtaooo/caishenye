/**
 * AC-023-2 per-env RP_ID matrix tests (clarify Q6 + R5 message-text assertion).
 *
 * The helper switches on `process.env.VERCEL_ENV`:
 *   - 'production'  -> WEBAUTHN_RP_ID_PROD     (LOUD-fail per §15 if unset)
 *   - 'preview'     -> WEBAUTHN_RP_ID_PREVIEW  (LOUD-fail per §15 if unset)
 *   - 'development' -> WEBAUTHN_RP_ID_DEV      (default 'localhost' if unset)
 *   - unset         -> treated as 'development' (local `bun run dev`)
 *
 * R5 invariant: in the preview-without-WEBAUTHN_RP_ID_PREVIEW case the
 * thrown error message MUST contain BOTH 'WEBAUTHN_RP_ID_PREVIEW' AND
 * 'EMERGENCY_TOKEN_LOGIN_ENABLED' so the operator gets a single error
 * message that names both available remediations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENV_KEYS = [
  'VERCEL_ENV',
  'WEBAUTHN_RP_ID_PROD',
  'WEBAUTHN_RP_ID_PREVIEW',
  'WEBAUTHN_RP_ID_DEV',
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function importHelper() {
  const mod = await import('../../../lib/resolve-rp-id');
  return mod.resolveRpId;
}

describe('resolveRpId — per-env VERCEL_ENV matrix', () => {
  it('production env returns WEBAUTHN_RP_ID_PROD', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.WEBAUTHN_RP_ID_PROD = 'caishenv2.vercel.app';
    const resolveRpId = await importHelper();
    expect(resolveRpId()).toBe('caishenv2.vercel.app');
  });

  it('production env without WEBAUTHN_RP_ID_PROD throws §15 LOUD-fail', async () => {
    process.env.VERCEL_ENV = 'production';
    const resolveRpId = await importHelper();
    expect(() => resolveRpId()).toThrow(/WEBAUTHN_RP_ID_PROD/);
  });

  it('preview env returns WEBAUTHN_RP_ID_PREVIEW', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.WEBAUTHN_RP_ID_PREVIEW = 'preview-branch.vercel.app';
    const resolveRpId = await importHelper();
    expect(resolveRpId()).toBe('preview-branch.vercel.app');
  });

  it('preview env without WEBAUTHN_RP_ID_PREVIEW throws §15 LOUD-fail with both env-var keywords', async () => {
    // R5 message-text assertion: ONE thrown error must contain BOTH names.
    process.env.VERCEL_ENV = 'preview';
    const resolveRpId = await importHelper();
    expect(() => resolveRpId()).toThrow(/WEBAUTHN_RP_ID_PREVIEW/);
    expect(() => resolveRpId()).toThrow(/EMERGENCY_TOKEN_LOGIN_ENABLED/);
  });

  it('development env returns WEBAUTHN_RP_ID_DEV when set', async () => {
    process.env.VERCEL_ENV = 'development';
    process.env.WEBAUTHN_RP_ID_DEV = 'localhost';
    const resolveRpId = await importHelper();
    expect(resolveRpId()).toBe('localhost');
  });

  it("development env defaults to 'localhost' when WEBAUTHN_RP_ID_DEV is unset", async () => {
    process.env.VERCEL_ENV = 'development';
    const resolveRpId = await importHelper();
    expect(resolveRpId()).toBe('localhost');
  });

  it("unset VERCEL_ENV defaults to development behaviour ('localhost')", async () => {
    const resolveRpId = await importHelper();
    expect(resolveRpId()).toBe('localhost');
  });
});
