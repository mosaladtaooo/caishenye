#!/usr/bin/env bash
# /balance — fetch MT5 balance + equity via the bearer-proxied tunnel.
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Inputs:
#   MT5_BASE_URL       — Tailscale Funnel hostname, e.g. https://caishen-vps.<tailnet>.ts.net
#   MT5_BEARER_TOKEN   — bearer the nginx proxy validates (FR-009 AC-009-2)
# Output: Markdown <= 280 chars (AC-004-2).

set -euo pipefail

: "${MT5_BASE_URL:?MT5_BASE_URL env var required}"
: "${MT5_BEARER_TOKEN:?MT5_BEARER_TOKEN env var required}"

resp=$(curl -fsSL --max-time 5 \
  -H "Authorization: Bearer ${MT5_BEARER_TOKEN}" \
  "${MT5_BASE_URL%/}/account" 2>&1) || {
  echo "*MT5 balance — error*"
  echo
  echo "MT5 endpoint unreachable: ${resp}" | head -c 240
  exit 0
}

# Expecting JSON: {"balance": 10000.00, "equity": 10523.40, "currency": "USD"}
balance=$(echo "$resp" | jq -r '.balance // "—"')
equity=$(echo "$resp" | jq -r '.equity // "—"')
currency=$(echo "$resp" | jq -r '.currency // "USD"')

cat <<EOF
*MT5 balance*

| | Value |
|---|---|
| Balance | ${balance} ${currency} |
| Equity | ${equity} ${currency} |
EOF
