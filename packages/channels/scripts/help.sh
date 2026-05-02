#!/usr/bin/env bash
# /help — print the slash-command catalog.
#
# Operator-managed (R2 — outside subagent Write scope).
# Inputs: none. Output: static markdown.

cat <<'EOF'
*财神爷 Telegram commands*

| Command | Purpose |
|---|---|
| `/status` | Today's pair_schedules + agent_state |
| `/balance` | MT5 balance + equity |
| `/positions` | Open positions with P&L |
| `/report <pair>` | Most recent executor report for the pair |
| `/history` | Last 10 executor outcomes |
| `/closeall` | Close ALL open positions (audit-trailed) |
| `/closepair <pair>` | Close positions for one pair |
| `/replan [--force]` | Force a fresh Planner fire |
| `/pause` | Pause agent + cancel today's pending schedules |
| `/resume` | Resume agent (followed by /replan) |
| `/help` | This list |

Free text without a slash → free-form Q&A.
The audit log is the agent's memory: yesterday's chat is queryable from `telegram_interactions`.
EOF
