/**
 * R7-b -- install-cron-runner-service.ps1 -DryRun mode test.
 *
 * Per Evaluator W3 watch-item: use path.join(__dirname, ...) (or equivalent
 * forward-slash path resolution) -- Windows path-with-backslash arguments to
 * child_process.spawnSync get mangled in some Node versions.
 *
 * This test runs the PS1 in -DryRun mode and asserts:
 *   1. Exit code 0
 *   2. Stdout contains the literal command "nssm install caishen-cron-runner"
 *   3. No actual service is created (no Get-Service caishen-cron-runner)
 *
 * Skips on non-Windows / non-pwsh CI matrix entries via it.runIf().
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const isWin32 = process.platform === 'win32';

/**
 * Resolve a usable PowerShell binary. PS7 (`pwsh`) is preferred but Windows
 * Server VPS often only has Windows PowerShell 5.1 (`powershell`); we fall
 * back so the test runs on either.
 */
function resolvePsBin(): string {
  // Try pwsh first (PS7+).
  const probePwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'echo ok'], {
    encoding: 'utf8',
  });
  if (probePwsh.status === 0) return 'pwsh';
  // Fall back to Windows PowerShell 5.1 -- works for the script's syntax.
  return 'powershell';
}

// Resolve the PS1 path forward-slash-style to dodge Windows backslash mangling
// in some Node versions (W3 watch-item).
const ps1Path = resolve(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'infra',
    'vps',
    'windows',
    'install-cron-runner-service.ps1',
  ),
);

describe.runIf(isWin32)('install-cron-runner-service.ps1 -DryRun (R7-b, Windows-only)', () => {
  it('exits 0 with -DryRun + fake paths and prints expected nssm commands', () => {
    const psBin = resolvePsBin();
    const result = spawnSync(
      psBin,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        ps1Path,
        '-DryRun',
        '-BunPath',
        'C:/fake/bun.exe',
        '-NssmPath',
        'C:/fake/nssm.exe',
        '-RepoRoot',
        'C:/fake/repo',
        '-EnvFile',
        'C:/fake/cron-runner.env',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const stdout = result.stdout ?? '';

    // Must announce the NSSM install command (the operator-facing payload).
    expect(stdout).toMatch(/nssm install caishen-cron-runner/);

    // Must announce the loop entry-point path.
    expect(stdout).toMatch(/packages.cron-runner.scripts.loop\.ts/);

    // Must announce DRY-RUN status and confirm no real changes.
    expect(stdout).toMatch(/DRY-RUN/);

    // No actual service should have been created (we used fake paths so a
    // real install would have thrown anyway, but verify explicitly).
    const checkSvc = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-Service caishen-cron-runner -ErrorAction SilentlyContinue'],
      { encoding: 'utf8' },
    );
    // If the service does NOT exist, Get-Service prints nothing; if it
    // exists, it prints a row containing 'caishen-cron-runner'.
    expect(checkSvc.stdout ?? '').not.toMatch(/caishen-cron-runner/);
  });

  it('exits non-zero in non-DryRun mode when fake paths are passed (LOUD-fail invariant)', () => {
    const psBin = resolvePsBin();
    const result = spawnSync(
      psBin,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        ps1Path,
        '-BunPath',
        'C:/definitely-does-not-exist/bun.exe',
        '-NssmPath',
        'C:/definitely-does-not-exist/nssm.exe',
        '-RepoRoot',
        'C:/definitely-does-not-exist',
        '-EnvFile',
        'C:/definitely-does-not-exist/.env',
      ],
      { encoding: 'utf8' },
    );

    // Pre-flight throws on missing Bun binary.
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(combined).toMatch(/Bun binary not found/);
  });
});

describe.runIf(!isWin32)('install-cron-runner-service.ps1 (non-Windows fallback)', () => {
  it('PS1 file exists in the worktree even when the test cannot run pwsh', async () => {
    // On non-Windows CI the PS1 cannot be invoked, but the file MUST still
    // exist in the repo so a Windows operator can run it. This also catches
    // accidental file deletion in cross-platform CI.
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(ps1Path);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(1000);
  });
});
