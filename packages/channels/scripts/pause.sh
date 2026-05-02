#!/usr/bin/env bash
# /pause — flip agent_state.paused_bool=true + cancel today's not-yet-fired
# pair_schedules. Calls dashboard /api/overrides/pause.
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Inputs: DASHBOARD_BASE_URL + CHANNELS_API_BEARER.
# Output: Markdown confirmation.

set -euo pipefail

: "${DASHBOARD_BASE_URL:?DASHBOARD_BASE_URL env var required}"
: "${CHANNELS_API_BEARER:?CHANNELS_API_BEARER env var required}"

csrf=$(curl -fsSL --max-time 5 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -c /tmp/caishen-bot-cookie.txt \
  "${DASHBOARD_BASE_URL%/}/api/csrf" | jq -r '.csrf // empty')

if [ -z "$csrf" ]; then
  echo "*pause — error*"
  echo "Could not obtain CSRF token."
  exit 0
fi

resp=$(curl -fsSL --max-time 10 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -H "Content-Type: application/json" \
  -b /tmp/caishen-bot-cookie.txt \
  -X POST \
  -d "$(jq -nc --arg csrf "$csrf" '{csrf: $csrf}')" \
  "${DASHBOARD_BASE_URL%/}/api/overrides/pause" 2>&1) || {
  echo "*pause — error*"
  echo "${resp}" | head -c 240
  exit 0
}

ok=$(echo "$resp" | jq -r '.ok // false')
if [ "$ok" = "true" ]; then
  echo "*pause — confirmed*"
  echo
  echo "Agent paused. Today's not-yet-fired schedules cancelled."
else
  err=$(echo "$resp" | jq -r '.error // "unknown"')
  echo "*pause — failed*"
  echo "${err}" | head -c 240
fi
