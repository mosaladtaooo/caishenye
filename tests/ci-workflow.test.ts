/**
 * FR-010 AC-010-1 + AC-010-5 — CI lint rule + CI mirror of pre-commit gate.
 * Constitution §1, §10, §17.
 *
 * Tests for `.github/workflows/ci.yml` — verifies CI runs the same gates as
 * pre-commit (audit-no-api-key + biome + tsc + vitest + gitleaks).
 *
 * Note: This is a config test. The actual CI runs are exercised on every
 * push to GitHub; this test catches WIRING regressions ("we forgot to add
 * the audit step on the new branch's CI YAML") at commit time.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const CI_YAML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

describe('FR-010 AC-010-1 + AC-010-5: GitHub Actions CI workflow', () => {
  it('.github/workflows/ci.yml exists', () => {
    expect(existsSync(CI_YAML)).toBe(true);
  });

  it('CI runs the audit-no-api-key script (AC-010-1 CI half)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents).toMatch(/audit-no-api-key/);
  });

  it('CI runs biome lint (constitution §17 — no any, no console)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents).toMatch(/biome/);
  });

  it('CI runs gitleaks (constitution §10 — secret scan)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents.toLowerCase()).toMatch(/gitleaks/);
  });

  it('CI runs tsc (TypeScript type-check across all workspaces)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents).toMatch(/tsc/);
  });

  it('CI runs vitest (constitution §9 — unit/integration tests)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents.toLowerCase()).toMatch(/vitest/);
  });

  it('CI uses Bun (matches packageManager in package.json)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    // Either oven-sh/setup-bun action or a manual `curl -fsSL bun.sh/install`.
    expect(contents.toLowerCase()).toMatch(/oven-sh\/setup-bun|bun\.sh|setup-bun/);
  });

  it('CI fires on push to main and on every pull_request', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents).toMatch(/^\s*push:/m);
    expect(contents).toMatch(/^\s*pull_request:/m);
  });

  it('CI does NOT use yarn / npm / pnpm (project pinned to bun)', () => {
    const contents = readFileSync(CI_YAML, 'utf-8');
    expect(contents).not.toMatch(/^\s*-?\s*run:\s*yarn\b/m);
    expect(contents).not.toMatch(/^\s*-?\s*run:\s*npm\b/m);
    expect(contents).not.toMatch(/^\s*-?\s*run:\s*pnpm\b/m);
  });
});
