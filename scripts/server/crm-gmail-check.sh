#!/usr/bin/env bash
# CRM Gmail sync health check — runs every 15 min via cron
# Sends email to ofir + keren and optional WhatsApp if sync is stale

set -euo pipefail

HEALTH_URL="https://mati.m84.me/api/cron/health"
COOLDOWN_FILE="/home/ofir/monitoring/crm-gmail-last-alert"
COOLDOWN_SECONDS=3600
LOG_FILE="/home/ofir/monitoring/crm-gmail-check.log"
MONITOR_API="http://localhost:3040/api/alert"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Load config (optional CALLMEBOT_APIKEY + MONITOR_SECRET)
CONFIG_FILE="/home/ofir/monitoring/crm-gmail.conf"
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

WA_PHONE="${WA_PHONE:-}"
WA_APIKEY="${CALLMEBOT_APIKEY:-}"
MONITOR_SECRET_VAL="${MONITOR_SECRET:-}"

log() { echo "[$NOW] $1" >> "$LOG_FILE"; }

should_alert() {
  [[ ! -f "$COOLDOWN_FILE" ]] && return 0
  local diff=$(( $(date +%s) - $(cat "$COOLDOWN_FILE") ))
  [[ $diff -ge $COOLDOWN_SECONDS ]] && return 0
  return 1
}

send_alerts() {
  local msg="$1"
  local stale="$2"

  # Email via monitor app (delivers to ofir + keren)
  curl -s -X POST "$MONITOR_API"     -H "Content-Type: application/json"     -H "X-Monitor-Secret: ${MONITOR_SECRET_VAL}"     -d "{\"subject\":\"CRM: Gmail sync תקוע - ${stale}min\",\"body\":\"${msg}\"}"     > /dev/null 2>&1 || true

  # WhatsApp via callmebot (optional)
  if [[ -n "$WA_APIKEY" && -n "$WA_PHONE" ]]; then
    local encoded
    encoded=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$msg")
    curl -s "https://api.callmebot.com/whatsapp.php?phone=${WA_PHONE}&text=${encoded}&apikey=${WA_APIKEY}" > /dev/null 2>&1 || true
  fi

  date +%s > "$COOLDOWN_FILE"
  log "Alerts sent: ${msg}"
}

CRON_SECRET_VAL="${CRON_SECRET:-}"
response=$(curl -s -o /tmp/crm-health.json -w "%{http_code}" --max-time 15 -H "Authorization: Bearer ${CRON_SECRET_VAL}" "$HEALTH_URL" 2>/dev/null || echo "000")

if [[ "$response" != "200" ]]; then
  log "FAIL: Health endpoint returned HTTP $response"
  if should_alert; then
    send_alerts "CRM מנהיגות תודעתית: Gmail sync offline — endpoint returned HTTP $response at $NOW" "?"
  fi
  exit 0
fi

ok=$(python3 -c "import json; d=json.load(open('/tmp/crm-health.json')); print(str(d.get('ok',False)).lower())" 2>/dev/null || echo "false")
stale_min=$(python3 -c "import json; d=json.load(open('/tmp/crm-health.json')); print(d.get('staleSinceMinutes','?'))" 2>/dev/null || echo "?")

if [[ "$ok" != "true" ]]; then
  log "FAIL: Gmail sync stale — ${stale_min}min ago"
  if should_alert; then
    send_alerts "CRM מנהיגות תודעתית: Gmail sync תקוע — לא רץ ${stale_min} דקות. בדוק: https://mati.m84.me/inbox" "$stale_min"
  fi
else
  log "OK: Gmail sync healthy — ${stale_min}min ago"
fi
