import { defineConfig } from 'vitest/config';

/**
 * Root-level vitest config. Runs cross-cutting infra tests (e.g. the
 * audit-no-api-key script, preserve-mirror-sync, gitleaks config tests)
 * that don't belong to any single workspace package.
 *
 * Per-workspace tests run via `bun --filter '*' test` and use each
 * workspace's own vitest.config (lives next to that workspace's tsconfig).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.worktrees/**', 'packages/**'],
    testTimeout: 30_000, // bash scripts can take a few seconds on Windows
    reporters: ['verbose'],
  },
});
