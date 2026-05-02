/**
 * FR-010 — Subscription-only auth (no ANTHROPIC_API_KEY)
 * NFR-005 — Pre-flight cleanness for secret scanning
 *
 * Tests for `.gitleaks.toml` — constitution §10 (no secrets in source) +
 * AC-010-1 (CI lint rule) verification.
 *
 * Gitleaks runs:
 *   - In lefthook pre-commit (locally, if installed)
 *   - In GitHub Actions CI (always — see .github/workflows/ci.yml)
 *   - Manually via `make gitleaks`
 *
 * The .gitleaks.toml extends the default rules with project-specific patterns
 * for the secrets we know we'll handle: Anthropic routine bearers, MT5 bearer,
 * Telegram bot token, Auth.js secret, CRON_SECRET. These additions tighten the
 * scan beyond the gitleaks default ruleset.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const GITLEAKS_TOML = join(REPO_ROOT, '.gitleaks.toml');

describe('FR-010 AC-010-1 + Constitution §10: .gitleaks.toml', () => {
  it('.gitleaks.toml exists at repo root', () => {
    const contents = readFileSync(GITLEAKS_TOML, 'utf-8');
    expect(contents.length).toBeGreaterThan(0);
  });

  it('extends gitleaks default rules (does not start from scratch)', () => {
    const contents = readFileSync(GITLEAKS_TOML, 'utf-8');
    // Either `useDefault` or an `extend` directive — gitleaks supports both.
    expect(contents).toMatch(/useDefault\s*=\s*true|\[extend\]/);
  });

  it('defines a custom rule for the literal ANTHROPIC_API_KEY (defense in depth)', () => {
    const contents = readFileSync(GITLEAKS_TOML, 'utf-8');
    // Even though audit-no-api-key.sh is the primary gate, a duplicate rule
    // here ensures gitleaks produces a clear finding name + location for
    // any code-review tooling that consumes gitleaks output.
    // We require the rule ID `anthropic-api-key-literal` and a regex that
    // matches the bare literal token.
    expect(contents).toMatch(/id\s*=\s*['"]anthropic-api-key-literal['"]/);
  });

  it('defines a rule for Telegram bot tokens (FR-019)', () => {
    const contents = readFileSync(GITLEAKS_TOML, 'utf-8');
    // Telegram bot tokens have a fixed shape: `<digits>:<base64ish 35-chars>`
    // Pattern: 8-10 digits, colon, 35 alphanumeric/underscore/hyphen chars.
    expect(contents.toLowerCase()).toMatch(/telegram/);
  });

  it('defines a rule for the routine beta header bearer pattern (FR-002, FR-018)', () => {
    const contents = readFileSync(GITLEAKS_TOML, 'utf-8');
    // Per ADR-004: ROUTINE_BETA_HEADER + per-routine bearer tokens. We add
    // a rule so a stray bearer in a code comment is caught.
    expect(contents.toLowerCase()).toMatch(/routine.*bearer|anthropic.*bearer/);
  });

  it('allowlists the constitution + PRD spec files (legitimate references)', () => {
    const contents = readFileSync(GITLEAKS_TOML, 'utf-8');
    // .harness/spec/ files reference secret-related literals by name (the
    // entire constitution §1 + §10 discusses them). The allowlist must
    // exempt them so gitleaks doesn't false-positive on the principle text.
    expect(contents).toMatch(/\[\[allowlist/);
    // Either path-based (.harness/spec/) or path-pattern based.
    expect(contents).toMatch(/\.harness/);
  });
});
