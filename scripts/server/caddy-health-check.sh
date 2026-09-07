#!/bin/bash
# Caddy health check — runs on the VM host (not through Caddy), alerts via Telegram if down.
# Cron: */5 * * * * /home/ofir/scripts/caddy-health-check.sh >> /home/ofir/scripts/caddy-health.log 2>&1
#
# Why host-side: if Caddy is down, Monitor is also unreachable (it's behind Caddy).
# This check bypasses the proxy entirely and talks to Docker directly.
set -uo pipefail

CONTAINER="caddy-caddy-1"
ALERT_COOLDOWN_FILE="/tmp/caddy-health-last-alert"
COOLDOWN_SECONDS=900  # don't repeat alert more than once per 15 min
TELEGRAM_SCRIPT="/home/ofir/scripts/send-telegram.sh"

is_caddy_running() {
  docker ps --filter "name=^${CONTAINER}$" --filter "status=running" --format "{{.Names}}" 2>/dev/null | grep -q "^${CONTAINER}$"
}

send_alert() {
  local msg="$1"
  local now
  now=$(date +%s)

  # Respect cooldown to avoid alert spam
  if [[ -f "$ALERT_COOLDOWN_FILE" ]]; then
    local last_alert
    last_alert=$(cat "$ALERT_COOLDOWN_FILE" 2>/dev/null || echo 0)
    if (( now - last_alert < COOLDOWN_SECONDS )); then
      echo "[$(date -Iseconds)] alert suppressed (cooldown active)"
      return
    fi
  fi

  echo "$now" > "$ALERT_COOLDOWN_FILE"
  [[ -x "$TELEGRAM_SCRIPT" ]] && "$TELEGRAM_SCRIPT" "$msg" || echo "[$(date -Iseconds)] Telegram unavailable: $msg"
}

if is_caddy_running; then
  echo "[$(date -Iseconds)] caddy OK"
  # Clear cooldown file on recovery so next outage alerts immediately
  rm -f "$ALERT_COOLDOWN_FILE"
else
  echo "[$(date -Iseconds)] ALERT: caddy not running"
  send_alert "🚨 Caddy is DOWN on m84 VM — all 8 apps are unreachable. Check: ssh monitor 'docker ps | grep caddy && docker logs caddy-caddy-1 --tail 50'"
fi
