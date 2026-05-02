#!/usr/bin/env bash
# /status — dump today's pair_schedules + agent_state.
#
# Operator-managed: this script is OUTSIDE the subagent's Write allowlist
# (R2). Editing it requires VPS shell access.
#
# Inputs: CAISHEN_TENANT_ID env (required), DATABASE_URL env (required).
# Output: Markdown to stdout that the subagent passes verbatim to Telegram.

set -euo pipefail

: "${CAISHEN_TENANT_ID:?CAISHEN_TENANT_ID env var required}"
: "${DATABASE_URL:?DATABASE_URL env var required}"

today=$(date -u +%Y-%m-%d)

cat <<EOF
*Status — ${today}*

EOF

# pair_schedules for today.
psql "$DATABASE_URL" -A -F'|' -c "
  SELECT pair_code,
         session_name,
         to_char(start_time_gmt, 'HH24:MI'),
         status
  FROM pair_schedules
  WHERE tenant_id = ${CAISHEN_TENANT_ID}
    AND date = '${today}'
  ORDER BY start_time_gmt NULLS LAST, pair_code;
" | awk -F'|' 'BEGIN { print "| Pair | Session | Start (GMT) | Status |"; print "|------|---------|-------------|--------|" } NF==4 { printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }'

echo

# agent_state.
psql "$DATABASE_URL" -A -t -c "
  SELECT 'Paused: ' || paused_bool::text ||
         CASE WHEN paused_bool THEN ' (since ' || to_char(paused_at, 'YYYY-MM-DD HH24:MI:SS') || ')' ELSE '' END
  FROM agent_state
  WHERE tenant_id = ${CAISHEN_TENANT_ID};
"
