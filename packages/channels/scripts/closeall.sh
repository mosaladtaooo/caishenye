#!/usr/bin/env bash
# /closeall — close ALL open MT5 positions (calls the dashboard's
# /api/overrides/close-all behind the curtain so the override audit trail
# (override_actions table) is the single source of truth — see R4 7-step
# flow + AC-016-2).
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Inputs:
#   DASHBOARD_BASE_URL    — e.g., https://caishen.vercel.app
#   CHANNELS_API_BEARER   — bot-side bearer used in lieu of an Auth.js cookie;
#                            the dashboard middleware allowlists this for the
#                            `/api/overrides/*` paths under role=channels-bot.
# Output: Markdown confirmation + audit row id.

set -euo pipefail

: "${DASHBOARD_BASE_URL:?DASHBOARD_BASE_URL env var required}"
: "${CHANNELS_API_BEARER:?CHANNELS_API_BEARER env var required}"

# Dashboard's POST /api/overrides/close-all requires a CSRF token + the literal
# confirmation string per AC-016-2. Bot path: do a GET /api/csrf for the
# token first, then POST.
csrf=$(curl -fsSL --max-time 5 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -c /tmp/caishen-bot-cookie.txt \
  "${DASHBOARD_BASE_URL%/}/api/csrf" | jq -r '.csrf // empty')

if [ -z "$csrf" ]; then
  echo "*close-all — error*"
  echo
  echo "Could not obtain CSRF token from dashboard."
  exit 0
fi

resp=$(curl -fsSL --max-time 10 \
  -H "Authorization: Bearer ${CHANNELS_API_BEARER}" \
  -H "Content-Type: application/json" \
  -b /tmp/caishen-bot-cookie.txt \
  -X POST \
  -d "{\"confirmation\": \"CLOSE-ALL\", \"csrf\": \"${csrf}\"}" \
  "${DASHBOARD_BASE_URL%/}/api/overrides/close-all" 2>&1) || {
  echo "*close-all — error*"
  echo
  echo "${resp}" | head -c 240
  exit 0
}

ok=$(echo "$resp" | jq -r '.ok // false')
override_id=$(echo "$resp" | jq -r '.overrideActionId // "—"')

if [ "$ok" = "true" ]; then
  echo "*close-all — confirmed*"
  echo
  echo "All positions closed. Audit row: override_actions.id=${override_id}"
else
  err=$(echo "$resp" | jq -r '.error // "unknown"')
  echo "*close-all — failed*"
  echo
  echo "${err}" | head -c 240
fi
