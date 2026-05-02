#!/usr/bin/env bash
# .harness/init.sh — 财神爷 v2 project health check (FR-020 rewrite)
#
# Constitution §15: this script MUST exit 0 only if the entire environment
# is clean. Any unfixable warning is loudly explained.
#
# AC-020-1: smoke-test that runs on every dev-laptop boot. Verifies:
#   - Bun (the project's package manager per ADR; pnpm legacy removed)
#   - Node 20+ (some tooling fallbacks need Node)
#   - .env.local exists (operator-managed; pre-build setup gate)
#   - No ANTHROPIC_API_KEY anywhere (delegates to scripts/audit-no-api-key.sh)
#   - Optional: gitleaks present (CI enforces; local soft-warn)
#   - Optional: Tailscale tunnel reachable IF env is set
#   - Optional: Telegram bot token reachable IF env is set
#
# AC-020-3: LOUD failure mode. Each FAIL is explained with concrete commands
# the operator can run to fix it.
#
# Exit codes:
#   0 — clean; harness can proceed
#   1 — one or more checks failed; fix before continuing
#   2 — script error (e.g., bash itself broken)

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="full"
for arg in "$@"; do
  case "$arg" in
    --quick) MODE="quick" ;;
    --json)  MODE="json"  ;;
  esac
done

FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0
REPORT=""

add() {
  local status="$1" name="$2" detail="$3"
  REPORT+=$'\n'"  [$status] $name"
  [[ -n "$detail" ]] && REPORT+=$'\n'"        $detail"
  case "$status" in
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
  esac
}

# ─────────────────────────────────────────────────────────────
# 1. Baseline tooling
# ─────────────────────────────────────────────────────────────

if command -v bun >/dev/null 2>&1; then
  add PASS "bun" "$(bun --version)"
else
  add FAIL "bun" \
    "not installed. Install: curl -fsSL https://bun.sh/install | bash"
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "${NODE_MAJOR:-0}" -ge 20 ]]; then
    add PASS "Node.js ≥ 20" "$(node --version)"
  else
    add FAIL "Node.js ≥ 20" \
      "found $(node --version) — Next.js 16 requires Node 20+; upgrade required"
  fi
else
  add FAIL "Node.js" \
    "not installed — needed for some tooling fallbacks (Next.js 16 prefers it locally)"
fi

if command -v git >/dev/null 2>&1; then
  add PASS "git" "$(git --version | head -1)"
else
  add FAIL "git" "not installed — required for worktree-isolated builds"
fi

# ─────────────────────────────────────────────────────────────
# 2. Workspace state
# ─────────────────────────────────────────────────────────────

if [[ -f "$REPO_ROOT/package.json" ]]; then
  add PASS "package.json present" ""
else
  add FAIL "package.json" "missing — are you in the project root?"
fi

if [[ -f "$REPO_ROOT/bun.lock" ]]; then
  if [[ -d "$REPO_ROOT/node_modules" ]]; then
    add PASS "node_modules installed" ""
  else
    add FAIL "node_modules" "run: bun install"
  fi
else
  add WARN "bun.lock" "missing — initial install needed"
fi

# ─────────────────────────────────────────────────────────────
# 3. Constitution §1 + §13 — no ANTHROPIC_API_KEY
# ─────────────────────────────────────────────────────────────

if [[ -x "$REPO_ROOT/scripts/audit-no-api-key.sh" ]]; then
  if "$REPO_ROOT/scripts/audit-no-api-key.sh" "$REPO_ROOT" >/dev/null 2>&1; then
    add PASS "no ANTHROPIC_API_KEY (§1)" "audit-no-api-key script clean"
  else
    add FAIL "no ANTHROPIC_API_KEY (§1)" \
      "audit script reported references. Run: bash scripts/audit-no-api-key.sh"
  fi
else
  add FAIL "audit-no-api-key.sh" \
    "missing or non-executable. Re-clone or run: chmod +x scripts/audit-no-api-key.sh"
fi

# ─────────────────────────────────────────────────────────────
# 4. Constitution §10 — secret scan (gitleaks soft-warn locally)
# ─────────────────────────────────────────────────────────────

if command -v gitleaks >/dev/null 2>&1; then
  add PASS "gitleaks" "$(gitleaks version 2>&1 | head -1)"
