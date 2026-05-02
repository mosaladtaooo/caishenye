#!/usr/bin/env bash
#
# scripts/preserve-mirror-sync.sh — Constitution §2 mirror sync.
#
# Copies .harness/spec/preserve/{spartan,planner}-systemprompt.md byte-for-byte
# to packages/routines/src/preserve-mirror/. Run AFTER editing the source-of-
# truth files; the Tier 1 prompt-preserve test (constitution §2 always-on
# guard) will fail otherwise.
#
# This is also called from the operator's pre-deploy checklist
# (docs/operator-pre-deploy-checklist.md step 2).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC_DIR="$REPO_ROOT/.harness/spec/preserve"
MIRROR_DIR="$REPO_ROOT/packages/routines/src/preserve-mirror"

if [[ ! -d "$SPEC_DIR" ]]; then
  printf 'preserve-mirror-sync: %s does not exist\n' "$SPEC_DIR" >&2
  exit 2
fi

mkdir -p "$MIRROR_DIR"

for f in spartan-systemprompt.md planner-systemprompt.md; do
  src="$SPEC_DIR/$f"
  dst="$MIRROR_DIR/$f"
  if [[ ! -f "$src" ]]; then
    printf 'preserve-mirror-sync: missing source %s\n' "$src" >&2
    exit 2
  fi
  cp -p "$src" "$dst"
  printf 'preserve-mirror-sync: %s → %s\n' "$src" "$dst"
done

printf 'preserve-mirror-sync: OK (run `bun --filter @caishen/routines test:run tests/prompt-preserve.test.ts` to verify)\n'
