#!/usr/bin/env bash
# ADR-009 restart-on-idle oneshot.
#
# Operator-managed (R2 — outside subagent Write scope).
#
# Behaviour:
#   1. Check channels_health.mute_alarm_until — if future, skip restart.
#   2. Otherwise, systemctl restart caishen-channels.service AND insert a
#      channels_health row with restart_reason='scheduled_idle'.
#   3. Bail loud + exit non-zero on any DB or systemctl failure.
#
# Inputs: CAISHEN_TENANT_ID + DATABASE_URL envs (from EnvironmentFile).

set -euo pipefail

: "${CAISHEN_TENANT_ID:?CAISHEN_TENANT_ID env var required}"
: "${DATABASE_URL:?DATABASE_URL env var required}"

# 1. Mute marker check.
muted=$(psql "$DATABASE_URL" -A -t -c "
  SELECT EXISTS (
    SELECT 1 FROM channels_health
    WHERE tenant_id = ${CAISHEN_TENANT_ID}
      AND mute_alarm_until IS NOT NULL
      AND mute_alarm_until > NOW()
  );
" || echo "f")

if [ "$muted" = "t" ]; then
  echo "[restart-on-idle] mute_alarm_until is in the future — skipping restart." >&2
  exit 0
fi

# 2. Insert audit row BEFORE the restart so we record intent (constitution §3).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO channels_health (tenant_id, checked_at, healthy_bool, restart_reason)
  VALUES (${CAISHEN_TENANT_ID}, NOW(), true, 'scheduled_idle');
"

# 3. Restart the unit.
systemctl restart caishen-channels.service

echo "[restart-on-idle] restart complete at $(date -u +%FT%TZ)" >&2
