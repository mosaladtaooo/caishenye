/**
 * Playwright config -- v1.2 FR-023 D4 e2e auth-passkey spec.
 *
 * The spec uses Chromium's CDP virtualAuthenticator API to drive WebAuthn
 * without a physical device. baseURL defaults to local Next.js dev (3000)
 * but accepts E2E_BASE_URL override so the suite can run against a
 * deployed Vercel preview.
 *
 * Run via:
 *   bun --filter @caishen/dashboard run test:e2e
 *
 * Note: Vitest config explicitly excludes tests/e2e to keep the unit
 * runner from picking up these specs.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
