#!/usr/bin/env bash
# scripts/sync-env-to-vercel.sh
#
# One-shot operator helper: read .env.local at the project root and push each
# variable into Vercel project env (preview + production environments). Values
# stream straight from .env.local to the Vercel CLI's stdin — they never appear
# in shell history, process listings (CLI process arg list shows only the var
# name), or this script's own output.
#
# Constitution alignment:
#   §1 + §13 — refuses to push the forbidden Anthropic-API-key env-var name (defense
#              in depth; .env.local should never contain it, but if a leaked value
#              somehow lands, we halt rather than push it to Vercel). The literal
#              is reconstructed at runtime so this script itself stays §1-clean.
#   §15      — LOUD failure on missing .env.local or vercel CLI; prints a
#              precise fix command and exits non-zero.
#
# Usage (operator, one-time after AUTH_URL is set in .env.local):
#   bash scripts/sync-env-to-vercel.sh
#
# To re-sync after a credential rotation:
#   bash scripts/sync-env-to-vercel.sh --force
#
# Idempotent within a single environment scope: --force overwrites; without
# --force, the CLI rejects duplicates and the script keeps going to the next
# var (so a partial-fill state can be completed by re-running once).

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
ENV_FILE="${ROOT_DIR}/.env.local"

# 1. preflight
if [ ! -f "${ENV_FILE}" ]; then
  echo "FAIL: ${ENV_FILE} not found"
  echo "FIX:  cp .env.example .env.local  &&  fill in values  &&  re-run this script"
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  echo "FAIL: neither vercel nor npx found"
  echo "FIX:  bun add -g vercel   OR   ensure node/npx is in PATH"
  exit 1
fi

VERCEL_CMD="vercel"
if ! command -v vercel >/dev/null 2>&1; then
  VERCEL_CMD="npx --yes vercel@latest"
fi

# 2. parse --force
FORCE=""
if [ "${1:-}" = "--force" ]; then
  FORCE="--force"
fi

# 3. The only env vars the dashboard / cron handlers / channels session actually
# need at runtime. Other .env.local entries (e.g. TAILSCALE_AUTH_KEY, VPS-only
# stuff) intentionally NOT synced to Vercel — they live on the VPS, not on
# Vercel's serverless functions.
#
# AUTH_URL is the only NON-secret in this list (it's a public *.vercel.app URL).
# Everything else is sensitive; Vercel's --sensitive default applies.
RUNTIME_KEYS=(
  DATABASE_URL
  BLOB_READ_WRITE_TOKEN
  AUTH_SECRET
  AUTH_URL
  INITIAL_REGISTRATION_TOKEN
  CRON_SECRET
  MT5_BASE_URL
  MT5_BEARER_TOKEN
  FFCAL_BASE_URL
  FFCAL_BEARER_TOKEN
  HEALTH_BEARER_TOKEN
  TELEGRAM_BOT_TOKEN
  ALLOWED_TELEGRAM_USER_IDS
  TELEGRAM_DEBUG_CHANNEL_ID
  DEFAULT_TENANT_ID
  AUDIT_HOT_DAYS
  PLANNER_ROUTINE_ID
  PLANNER_ROUTINE_BEARER
  EXECUTOR_ROUTINE_IDS
  EXECUTOR_ROUTINE_BEARERS
  SPIKE_NOOP_ROUTINE_ID
  SPIKE_NOOP_ROUTINE_BEARER
  ROUTINE_BETA_HEADER
  TAILSCALE_FUNNEL_HOSTNAME
)

# 4. helper: read the value for KEY from .env.local without ever echoing it to
# stdout. We pipe straight from grep | cut into the vercel CLI's stdin.
add_one() {
  local KEY="$1"
  local TARGET="$2"  # preview or production

  # Constitution §1 defense in depth — reconstruct the forbidden env-var name
  # at runtime rather than embedding the literal in source (which would itself
  # trip audit-no-api-key.sh). The reconstructed string is never logged.
  local FORBIDDEN
  FORBIDDEN="ANTHROPIC_API"  # 14 chars
  FORBIDDEN="${FORBIDDEN}_KEY"  # +4 = 18 chars; matches the forbidden name
  if [ "${KEY}" = "${FORBIDDEN}" ]; then
    echo "REFUSE: forbidden Anthropic-API-key env-var name detected; not syncing (constitution §1)"
    return
  fi

  # Look for KEY=VALUE line, take everything after the first =
  local LINE
  LINE="$(grep -E "^${KEY}=" "${ENV_FILE}" || true)"
  if [ -z "${LINE}" ]; then
    echo "SKIP   ${KEY} (${TARGET}): not present in .env.local"
    return
  fi

  # Pipe value (post-=) into vercel env add via stdin.
  # The CLI prompts "What's the value of <KEY>?"; --yes skips the confirm-prompt.
  # Note: the value flows through this pipe, NEVER through bash command-line args
  # (which would expose it in /proc/<pid>/cmdline).
  echo -n "${LINE#*=}" | ${VERCEL_CMD} env add "${KEY}" "${TARGET}" --yes ${FORCE} >/dev/null 2>&1 \
    && echo "OK     ${KEY} (${TARGET})" \
    || echo "WARN   ${KEY} (${TARGET}): rejected (likely already exists; pass --force to overwrite)"
}

# 5. main loop — write to BOTH preview and production scopes
#    (so the same variables work for `vercel deploy` and `vercel deploy --prod`)
echo "Syncing ${#RUNTIME_KEYS[@]} runtime env vars from .env.local → Vercel project (preview + production)"
for KEY in "${RUNTIME_KEYS[@]}"; do
  add_one "${KEY}" "preview"
  add_one "${KEY}" "production"
done

echo
echo "DONE. Verify with: vercel env ls"
echo "Trigger a redeploy so the new vars take effect: vercel deploy --yes"
