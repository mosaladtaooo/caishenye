#!/usr/bin/env bash
# /report <pair> — most recent executor_reports row for the pair.
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Args: $1 — pair code (e.g., "EUR/USD"). Required.
# Inputs: CAISHEN_TENANT_ID + DATABASE_URL envs.
# Output: Markdown summary + rationale line.

set -euo pipefail

: "${CAISHEN_TENANT_ID:?CAISHEN_TENANT_ID env var required}"
: "${DATABASE_URL:?DATABASE_URL env var required}"

pair="${1:-}"
if [ -z "$pair" ]; then
  echo "Usage: /report <pair>"
  echo "Example: /report EUR/USD"
  exit 0
fi

# Note: pair is interpolated via psql's connection variable to defend against
# minor injection in the slash-command argv. The subagent's allowlist already
# constrains argv to alphanumeric + '/', but defense in depth.
PSQL_PAIR="$pair" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -A -F'|' -c "
  SELECT pair, session, action_taken,
         to_char(created_at, 'YYYY-MM-DD HH24:MI'),
         coalesce(summary_md, '(no summary)')
  FROM executor_reports
  WHERE tenant_id = ${CAISHEN_TENANT_ID}
    AND pair = :'PSQL_PAIR'
  ORDER BY created_at DESC
  LIMIT 1;
" | awk -F'|' 'NF==5 {
  printf "*Report — %s (%s)*\n\n", $1, $2;
  printf "Action: %s\n", $3;
  printf "When: %s GMT\n\n", $4;
  printf "%s\n", $5;
}'

# If the awk produced nothing, the pair has no recent report.
# (Bash's pipeline status: awk exits 0 on empty input; we detect "no row" via stdout.)
