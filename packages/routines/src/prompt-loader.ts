/**
 * Constitution §2 — Prompt loader.
 *
 * Reads the verbatim trading IP from the preserve-mirror (which is byte-
 * identical to .harness/spec/preserve/ per the Tier 1 test). Returns the
 * prompt as a string with NO post-processing — no smart-quote substitution,
 * no whitespace normalization, no template-variable interpolation. The
 * caller (Planner / Executor routine body) hands this string verbatim to
 * Anthropic.
 *
 * Why mirror not direct .harness/spec/?
 *   - When the routine is deployed (bun build / bun publish), the package
 *     output bundle does not include .harness/. The mirror is INSIDE the
 *     package (src/preserve-mirror/) so it ships with the deployed code.
 *   - The Tier 1 prompt-preserve test verifies mirror == spec on every
 *     commit; if the operator edits .harness/spec/preserve/ they MUST run
 *     `bun run preserve-mirror-sync` (or the pre-commit hook will fail).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PromptRole = 'planner' | 'executor';

const FILE_FOR_ROLE: Record<PromptRole, string> = {
  planner: 'planner-systemprompt.md',
  // SPARTAN prompt → executor routine
  executor: 'spartan-systemprompt.md',
};

/** Reads the system prompt for the given role from the mirror. */
export function loadSystemPrompt(role: PromptRole): string {
  const filename = FILE_FOR_ROLE[role];
  if (!filename) {
    throw new Error(
      `prompt-loader: unknown role "${role}". Valid roles: ${Object.keys(FILE_FOR_ROLE).join(', ')}`,
    );
  }
  const path = join(__dirname, 'preserve-mirror', filename);
  // Read as UTF-8 — caller compares bytes via Buffer.compare elsewhere; for
  // the loader's typical use case (passing to Anthropic as `system` field)
  // a string is what's needed.
  return readFileSync(path, 'utf-8');
}
