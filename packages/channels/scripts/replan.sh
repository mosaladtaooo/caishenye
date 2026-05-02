#!/usr/bin/env bash
# /replan — force a fresh Planner fire via the dashboard's /api/overrides/replan
# (R3-followup split-tx flow lives server-side; this script is just the entry
# point that obtains a CSRF token + POSTs).
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Optional flag: --force (passes confirm_low_cap=true; lets the operator
# proceed when remaining slots are <=2). Without --force, the dashboard
# returns 409 if cap remaining <=2 and the operator can re-issue with --force.
#
# Inputs: DASHBOARD_BASE_URL + CHANNELS_API_BEARER.
# Output: Markdown confirmation with new anthropic_one_off_id.

set -euo pipefail

: "${DASHBOARD_BASE_URL:?DASHBOARD_BASE_URL env var required}"
: "${CHANNELS_API_BEARER:?CHANNELS_API_BEARER env var required}"

force_flag=false
if [ "${1:-}" = "--force" ]; then
  force_flag=true
fi

csrf=$(curl -fsSL --max-time 5 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -c /tmp/caishen-bot-cookie.txt \
  "${DASHBOARD_BASE_URL%/}/api/csrf" | jq -r '.csrf // empty')

if [ -z "$csrf" ]; then
  echo "*replan — error*"
  echo "Could not obtain CSRF token."
  exit 0
fi

body=$(jq -nc --arg csrf "$csrf" --argjson force "$force_flag" \
  '{csrf: $csrf} + (if $force then {confirm_low_cap: true} else {} end)')

resp=$(curl -sSL --max-time 35 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -H "Content-Type: application/json" \
  -b /tmp/caishen-bot-cookie.txt \
  -w "\n__HTTP_STATUS:%{http_code}" \
  -X POST \
  -d "$body" \
  "${DASHBOARD_BASE_URL%/}/api/overrides/replan" 2>&1) || true

http_status=$(echo "$resp" | grep -o '__HTTP_STATUS:.*' | cut -d: -f2)
body_only=$(echo "$resp" | sed -e '/__HTTP_STATUS:/d')

case "$http_status" in
  200)
    one_off=$(echo "$body_only" | jq -r '.anthropicOneOffId // "—"')
    echo "*replan — confirmed*"
    echo
    echo "Planner fired. New anthropic_one_off_id: ${one_off}"
    ;;
  409)
    cap=$(echo "$body_only" | jq -r '.capRemaining // 0')
    echo "*replan — cap warning*"
    echo
    echo "Only ${cap} cap slots remain today. Re-issue with /replan --force to confirm."
    ;;
  *)
    err=$(echo "$body_only" | jq -r '.error // "unknown"')
    echo "*replan — failed (HTTP ${http_status})*"
    echo "${err}" | head -c 240
    ;;
esac
