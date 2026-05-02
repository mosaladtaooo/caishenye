/**
 * Tenant-id AST linter.
 *
 * Constitution §4: every operator-data query MUST filter by tenant_id.
 * Constitution §12: no all-tenants query — even cross-tenant analytics MUST
 * iterate per-tenant.
 *
 * The linter walks `packages/{routines,channels,dashboard}/**\/*.ts` (the
 * application code; `packages/db/` is excluded because that's where the
 * tenant-scoped helpers ARE) and reports two kinds of finding:
 *
 *   1. MISSING_TENANT_FILTER — a `someDrizzle.select()/insert()/update()/
 *      delete()` chain whose enclosing function does NOT reference
 *      `.tenantId` anywhere (a heuristic — the helper either passes the
 *      tenantId via the WHERE chain or via a parameter to a helper).
 *   2. RAW_SQL_NOT_ALLOWLISTED — `someDrizzle.execute(sql\`...\`)` whose
 *      file path is not present in the raw-SQL allowlist file.
 *
 * The allowlist format: one path per line; lines starting with `#` and
 * blank lines are ignored. Each entry is matched as a SUFFIX of the file's
 * absolute path (so the allowlist can use either repo-relative or absolute
 * paths). Each allowlist entry SHOULD have a comment justifying the
 * exemption (the linter doesn't enforce the comment shape; the constitution
 * does).
 *
 * Exit code: zero if findings.length === 0, non-zero otherwise. The `bun
 * run lint:tenant-id` pre-commit step uses the exit code; the lefthook
 * config will gate commits on it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface LintFinding {
  /** Absolute path to the offending file. */
  file: string;
  /** 1-based source line number. */
  line: number;
  /** Discriminator. */
  kind: 'MISSING_TENANT_FILTER' | 'RAW_SQL_NOT_ALLOWLISTED';
  /** Human-readable description of the finding. */
  message: string;
}

/**
 * Walk one or more directories collecting `.ts` files (excluding `.d.ts`
 * and `.tsx` since v1 dashboard code is plain `.ts` for the route handlers
 * and the React components are out of scope for query-pattern lint).
 */
function collectTsFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    walk(root);
  }
  return out;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // missing dir => no contribution
    }
    for (const name of entries) {
      if (
        name === 'node_modules' ||
        name === '.next' ||
        name === 'dist' ||
        name === '.turbo' ||
        name === '.vercel'
      ) {
        continue;
      }
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (name.endsWith('.d.ts')) continue;
      if (!name.endsWith('.ts')) continue;
      out.push(full);
    }
  }
}

/**
 * Parse the allowlist file. Returns an array of suffix-match strings.
 */
function readAllowlist(allowlistPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(allowlistPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    out.push(trimmed);
  }
  return out;
}

function isAllowlisted(filePath: string, allowlist: readonly string[]): boolean {
  const norm = normalisePath(filePath);
  for (const entry of allowlist) {
    const e = normalisePath(entry);
    if (norm === e) return true;
    if (norm.endsWith(e)) return true;
  }
  return false;
}

