/**
 * FR-010 — Subscription-only auth (no ANTHROPIC_API_KEY)
 *
 * Tests for lefthook.yml — verifies the pre-commit hook is wired to the
 * audit-no-api-key script + gitleaks per constitution §1, §10 + AC-010-1.
 *
 * AC-010-1 demands "a pre-commit hook + CI lint rule" — these tests cover the
 * pre-commit half of that AC. The CI half lives in tests/ci-workflow.test.ts.
 *
 * Why a config test rather than a full git-init smoke test:
 *   - The audit script's BEHAVIOR is fully covered by tests/audit-no-api-key.test.ts.
 *   - The CI workflow's BEHAVIOR is exercised on every push to GitHub.
 *   - This test asserts the WIRING — that lefthook actually invokes both
 *     guardrails. Without it, the audit script could be present but never
 *     fire, defeating the gate.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const LEFTHOOK_YAML = join(REPO_ROOT, 'lefthook.yml');

describe('FR-010 AC-010-1: lefthook pre-commit wiring', () => {
  it('lefthook.yml exists at repo root', () => {
    // Must throw if missing — readFileSync will surface ENOENT.
    const contents = readFileSync(LEFTHOOK_YAML, 'utf-8');
    expect(contents.length).toBeGreaterThan(0);
  });

  it('lefthook.yml has a pre-commit hook block', () => {
    const contents = readFileSync(LEFTHOOK_YAML, 'utf-8');
    expect(contents).toMatch(/^pre-commit:/m);
  });

  it('pre-commit invokes audit-no-api-key.sh (constitution §1)', () => {
    const contents = readFileSync(LEFTHOOK_YAML, 'utf-8');
    // The audit script must be invoked from pre-commit. We don't pin the
    // exact line — only the script reference.
    expect(contents).toMatch(/scripts\/audit-no-api-key\.sh/);
  });

  it('pre-commit invokes biome (lint + format gate)', () => {
    const contents = readFileSync(LEFTHOOK_YAML, 'utf-8');
    // biome check or biome format — either is acceptable as long as it runs.
    expect(contents).toMatch(/biome/);
  });

  it('pre-commit invokes gitleaks (constitution §10 secret scan)', () => {
    const contents = readFileSync(LEFTHOOK_YAML, 'utf-8');
    // Gitleaks may be optional locally if not installed — but config must
    // reference it so CI + installed-locally environments enforce. Per
    // constitution §10: "A secret-scanning step in CI (gitleaks or
    // equivalent) MUST run on every commit."
    expect(contents).toMatch(/gitleaks/);
  });

  it('does NOT use yarn / npm / pnpm (project pinned to bun per packageManager)', () => {
    const contents = readFileSync(LEFTHOOK_YAML, 'utf-8');
    // Catch a copy-paste mistake from lefthook examples (most use yarn).
    expect(contents).not.toMatch(/^\s*-?\s*run:\s*yarn\b/m);
    expect(contents).not.toMatch(/^\s*-?\s*run:\s*npm\b/m);
    expect(contents).not.toMatch(/^\s*-?\s*run:\s*pnpm\b/m);
  });
});
