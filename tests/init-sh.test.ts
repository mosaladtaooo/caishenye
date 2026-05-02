/**
 * FR-020 — init.sh smoke test (AC-020-1, AC-020-3).
 *
 * AC-020-1: Bootstrap script for dev laptop runs and produces a clean health
 *           report with exit 0 OR a LOUD failure listing concrete fix steps.
 * AC-020-3: LOUD failure mode — every FAIL is explained with what would need
 *           to happen to fix it.
 *
 * The script's full behavior involves environment probes (Tailscale + Telegram)
 * which the test cannot run without operator credentials. These tests verify:
 *   - The script is syntactically valid bash and runs without crashing.
 *   - When run against the worktree, it does NOT report a §1 violation
 *     (FR-010 is in place).
 *   - --json mode produces valid JSON.
 *   - Each FAIL message includes a concrete fix command.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const INIT_SH = resolve(REPO_ROOT, '.harness', 'init.sh');

function runInit(args: string[] = []): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [INIT_SH, ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('FR-020 AC-020-1: init.sh runs without crashing', () => {
  it('exits with a valid status code (0 or 1, never 2 — script error)', () => {
    const { code } = runInit();
    expect([0, 1]).toContain(code);
  });

  it('produces a human-readable report banner', () => {
    const { stdout } = runInit();
    expect(stdout).toMatch(/init\.sh|Health Check/i);
  });
});

describe('FR-020 AC-020-1: §1 + §13 — FR-010 audit reported clean', () => {
  it('no ANTHROPIC_API_KEY reported as a check', () => {
    const { stdout } = runInit();
    // The check exists in the report.
    expect(stdout).toMatch(/no ANTHROPIC_API_KEY/);
  });

  it('the §1 check is PASS (not FAIL) on the worktree', () => {
    const { stdout } = runInit();
    // Find the line for §1 and assert PASS-prefix.
    const m = stdout.match(/\[(PASS|FAIL|WARN)\]\s+no\s+ANTHROPIC_API_KEY/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('PASS');
  });
});

describe('FR-020 AC-020-3: LOUD failure messages', () => {
  it('every FAIL line is followed by a fix-command line', () => {
    const { stdout } = runInit();
    // Each [FAIL] line in the report MUST be accompanied by an indented detail
    // line — that's where the fix instruction lives.
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.includes('[FAIL]')) {
        const next = lines[i + 1] ?? '';
        // Detail lines start with at least 6 spaces of indent.
        expect(next).toMatch(/^\s{6,}/);
      }
    }
  });
});

describe('FR-020 AC-020-1: --json mode emits valid JSON', () => {
  it('outputs a JSON object with pass/warn/fail counts', () => {
    const { stdout } = runInit(['--json']);
    // Final line should be the JSON result.
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    const parsed = JSON.parse(lastLine);
    expect(parsed).toEqual(
      expect.objectContaining({
        pass: expect.any(Number),
        warn: expect.any(Number),
        fail: expect.any(Number),
      }),
    );
  });
});

describe('FR-020 AC-020-1: stack alignment — bun, not pnpm', () => {
  it('reports bun (not pnpm) in the report', () => {
    const { stdout } = runInit();
    expect(stdout).toMatch(/\[PASS\]\s+bun/);
  });

  it('does NOT mention pnpm in any check line (legacy reference cleanup)', () => {
    const { stdout } = runInit();
    // The pnpm check from the legacy script should be gone post-FR-020 rewrite.
    // This guards against regression.
    expect(stdout).not.toMatch(/\[PASS\]\s+pnpm/);
    expect(stdout).not.toMatch(/\[FAIL\]\s+pnpm/);
  });

  it('does NOT mention cloudflared (legacy from pre-Tailscale ADR-005)', () => {
    const { stdout } = runInit();
    expect(stdout).not.toMatch(/cloudflared/);
  });
});