function normalisePath(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Walk the AST of a single source file, surfacing findings.
 */
function lintSourceFile(
  filePath: string,
  source: ts.SourceFile,
  allowlist: readonly string[],
): LintFinding[] {
  const findings: LintFinding[] = [];

  /**
   * Visit each node. When we see a CallExpression on `.select / .insert /
   * .update / .delete / .execute`, we walk up to the enclosing function-
   * like declaration. Then:
   *   - For select/insert/update/delete: scan the function body for any
   *     occurrence of `.tenantId`. If absent, flag MISSING_TENANT_FILTER.
   *   - For execute: check the allowlist; if not present, flag
   *     RAW_SQL_NOT_ALLOWLISTED.
   *
   * The .tenantId scan is intentionally permissive: a single `.tenantId`
   * reference inside the same function passes. Defense-in-depth lives at
   * the WHERE-clause check during code review.
   */
  visit(source);
  return findings;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        const methodName = expr.name.text;
        if (
          methodName === 'select' ||
          methodName === 'insert' ||
          methodName === 'update' ||
          methodName === 'delete'
        ) {
          checkQueryCall(node);
        } else if (methodName === 'execute') {
          checkExecuteCall(node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  function checkQueryCall(node: ts.CallExpression): void {
    const fn = findEnclosingFunction(node);
    const scopeNode: ts.Node = fn ?? source;
    if (!referencesTenantId(scopeNode)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({
        file: filePath,
        line: line + 1,
        kind: 'MISSING_TENANT_FILTER',
        message:
          'query chain does not reference `.tenantId` anywhere in its enclosing function — constitution §4 requires every query to filter by tenant_id',
      });
    }
  }

  function checkExecuteCall(node: ts.CallExpression): void {
    if (isAllowlisted(filePath, allowlist)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({
      file: filePath,
      line: line + 1,
      kind: 'RAW_SQL_NOT_ALLOWLISTED',
      message:
        'raw SQL execute() not in allowlist — add the file to packages/db/src/lint/raw-sql-allowlist.txt with a justifying comment',
    });
  }

  function findEnclosingFunction(node: ts.Node): ts.Node | undefined {
    let n: ts.Node | undefined = node.parent;
    while (n) {
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n)
      ) {
        return n;
      }
      n = n.parent;
    }
    return undefined;
  }

  function referencesTenantId(scope: ts.Node): boolean {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      // Skip type-annotation subtrees: `db: { tenantId: number }` type-shape
      // mentions of tenantId don't count as runtime references.
      if (
        ts.isTypeNode(n) ||
        ts.isTypeReferenceNode(n) ||
        ts.isTypeLiteralNode(n) ||
        ts.isPropertySignature(n) // `tenantId: number` inside a type literal
      ) {
        return;
      }
      // The name in a parameter declaration `(db, tenantId)` is a runtime
      // identifier. But `db: { tenantId: ... }` — the inner `tenantId` is a
      // PropertySignature.name we just skipped. So plain Identifier check is
      // safe AFTER the type-node skip.
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'tenantId') {
        found = true;
        return;
      }
      // Object literal property `{ tenantId: x }` inside a values() call is
      // ALSO a positive — counts as a runtime tenantId reference.
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'tenantId') {
        found = true;
        return;
      }
      // Shorthand `{ tenantId }` — also positive.
      if (
        ts.isShorthandPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'tenantId'
      ) {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(scope);
    return found;
  }
}

/**
 * Public entry point. Walks every passed directory, parses each .ts file,
 * and returns the merged finding list. The CLI wrapper (below) prints +
 * exits non-zero.
 */
export async function lintTenantIdAcrossDirs(
  roots: readonly string[],
  allowlistPath: string,
): Promise<LintFinding[]> {
  const files = collectTsFiles(roots);
  const allowlist = readAllowlist(allowlistPath);
  const findings: LintFinding[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    findings.push(...lintSourceFile(file, sf, allowlist));
  }
  return findings;
}

/**
 * Default in-repo target dirs the CLI scans. Tests pass their own dirs.
 */
export const DEFAULT_TARGETS: readonly string[] = [
  'packages/routines',
  'packages/channels',
  'packages/dashboard',
];

export const DEFAULT_ALLOWLIST = 'packages/db/src/lint/raw-sql-allowlist.txt';

declare global {
  interface ImportMeta {
    main?: boolean;
  }
}

if (import.meta.main === true) {
  const repoRoot = process.cwd();
  const targets = DEFAULT_TARGETS.map((p) => (isAbsolute(p) ? p : resolve(repoRoot, p)));
  const allowlist = isAbsolute(DEFAULT_ALLOWLIST)
    ? DEFAULT_ALLOWLIST
    : resolve(repoRoot, DEFAULT_ALLOWLIST);
  lintTenantIdAcrossDirs(targets, allowlist)
    .then((findings) => {
      if (findings.length === 0) {
        process.stdout.write('tenant-id-lint: 0 findings\n');
        return;
      }
      const sep_ = sep === '\\' ? '/' : '/';
      for (const f of findings) {
        process.stderr.write(
          `${f.file.replaceAll('\\', sep_)}:${f.line}: [${f.kind}] ${f.message}\n`,
        );
      }
      process.stderr.write(`tenant-id-lint: ${findings.length} finding(s)\n`);
      process.exit(1);
    })
    .catch((e) => {
      process.stderr.write(`tenant-id-lint: failed: ${(e as Error).message}\n`);
      process.exit(2);
    });
}
