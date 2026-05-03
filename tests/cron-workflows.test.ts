/**
 * FR-005 AC-005-1 + AC-005-2 amendment (ADR-011) — schedule-string regression
 * guard for the GitHub Actions cron workflows.
 *
 * The two sub-daily crons (channels-health 5min, synthetic-ping 30min) moved
 * from Vercel cron to GitHub Actions cron because Vercel Hobby plan blocks
 * sub-daily Vercel crons. This test pins the cron expressions so they cannot
 * silently drift.
 *
 * Why this matters: a one-character typo in a cron string can silently break
 * the alerting cadence without any runtime error — GH Actions just runs the
 * workflow at the wrong cadence. Constitution §15 (LOUD failure mode) demands
 * this be caught at commit time.
 *
 * Constitution mappings:
 *   §9   vitest unit/integration → this file
 *   §15  pre-flight cleanness     → schedule drift caught at lefthook + CI
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const CHANNELS_HEALTH_YAML = join(REPO_ROOT, '.github', 'workflows', 'cron-channels-health.yml');
const SYNTHETIC_PING_YAML = join(REPO_ROOT, '.github', 'workflows', 'cron-synthetic-ping.yml');

/**
 * Extracts the first `cron: '<expr>'` value from a workflow YAML. Tolerates
 * single or double quotes; throws if not found.
 */
function extractCronExpression(yamlContent: string): string {
  // Match: cron: '<expr>'  OR  cron: "<expr>"
  const m = yamlContent.match(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/m);
  if (m === null || m[1] === undefined) {
    throw new Error('No cron expression found in workflow YAML');
  }
  return m[1];
}

describe('FR-005 AC-005-2: cron-channels-health.yml schedule pin', () => {
  it('workflow file exists at .github/workflows/cron-channels-health.yml', () => {
    expect(existsSync(CHANNELS_HEALTH_YAML)).toBe(true);
  });

  it('schedule expression is exactly "*/5 * * * *" (5-min cadence)', () => {
    const yaml = readFileSync(CHANNELS_HEALTH_YAML, 'utf-8');
    expect(extractCronExpression(yaml)).toBe('*/5 * * * *');
  });

  it('curls the /api/cron/channels-health handler', () => {
    const yaml = readFileSync(CHANNELS_HEALTH_YAML, 'utf-8');
    expect(yaml).toMatch(/\/api\/cron\/channels-health/);
  });

  it('uses Authorization: Bearer with CRON_SECRET (matches /lib/cron-auth.ts gate)', () => {
    const yaml = readFileSync(CHANNELS_HEALTH_YAML, 'utf-8');
    expect(yaml).toMatch(/Authorization: Bearer \$CRON_SECRET/);
    expect(yaml).toMatch(/CRON_SECRET:\s*\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/);
  });

  it('uses VERCEL_DEPLOYMENT_URL secret for the base URL', () => {
    const yaml = readFileSync(CHANNELS_HEALTH_YAML, 'utf-8');
    expect(yaml).toMatch(/VERCEL_DEPLOYMENT_URL/);
  });

  it('uses --fail-with-body so non-2xx responses fail the workflow run', () => {
    const yaml = readFileSync(CHANNELS_HEALTH_YAML, 'utf-8');
    expect(yaml).toMatch(/--fail-with-body/);
  });
});

describe('FR-005 AC-005-1: cron-synthetic-ping.yml schedule pin', () => {
  it('workflow file exists at .github/workflows/cron-synthetic-ping.yml', () => {
    expect(existsSync(SYNTHETIC_PING_YAML)).toBe(true);
  });

  it('schedule expression is exactly "*/30 * * * *" (30-min cadence)', () => {
    const yaml = readFileSync(SYNTHETIC_PING_YAML, 'utf-8');
    expect(extractCronExpression(yaml)).toBe('*/30 * * * *');
  });

  it('curls the /api/cron/synthetic-ping handler', () => {
    const yaml = readFileSync(SYNTHETIC_PING_YAML, 'utf-8');
    expect(yaml).toMatch(/\/api\/cron\/synthetic-ping/);
  });

  it('uses Authorization: Bearer with CRON_SECRET (matches /lib/cron-auth.ts gate)', () => {
    const yaml = readFileSync(SYNTHETIC_PING_YAML, 'utf-8');
    expect(yaml).toMatch(/Authorization: Bearer \$CRON_SECRET/);
    expect(yaml).toMatch(/CRON_SECRET:\s*\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/);
  });

  it('uses VERCEL_DEPLOYMENT_URL secret for the base URL', () => {
    const yaml = readFileSync(SYNTHETIC_PING_YAML, 'utf-8');
    expect(yaml).toMatch(/VERCEL_DEPLOYMENT_URL/);
  });

  it('uses --fail-with-body so non-2xx responses fail the workflow run', () => {
    const yaml = readFileSync(SYNTHETIC_PING_YAML, 'utf-8');
    expect(yaml).toMatch(/--fail-with-body/);
  });
});

describe('FR-005 AC-005-2 amendment: vercel.json no longer declares sub-daily crons', () => {
  const VERCEL_JSON = join(REPO_ROOT, 'packages', 'dashboard', 'vercel.json');

  it('vercel.json exists', () => {
    expect(existsSync(VERCEL_JSON)).toBe(true);
  });

  it('vercel.json crons[] does NOT contain channels-health (moved to GH Actions)', () => {
    const json = readFileSync(VERCEL_JSON, 'utf-8');
    expect(json).not.toMatch(/channels-health/);
  });

  it('vercel.json crons[] does NOT contain synthetic-ping (moved to GH Actions)', () => {
    const json = readFileSync(VERCEL_JSON, 'utf-8');
    expect(json).not.toMatch(/synthetic-ping/);
  });

  it('vercel.json crons[] retains the daily entries (orphan-detect, audit-archive, cap-rollup)', () => {
    const json = readFileSync(VERCEL_JSON, 'utf-8');
    expect(json).toMatch(/orphan-detect/);
    expect(json).toMatch(/audit-archive/);
    expect(json).toMatch(/cap-rollup/);
  });
});
