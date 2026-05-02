#!/usr/bin/env bash
#
# scripts/audit-no-api-key.sh — Constitution §1 + §13 enforcement
#
# Scans the working tree for the literal string "ANTHROPIC_API_KEY" (case-
# insensitive). Exits 0 if absent, non-zero (and reports offenders) otherwise.
#
# Invoked by:
#   - lefthook pre-commit hook (every commit)
#   - GitHub Actions CI (every push)
#   - `make audit-no-api-key` / `bun run audit:no-api-key` (local)
#
# Allowlist (paths permitted to reference the literal):
#   - .harness/**            (whole dir excluded via --exclude-dir below;
#                             constitution + PRD + feature contracts + criteria
#                             discuss the principle by name)
#   - See ALLOWLIST_REGEXES below for the file-level allowlist (gate's own
#     implementation files: this script, tests, lefthook/gitleaks/CI configs,
#     .env.example, n8n migration refs).
#
# Excluded directories (third-party / build output):
#   - node_modules, .git, .next, dist, build, .vercel, .cache, coverage
#
# Usage:
#   audit-no-api-key.sh [SCAN_ROOT]
#     SCAN_ROOT defaults to the current working directory (repo root).
#     Tests pass a tmp dir to verify behavior in isolation.

set -uo pipefail

PATTERN="ANTHROPIC_API_KEY"
SCAN_ROOT="${1:-.}"

if [[ ! -d "$SCAN_ROOT" ]]; then
  printf 'audit-no-api-key: scan root does not exist: %s\n' "$SCAN_ROOT" >&2
  exit 2
fi

# Build the grep exclusion arguments. We use --exclude-dir for directories
# (third-party + build output) and --exclude for individual files. Allowlist
# is enforced by ALSO running grep -L (list files NOT matching) on the
# whitelist subset — see below.
declare -a EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=.next
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=.vercel
  --exclude-dir=.cache
  --exclude-dir=coverage
  --exclude-dir=.worktrees
  --exclude-dir=.harness          # whole spec dir is allowlisted; see below
)

# Files whose names mean "this is allowed to mention the literal".
# We strip these from results post-grep to keep allowlist logic explicit.
# NOTE: we anchor the script's own path so a user-renamed copy still gets caught.
#
# Allowed because each file is part of the no-API-key gate's own implementation
# or documentation, and naturally has to reference the literal by name:
#   - The audit script itself (greps for it)
#   - Tests for the audit script (negative-test fixtures use the literal)
#   - lefthook.yml + .gitleaks.toml (configs that wire the gate)
#   - .github/workflows/ci.yml (CI mirror of the gate)
#   - .env.example (operator setup file — explains the rule)
#   - n8n migration JSON (read-only refs, immutable)
declare -a ALLOWLIST_REGEXES=(
  '/scripts/audit-no-api-key\.sh$'
  '/tests/audit-no-api-key\.test\.ts$'
  '/tests/lefthook-config\.test\.ts$'
  '/tests/gitleaks-config\.test\.ts$'
  '/tests/ci-workflow\.test\.ts$'
  '/lefthook\.yml$'
  '/\.gitleaks\.toml$'
  '/\.env\.example$'
  '/\.github/workflows/.*\.ya?ml$'
  '/财神爷 Agent\.json$'
  '/财神爷 schedule trigger\.json$'
)

# Run grep recursively. -n = line numbers, -i = case-insensitive (catches
# anthropic_api_key etc. — operator typos still leak), -I = skip binary,
# --include='*' = include everything else.
# Capture matches into an array. We use \0 separator to handle paths with
# spaces (the n8n JSON files have spaces in their names).
mapfile -t RAW_MATCHES < <(
  grep -RInIi "${EXCLUDE_DIRS[@]}" -- "$PATTERN" "$SCAN_ROOT" 2>/dev/null \
    || true
)

# Filter out allowlisted paths.
declare -a OFFENDERS=()
for line in "${RAW_MATCHES[@]}"; do
  # grep output: <path>:<lineno>:<content>
  # Extract just the path (everything up to the FIRST colon followed by digits).
  path_part="${line%%:[0-9]*}"

  allowed=0
  for re in "${ALLOWLIST_REGEXES[@]}"; do
    if [[ "$path_part" =~ $re ]]; then
      allowed=1
      break
    fi
  done

  if (( allowed == 0 )); then
    OFFENDERS+=("$line")
  fi
done

if (( ${#OFFENDERS[@]} == 0 )); then
  printf '%s: PASS — no ANTHROPIC_API_KEY references found in non-allowlisted files (constitution §1 + §13 OK)\n' "$(basename "$0")"
  exit 0
fi

printf '%s: FAIL — found %d ANTHROPIC_API_KEY reference(s) in non-allowlisted files:\n' "$(basename "$0")" "${#OFFENDERS[@]}" >&2
printf '\n' >&2
for offender in "${OFFENDERS[@]}"; do
  printf '  %s\n' "$offender" >&2
done
printf '\n' >&2
printf 'Constitution §1 prohibits this string anywhere in source. See:\n' >&2
printf '  .harness/spec/constitution.md  (§1 — NO ANTHROPIC_API_KEY ANYWHERE)\n' >&2
printf '  .harness/spec/prd.md            (FR-010 + AC-010-1)\n' >&2
printf '\n' >&2
printf 'Remove the references and re-run: bash %s\n' "$0" >&2
exit 1