else
  add WARN "gitleaks" \
    "not installed locally — CI enforces. Install: 'brew install gitleaks' or https://github.com/gitleaks/gitleaks#installing"
fi

# ─────────────────────────────────────────────────────────────
# 5. Operator-managed .env.local
# ─────────────────────────────────────────────────────────────

if [[ -f "$REPO_ROOT/.env.local" ]]; then
  add PASS ".env.local present" "operator-managed file (gitignored, never committed)"
  # Sanity check: should NOT contain the forbidden literal.
  if grep -qi "ANTHROPIC_API_KEY" "$REPO_ROOT/.env.local" 2>/dev/null; then
    add FAIL ".env.local contains ANTHROPIC_API_KEY" \
      "Constitution §1 violation. Remove the line; use per-routine bearer tokens instead (ADR-004)."
  fi
elif [[ -f "$REPO_ROOT/.env.example" ]]; then
  add WARN ".env.local missing" \
    "copy from template: cp .env.example .env.local && fill in REPLACE_ME values"
else
  add WARN ".env files" "neither .env.local nor .env.example present"
fi

# ─────────────────────────────────────────────────────────────
# 6. Tailscale Funnel reachability (FR-009 — when env is set)
# ─────────────────────────────────────────────────────────────

if [[ "${MODE}" != "quick" ]]; then
  if [[ -n "${MT5_BASE_URL:-}" && -n "${MT5_BEARER_TOKEN:-}" ]]; then
    if curl -sS --max-time 5 -H "Authorization: Bearer ${MT5_BEARER_TOKEN}" \
         "${MT5_BASE_URL}/health" >/dev/null 2>&1; then
      add PASS "MT5 tunnel reachable" "$(echo "$MT5_BASE_URL" | sed 's|.*//\([^/]*\).*|\1|')"
    else
      add WARN "MT5 tunnel reachable" \
        "MT5_BASE_URL set but health probe failed — check Tailscale Funnel + nginx bearer-proxy on VPS"
    fi
  else
    add WARN "MT5 tunnel reachable" \
      "MT5_BASE_URL / MT5_BEARER_TOKEN not set — cannot smoke-test (set in .env.local)"
  fi

  # Optional: Telegram bot reachability when token is present.
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    if curl -sS --max-time 5 \
         "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" \
         | grep -q '"ok":true' 2>/dev/null; then
      add PASS "Telegram bot reachable" "getMe OK"
    else
      add WARN "Telegram bot reachable" \
        "TELEGRAM_BOT_TOKEN set but getMe failed — token may be invalid or rate-limited"
    fi
  else
    add WARN "Telegram bot reachable" \
      "TELEGRAM_BOT_TOKEN not set — cannot smoke-test (set in .env.local)"
  fi
fi

# ─────────────────────────────────────────────────────────────
# 7. Lefthook hook installed
# ─────────────────────────────────────────────────────────────

if [[ -f "$REPO_ROOT/.git/hooks/pre-commit" ]]; then
  if grep -q "lefthook" "$REPO_ROOT/.git/hooks/pre-commit" 2>/dev/null; then
    add PASS "lefthook pre-commit hook" "installed (audit + biome + gitleaks)"
  else
    add WARN "lefthook pre-commit hook" \
      "git hook present but doesn't reference lefthook. Run: bun install (triggers lefthook install)"
  fi
else
  add WARN "lefthook pre-commit hook" \
    "not installed. Run: bun install (root prepare script handles it)"
fi

# ─────────────────────────────────────────────────────────────
# Output
# ─────────────────────────────────────────────────────────────

print_human() {
  printf '═══════════════════════════════════════════════\n'
  printf '  .harness/init.sh — 财神爷 v2 Project Health Check\n'
  printf '═══════════════════════════════════════════════\n'
  printf '%s\n' "$REPORT"
  printf '\n───────────────────────────────────────────────\n'
  if [[ "$FAIL_COUNT" -eq 0 ]]; then
    printf '  ✓ %d check(s) passed; %d warn(s)\n' "$PASS_COUNT" "$WARN_COUNT"
  else
    printf '  ✗ %d check(s) failed — fix before resuming the harness.\n' "$FAIL_COUNT"
  fi
  printf '───────────────────────────────────────────────\n'
}

if [[ "$MODE" == "json" ]]; then
  printf '{"pass":%d,"warn":%d,"fail":%d}\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
else
  print_human
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi

exit 0
