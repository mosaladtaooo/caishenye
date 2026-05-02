/**
 * Constitution §2 — Tier 1 prompt-preservation test (always runs in CI).
 *
 * Per AC-002-1 + AC-003-1 (proposal Round 2 R1):
 *   "A vitest CI test diffs the routine's deployed-prompt-source-of-truth
 *    file against `.harness/spec/preserve/{spartan,planner}-systemprompt.md`
 *    byte-for-byte. PASS = byte-identical (no smart-quote/CRLF/trailing-ws
 *    normalization)."
 *
 * Tier 1 (THIS test) — file-side: compares the .harness/spec/preserve/* source
 * of truth against the packages/routines/src/preserve-mirror/* mirror that
 * the routine creation tooling reads from when deploying.
 *
 * Tier 2 (separate file, conditional skip) — deployed-side: fetches the live
 * routine prompt via Anthropic API (if Spike 3 found a GET endpoint) and
 * byte-compares against the source of truth.
 *
 * Why TWO files:
 *   - .harness/spec/preserve/...  is the canonical source of truth (committed
 *     once, edited only via /harness:edit).
 *   - packages/routines/src/preserve-mirror/...  is a sync'd copy the
 *     routine deployment tooling reads (because routines/ is what gets
 *     packaged + sent to Anthropic). The mirror MUST equal the source.
 *
 * This test catches:
 *   - Smart-quote substitution (', ' vs ', ')
 *   - CRLF vs LF line endings
 *   - Trailing whitespace stripping by an editor
 *   - BOM injection
 *   - En/em dashes (-, --) replacing ASCII (-).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SPEC_DIR = join(REPO_ROOT, '.harness', 'spec', 'preserve');
const MIRROR_DIR = join(__dirname, '..', 'src', 'preserve-mirror');

interface PreserveFile {
  /** Friendly name for the test description. */
  name: string;
  /** File name (same in both directories). */
  filename: string;
  /** Which routine the file gets shipped to (for context in error messages). */
  routine: string;
}

const PRESERVED: PreserveFile[] = [
  {
    name: 'Spartan (Executor) system prompt',
    filename: 'spartan-systemprompt.md',
    routine: '财神爷-executor-{pair}',
  },
  {
    name: 'Planner system prompt',
    filename: 'planner-systemprompt.md',
    routine: '财神爷-planner',
  },
];

describe('Constitution §2 Tier 1: source-vs-mirror byte equality', () => {
  for (const p of PRESERVED) {
    describe(`${p.name} (${p.filename})`, () => {
      const specPath = join(SPEC_DIR, p.filename);
      const mirrorPath = join(MIRROR_DIR, p.filename);

      it('source-of-truth file exists at .harness/spec/preserve/', () => {
        expect(existsSync(specPath)).toBe(true);
      });

      it('mirror file exists at packages/routines/src/preserve-mirror/', () => {
        expect(existsSync(mirrorPath)).toBe(true);
      });

      it('spec and mirror are byte-identical', () => {
        const spec = readFileSync(specPath);
        const mirror = readFileSync(mirrorPath);
        // Diff message includes the routine name + lengths so a CI failure
        // makes the operator's recovery obvious.
        const cmp = Buffer.compare(spec, mirror);
        if (cmp !== 0) {
          throw new Error(
            `[constitution §2] ${p.name} source ↔ mirror byte-mismatch.\n` +
              `  spec:   ${specPath} (${spec.length} bytes)\n` +
              `  mirror: ${mirrorPath} (${mirror.length} bytes)\n` +
              `  Routine: ${p.routine}\n` +
              `  Recovery: \`bun run preserve-mirror-sync\` will copy spec → mirror.`,
          );
        }
        expect(cmp).toBe(0);
      });

      it('mirror does NOT contain curly quotes (positive Unicode-normalization guard)', () => {
        const mirror = readFileSync(mirrorPath, 'utf-8');
        // Smart quotes — the IDE auto-replacement that breaks the prompt.
        // The source-of-truth files use straight ASCII quotes; smart quotes
        // appearing in the mirror = silent normalization that broke the IP.
        expect(mirror.includes('“')).toBe(false); // left double quote
        expect(mirror.includes('”')).toBe(false); // right double quote
        expect(mirror.includes('‘')).toBe(false); // left single quote
        expect(mirror.includes('’')).toBe(false); // right single quote
      });

      // NOTE: en/em-dashes are ALLOWED in the source-of-truth files — the
      // operator wrote some intentionally (e.g., em-dash separators in the
      // SPARTAN prompt). Guarding against them here would break verbatim
      // preservation. The byte-equality test above is the load-bearing
      // guard; it catches any Unicode-normalization regression including
      // dashes substituted IN ONE FILE BUT NOT THE OTHER.
      it('em-dash count is consistent between spec and mirror', () => {
        const spec = readFileSync(specPath, 'utf-8');
        const mirror = readFileSync(mirrorPath, 'utf-8');
        const specEm = (spec.match(/—/g) ?? []).length;
        const mirrorEm = (mirror.match(/—/g) ?? []).length;
        expect(mirrorEm).toBe(specEm);
      });

      it('mirror does NOT contain a BOM', () => {
        const mirror = readFileSync(mirrorPath);
        expect(mirror[0]).not.toBe(0xef);
      });

      it('mirror uses LF line endings (no CRLF)', () => {
        const mirror = readFileSync(mirrorPath, 'utf-8');
        expect(mirror.includes('\r\n')).toBe(false);
      });
    });
  }
});

describe('Constitution §2 Tier 1: prompt loader API', () => {
  it('loads each prompt as a string via the prompt-loader module', async () => {
    const { loadSystemPrompt } = await import('../src/prompt-loader');
    expect(typeof loadSystemPrompt).toBe('function');
    const planner = loadSystemPrompt('planner');
    expect(typeof planner).toBe('string');
    expect(planner.length).toBeGreaterThan(100);
    const spartan = loadSystemPrompt('executor');
    expect(typeof spartan).toBe('string');
    expect(spartan.length).toBeGreaterThan(1000); // SPARTAN is long
  });

  it('throws when asked for an unknown role', async () => {
    const { loadSystemPrompt } = await import('../src/prompt-loader');
    expect(() => (loadSystemPrompt as (r: string) => string)('unknown-role')).toThrow(
      /role|prompt|unknown/i,
    );
  });

  it('returned prompt is byte-identical to the mirror file (no string-level normalization)', async () => {
    const { loadSystemPrompt } = await import('../src/prompt-loader');
    const planner = loadSystemPrompt('planner');
    const mirrorPlanner = readFileSync(join(MIRROR_DIR, 'planner-systemprompt.md'), 'utf-8');
    expect(planner).toBe(mirrorPlanner);
  });
});
