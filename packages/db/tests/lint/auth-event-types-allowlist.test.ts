/**
 * W4 (FR-023 EC-023-2 watch-item) -- enumerate allowed event_type values
 * for the routine_runs auth-audit rows so a typo like
 * 'auth_counter_regresion' would fail CI.
 *
 * Pure-Node implementation (no shell-out): walks
 * `packages/dashboard/lib` and `packages/dashboard/app` looking for the
 * literal pattern `event_type: 'X'` and asserts every X is in the
 * allowlist.
 *
 * The contract: writeAuthAuditRow accepts string event_type values, and
 * the routes pin two literals:
 *   'auth_counter_regression'  (FR-023 EC-023-2)
 *   'auth_bad_signature'       (FR-025 EC-025-2)
 *
 * Why a string allowlist (vs a TypeScript union): the writer signature is
 * intentionally string for forward-compat (multi-tenant rollout could add
 * new event_types via Drizzle migration without a codegen step). The
 * tradeoff is this lint test as the discipline layer.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALLOWED_EVENT_TYPES = new Set<string>(['auth_bad_signature', 'auth_counter_regression']);

function walk(dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.next') continue;
    const full = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, files);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
}

function findEventTypeLiterals(roots: string[]): Set<string> {
  const found = new Set<string>();
  const files: string[] = [];
  for (const r of roots) walk(r, files);
  const re = /event_type:\s*['"]([a-zA-Z0-9_]+)['"]/g;
  for (const f of files) {
    let src = '';
    try {
      src = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    if (f.endsWith('auth-event-types-allowlist.test.ts')) continue;
    let m: RegExpExecArray | null = re.exec(src);
    while (m !== null) {
      const v = m[1];
      if (typeof v === 'string') found.add(v);
      m = re.exec(src);
    }
  }
  return found;
}

describe('routine_runs auth event_type allowlist (W4)', () => {
  it('every event_type literal in dashboard auth code is in the allowlist', () => {
    // tests file is at packages/db/tests/lint/X.test.ts; project root is 3 levels up.
    const projectRoot = resolve(__dirname, '..', '..', '..', '..');
    const dashboardRoots = [
      join(projectRoot, 'packages', 'dashboard', 'lib'),
      join(projectRoot, 'packages', 'dashboard', 'app'),
    ];
    const found = findEventTypeLiterals(dashboardRoots);

    for (const evt of found) {
      expect(
        ALLOWED_EVENT_TYPES.has(evt),
        `event_type literal '${evt}' is NOT in the allowlist; either fix the typo or extend ALLOWED_EVENT_TYPES`,
      ).toBe(true);
    }
  });

  it('the allowlist exposes the two v1.2-shipped event types', () => {
    expect(ALLOWED_EVENT_TYPES.has('auth_bad_signature')).toBe(true);
    expect(ALLOWED_EVENT_TYPES.has('auth_counter_regression')).toBe(true);
  });
});
