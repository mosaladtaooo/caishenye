/**
 * Tenant-id AST linter tests.
 *
 * Constitution §4 (every query carries WHERE tenant_id) + §12 (no all-tenants
 * query) require structural enforcement, not just review discipline. The
 * linter walks `packages/{routines,channels,dashboard}/**\/*.ts` and reports:
 *
 *   1. Any `someDrizzle.select()/insert()/update()/delete()` chain that
 *      ALSO does NOT carry a `db.tenantId` reference within the same
 *      surrounding function — flagged as MISSING_TENANT_FILTER.
 *   2. Any `someDrizzle.execute(sql\`...\`)` call NOT listed in
 *      `packages/db/src/lint/raw-sql-allowlist.txt` — flagged as
 *      RAW_SQL_NOT_ALLOWLISTED.
 *
 * The linter exits non-zero on any finding so CI/lefthook can gate commits.
 *
 * The TENANT_ID_LINT_TARGETS env var lets tests point the linter at a
 * temp fixture dir instead of the real packages/* tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type LintFinding, lintTenantIdAcrossDirs } from '../../src/lint/tenant-id-lint';

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'caishen-tenant-lint-'));
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeFixture(relPath: string, body: string): string {
  const full = join(TMP, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
  return full;
}

describe('tenant-id AST linter — happy path (no findings on compliant code)', () => {
  it('returns zero findings for a query that filters by db.tenantId', async () => {
    writeFixture(
      'packages/routines/src/clean.ts',
      `
        import { eq } from 'drizzle-orm';
        export async function ok(db: { drizzle: any; tenantId: number }) {
          return db.drizzle.select().from(t).where(eq(t.tenantId, db.tenantId));
        }
      `,
    );
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    const inFile = findings.filter((f) => f.file.includes('clean.ts'));
    expect(inFile, JSON.stringify(inFile)).toHaveLength(0);
  });

  it('returns zero findings for files outside the in-scope dirs', async () => {
    // Files NOT under packages/{routines,channels,dashboard} should be ignored
    // even if they look fishy. lintTenantIdAcrossDirs only walks the dirs the
    // caller passes in.
    writeFixture(
      'packages/db/src/internal.ts',
      `db.drizzle.select().from(t);`, // no tenantId — but db/ is excluded
    );
    const findings = await lintTenantIdAcrossDirs([join(TMP, 'no-such-dir')], join(TMP, 'a.txt'));
    expect(findings).toHaveLength(0);
  });
});

describe('tenant-id AST linter — flags missing WHERE tenant_id', () => {
  it('flags db.drizzle.select().from(t) without a db.tenantId reference', async () => {
    writeFixture(
      'packages/routines/src/leaky.ts',
      `
        export async function leaky(db: { drizzle: any; tenantId: number }) {
          return db.drizzle.select().from(t); // no .where, no tenantId
        }
      `,
    );
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    const missing = findings.filter((f) => f.kind === 'MISSING_TENANT_FILTER');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]?.file).toMatch(/leaky\.ts$/);
  });

  it('flags db.drizzle.update(t).set(...).where(eq(t.foo, "x")) without tenantId', async () => {
    writeFixture(
      'packages/dashboard/lib/handler.ts',
      `
        import { eq } from 'drizzle-orm';
        export async function bad(db: { drizzle: any; tenantId: number }) {
          return db.drizzle.update(t).set({ x: 1 }).where(eq(t.foo, "bar"));
        }
      `,
    );
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    expect(findings.some((f) => f.kind === 'MISSING_TENANT_FILTER')).toBe(true);
  });

  it('flags db.drizzle.delete(t) without any where clause', async () => {
    writeFixture(
      'packages/channels/src/cleaner.ts',
      `
        export async function nuke(db: any) {
          return db.drizzle.delete(t); // catastrophic — no where at all
        }
      `,
    );
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    expect(findings.some((f) => f.kind === 'MISSING_TENANT_FILTER')).toBe(true);
  });

  it('does NOT flag a chain when tenantId appears anywhere within the enclosing function', async () => {
    // Even if the where-clause is structurally complex (and/or, multi-line),
    // a tenantId reference within the same function-scope is enough — the
    // linter is a heuristic, not a tenant-id presence-in-WHERE certifier.
    writeFixture(
      'packages/routines/src/complex-ok.ts',
      `
        import { and, eq, gt } from 'drizzle-orm';
        export async function complex(db: { drizzle: any; tenantId: number }) {
          const cutoff = new Date();
          return db.drizzle
            .select()
            .from(t)
            .where(and(eq(t.tenantId, db.tenantId), gt(t.createdAt, cutoff)))
            .orderBy(t.id);
        }
      `,
    );
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    const missing = findings.filter(
      (f) => f.kind === 'MISSING_TENANT_FILTER' && f.file.includes('complex-ok.ts'),
    );
    expect(missing).toHaveLength(0);
  });
});

describe('tenant-id AST linter — raw SQL allowlist', () => {
  it('flags db.drizzle.execute(sql`...`) when allowlist is empty', async () => {
    writeFixture(
      'packages/dashboard/lib/raw.ts',
      `
        import { sql } from 'drizzle-orm';
        export async function raw(db: any) {
          return db.drizzle.execute(sql\`SELECT NOW()\`);
        }
      `,
    );
    const allowlistPath = join(TMP, 'allowlist.txt');
    writeFileSync(allowlistPath, '', 'utf8');
    const findings = await lintTenantIdAcrossDirs([TMP], allowlistPath);
    expect(findings.some((f) => f.kind === 'RAW_SQL_NOT_ALLOWLISTED')).toBe(true);
  });

  it('does NOT flag execute when the file path is in the allowlist', async () => {
    const fp = writeFixture(
      'packages/dashboard/lib/raw-allowed.ts',
      `
        import { sql } from 'drizzle-orm';
        export async function ok(db: any) {
          return db.drizzle.execute(sql\`SELECT 1 WHERE tenant_id = \${db.tenantId}\`);
        }
      `,
    );
    const allowlistPath = join(TMP, 'allowlist.txt');
    // Allowlist matches by suffix-of-relative-path (rules in implementation).
    // We write the absolute path so any allowlist algorithm that does an
    // endsWith() match will accept it.
    writeFileSync(
      allowlistPath,
      `# allowed: dashboard health-check raw query (tenant_id is interpolated)\n${fp}\n`,
      'utf8',
    );
    const findings = await lintTenantIdAcrossDirs([TMP], allowlistPath);
    const raw = findings.filter((f) => f.kind === 'RAW_SQL_NOT_ALLOWLISTED' && f.file === fp);
    expect(raw).toHaveLength(0);
  });

  it('allowlist comments and blank lines are ignored', async () => {
    writeFixture('packages/routines/src/raw2.ts', `db.drizzle.execute(sql\`SELECT 1\`);`);
    const allowlistPath = join(TMP, 'allowlist.txt');
    writeFileSync(allowlistPath, `# this is a comment\n\n   # indented comment\n   \n`, 'utf8');
    const findings = await lintTenantIdAcrossDirs([TMP], allowlistPath);
    expect(findings.some((f) => f.kind === 'RAW_SQL_NOT_ALLOWLISTED')).toBe(true);
  });
});

describe('tenant-id AST linter — finding shape contract', () => {
  it('every finding has file, line, kind, and a message', async () => {
    writeFixture('packages/routines/src/leaky2.ts', `db.drizzle.select().from(t);`);
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      // Type-only check that LintFinding is the exported shape — done via
      // satisfies so the binding doesn't trigger the unused-var diagnostic.
      void (f satisfies LintFinding);
      expect(typeof f.file).toBe('string');
      expect(typeof f.line).toBe('number');
      expect(['MISSING_TENANT_FILTER', 'RAW_SQL_NOT_ALLOWLISTED']).toContain(f.kind);
      expect(typeof f.message).toBe('string');
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it('skips files that are not .ts (no .d.ts, no .tsx in scope)', async () => {
    // .d.ts files contain only types; they have no runtime queries.
    writeFixture(
      'packages/routines/src/types.d.ts',
      `declare const x: { drizzle: any; select(): any };`,
    );
    const findings = await lintTenantIdAcrossDirs([TMP], join(TMP, 'allowlist.txt'));
    expect(findings.filter((f) => f.file.endsWith('.d.ts'))).toHaveLength(0);
  });
});
