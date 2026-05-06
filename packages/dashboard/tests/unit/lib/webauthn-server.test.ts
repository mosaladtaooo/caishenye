/**
 * FR-023 D4 — webauthn-server.ts thin-wrapper exports.
 *
 * The wrapper mirrors lib/mt5-server.ts shape: a small set of verb-named
 * named exports that delegate to @simplewebauthn/server v13. The wrapper's
 * purpose is to give the route handlers a stable internal API and a single
 * place to mock in unit tests.
 *
 * This contract test asserts the four named exports exist and are functions.
 * The route-handler tests further down do the actual call-shape coverage.
 */

import { describe, expect, it } from 'vitest';

describe('webauthn-server.ts — v13 wrapper exports', () => {
  it('exports four verb functions', async () => {
    const mod = await import('../../../lib/webauthn-server');
    expect(typeof mod.webauthnGenerateRegOptions).toBe('function');
    expect(typeof mod.webauthnVerifyReg).toBe('function');
    expect(typeof mod.webauthnGenerateAuthOptions).toBe('function');
    expect(typeof mod.webauthnVerifyAuth).toBe('function');
  });
});
