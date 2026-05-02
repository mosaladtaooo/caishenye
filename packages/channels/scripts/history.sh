#!/usr/bin/env bash
# /history — last 10 executor outcomes (most recent first).
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Inputs: CAISHEN_TENANT_ID + DATABASE_URL.
# Output: Markdown table.

set -euo pipefail

: "${CAISHEN_TENANT_ID:?CAISHEN_TENANT_ID env var required}"
: "${DATABASE_URL:?DATABASE_URL env var required}"

cat <<EOF
*Recent executor outcomes — last 10*

| When (GMT) | Pair | Session | Action |
|---|---|---|---|
EOF

psql "$DATABASE_URL" -A -F'|' -c "
  SELECT to_char(created_at, 'MM-DD HH24:MI'),
         pair,
         session,
         coalesce(action_taken, '(none)')
  FROM executor_reports
  WHERE tenant_id = ${CAISHEN_TENANT_ID}
  ORDER BY created_at DESC
  LIMIT 10;
" | awk -F'|' 'NF==4 { printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }'
