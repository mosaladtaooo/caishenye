#!/usr/bin/env bash
# /closepair <pair> — close all open positions for a single pair.
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Args: $1 — pair code (e.g., "EUR/USD"). Required.
# Inputs: DASHBOARD_BASE_URL + CHANNELS_API_BEARER.
# Output: Markdown confirmation + audit row id.

set -euo pipefail

: "${DASHBOARD_BASE_URL:?DASHBOARD_BASE_URL env var required}"
: "${CHANNELS_API_BEARER:?CHANNELS_API_BEARER env var required}"

pair="${1:-}"
if [ -z "$pair" ]; then
  echo "Usage: /closepair <pair>"
  echo "Example: /closepair EUR/USD"
  exit 0
fi

csrf=$(curl -fsSL --max-time 5 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -c /tmp/caishen-bot-cookie.txt \
  "${DASHBOARD_BASE_URL%/}/api/csrf" | jq -r '.csrf // empty')

if [ -z "$csrf" ]; then
  echo "*close-pair ${pair} — error*"
  echo
  echo "Could not obtain CSRF token."
  exit 0
fi

resp=$(curl -fsSL --max-time 10 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -H "Content-Type: application/json" \
  -b /tmp/caishen-bot-cookie.txt \
  -X POST \
  -d "$(jq -nc --arg pair "$pair" --arg csrf "$csrf" '{pair: $pair, csrf: $csrf}')" \
  "${DASHBOARD_BASE_URL%/}/api/overrides/close-pair" 2>&1) || {
  echo "*close-pair ${pair} — error*"
  echo
  echo "${resp}" | head -c 240
  exit 0
}

ok=$(echo "$resp" | jq -r '.ok // false')
override_id=$(echo "$resp" | jq -r '.overrideActionId // "—"')

if [ "$ok" = "true" ]; then
  echo "*close-pair ${pair} — confirmed*"
  echo
  echo "Audit: override_actions.id=${override_id}"
else
  err=$(echo "$resp" | jq -r '.error // "unknown"')
  echo "*close-pair ${pair} — failed*"
  echo
  echo "${err}" | head -c 240
fi
