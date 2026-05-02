/**
 * FR-010 — Subscription-only auth (no `ANTHROPIC_API_KEY`)
 *
 * Tests for `scripts/audit-no-api-key.sh` — constitution §1 + §13 enforcement.
 * The audit script is the single source of truth for the no-API-key gate;
 * it's invoked by:
 *   - lefthook pre-commit hook (every commit)
 *   - GitHub Actions CI (every push)
 *   - `make audit-no-api-key` / `bun run audit:no-api-key` (local)
 *
 * AC-010-1: The pre-commit hook + CI lint scans all source files (including
 *           .env*, .json, .md) for the pattern `ANTHROPIC_API_KEY` and rejects
 *           any commit that contains it.
 * AC-010-5: `make audit-no-api-key` runs the lint rule + greps Vercel env
 *           (vercel env ls) for the forbidden key and exits 0 only if all clean.
 * EC-010-1: A dependency generates the literal in its README — pre-commit
 *           rejects, dependency is patched OR excluded with explicit allowlist
 *           comment.
 *
 * Spec files under `.harness/spec/` and the audit script itself legitimately
 * REFERENCE the literal — those paths are excluded by the script. The exclusion
 * list is intentionally narrow + audited via a dedicated test (see below).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'audit-no-api-key.sh');

/**
 * Run the audit script in a controlled test directory. The script accepts an
 * optional first arg = scan root (so we can point it at a temp dir without
 * touching the real repo). Returns exit code + stdout + stderr.
 */
function runAudit(scanRoot: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT_PATH, scanRoot], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('FR-010 AC-010-1: audit-no-api-key script — base behavior', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'caishen-audit-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits 0 when no source files contain ANTHROPIC_API_KEY', () => {
    writeFileSync(join(tmp, 'foo.ts'), 'export const x = 1;\n');
    writeFileSync(join(tmp, 'bar.json'), '{"key":"value"}\n');
    writeFileSync(join(tmp, '.env.example'), 'AUTH_SECRET=REPLACE_ME\n');

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).toBe(0);
    // Reach for a positive success marker so this can't pass via "command not found" stderr.
    expect(stdout + stderr).toMatch(/PASS|OK|clean/i);
  });

  it('exits non-zero when a TypeScript file contains ANTHROPIC_API_KEY', () => {
    // The literal appears in real source — this is the canonical violation.
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'leak.ts'), 'const k = process.env.ANTHROPIC_API_KEY;\n');

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(stdout + stderr).toMatch(/leak\.ts/);
  });

  it('exits non-zero when an .env file contains ANTHROPIC_API_KEY', () => {
    writeFileSync(join(tmp, '.env'), 'ANTHROPIC_API_KEY=sk-ant-fake\n');

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(stdout + stderr).toMatch(/\.env/);
  });

  it('exits non-zero when a JSON file contains ANTHROPIC_API_KEY', () => {
    writeFileSync(
      join(tmp, 'config.json'),
      `${JSON.stringify({ ANTHROPIC_API_KEY: 'sk-ant-fake' })}\n`,
    );

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('exits non-zero when a Markdown README contains ANTHROPIC_API_KEY', () => {
    // EC-010-1: dependency README leaks the literal — pre-commit must reject.
    writeFileSync(
      join(tmp, 'README.md'),
      '# Some lib\n\nSet `ANTHROPIC_API_KEY=...` to authenticate.\n',
    );

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(stdout + stderr).toMatch(/README\.md/);
  });

  it('skips node_modules, .git, dist, .next', () => {
    // These directories legitimately contain third-party files we cannot edit.
    // The audit script must skip them or every install would fail.
    mkdirSync(join(tmp, 'node_modules', 'evil-dep'), { recursive: true });
    writeFileSync(
      join(tmp, 'node_modules', 'evil-dep', 'README.md'),
      'requires ANTHROPIC_API_KEY env var\n',
    );
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, '.git', 'HEAD'), 'ANTHROPIC_API_KEY ref\n');
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'bundle.js'), 'process.env.ANTHROPIC_API_KEY\n');

    // No real source-file violations:
    writeFileSync(join(tmp, 'src.ts'), 'export {};\n');

    const { code } = runAudit(tmp);

    expect(code).toBe(0);
  });

  it('reports the offending file path so operator can locate the leak', () => {
    mkdirSync(join(tmp, 'packages', 'foo', 'src'), { recursive: true });
    writeFileSync(
      join(tmp, 'packages', 'foo', 'src', 'leak.ts'),
      'const k = process.env.ANTHROPIC_API_KEY;\n',
    );

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/packages\/foo\/src\/leak\.ts/);
  });
});

describe('FR-010 AC-010-1: audit-no-api-key — spec/preserve allowlist', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'caishen-audit-allow-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('allows the literal inside .harness/spec/ (constitution + PRD legitimately reference it)', () => {
    // Per the script's allowlist: spec files MAY reference the literal because
    // §1 + §13 + FR-010 are themselves about the literal. Source files MUST NOT.
    mkdirSync(join(tmp, '.harness', 'spec'), { recursive: true });
    writeFileSync(
      join(tmp, '.harness', 'spec', 'constitution.md'),
      '## §1 — NO ANTHROPIC_API_KEY ANYWHERE\nThe literal must not appear...\n',
    );

    const { code } = runAudit(tmp);
    expect(code).toBe(0);
  });

  it('allows the literal inside the audit script itself (it has to grep for it)', () => {
    // The script greps for the literal — its own source naturally contains it.
    // The allowlist excludes scripts/audit-no-api-key.sh from the scan target.
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(
      join(tmp, 'scripts', 'audit-no-api-key.sh'),
      '#!/usr/bin/env bash\ngrep -r ANTHROPIC_API_KEY .\n',
    );

    const { code } = runAudit(tmp);
    expect(code).toBe(0);
  });

  it('still rejects the literal in source even when an allowed sibling exists', () => {
    mkdirSync(join(tmp, '.harness', 'spec'), { recursive: true });
    writeFileSync(
      join(tmp, '.harness', 'spec', 'prd.md'),
      'FR-010: ANTHROPIC_API_KEY must not appear...\n',
    );
    // ...but a real source file leaks it:
    writeFileSync(join(tmp, 'leak.ts'), 'const k = ANTHROPIC_API_KEY;\n');

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    // Tighten so this can't pass merely because the script doesn't exist.
    // The script must specifically name the offending file.
    expect(stdout + stderr).toMatch(/leak\.ts/);
  });
});

describe('FR-010 AC-010-1: edge case — case sensitivity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'caishen-audit-case-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('matches the EXACT casing — anthropic_api_key (lowercase) is also rejected', () => {
    // Sloppy operator types lowercase or mixed case — still a leak.
    writeFileSync(join(tmp, '.env'), 'anthropic_api_key=sk-ant-fake\n');

    const { code, stdout, stderr } = runAudit(tmp);

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/anthropic_api_key/i);
  });
});
