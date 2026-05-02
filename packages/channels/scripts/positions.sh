#!/usr/bin/env bash
# /positions — list open MT5 positions with P&L.
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Inputs: MT5_BASE_URL + MT5_BEARER_TOKEN.
# Output: Markdown table; if no positions, a one-liner.

set -euo pipefail

: "${MT5_BASE_URL:?MT5_BASE_URL env var required}"
: "${MT5_BEARER_TOKEN:?MT5_BEARER_TOKEN env var required}"

resp=$(curl -fsSL --max-time 5 \
  -H "Authorization: Bearer ${MT5_BEARER_TOKEN}" \
  "${MT5_BASE_URL%/}/positions" 2>&1) || {
  echo "*Positions — error*"
  echo
  echo "MT5 unreachable: ${resp}" | head -c 240
  exit 0
}

count=$(echo "$resp" | jq -r '. | length')
if [ "$count" -eq 0 ]; then
  echo "*Positions* — no open positions."
  exit 0
fi

cat <<EOF
*Positions* — ${count} open

| Pair | Type | Vol | Open | SL | TP | P&L |
|---|---|---|---|---|---|---|
EOF

echo "$resp" | jq -r '.[] | "| \(.symbol) | \(.type) | \(.volume) | \(.open_price) | \(.sl // "—") | \(.tp // "—") | \(.pnl // 0) |"'
