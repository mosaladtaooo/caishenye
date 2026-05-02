#!/usr/bin/env bash
#
# scripts/gitleaks-protect.sh — Constitution §10 (secret scan) wrapper
#
# Called from lefthook pre-commit (see lefthook.yml). Skips gracefully when
# gitleaks isn't installed locally — CI always enforces, so missing-locally
# is a soft warning, not a blocking error.
#
# Exit codes:
#   0  scan ran AND found nothing OR gitleaks not installed locally
#   1  gitleaks found leaks (lefthook blocks the commit)
#   2  gitleaks ran but failed unexpectedly (e.g., bad config)

set -uo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks: not installed locally — CI will enforce. Skipping."
  exit 0
fi

gitleaks protect --staged --source . --redact --verbose
status=$?

case "$status" in
  0) exit 0 ;;
  1) exit 1 ;;
  *) echo "gitleaks: unexpected exit $status" >&2; exit 2 ;;
esac
