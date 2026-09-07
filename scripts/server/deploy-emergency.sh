#!/bin/bash
# Break-glass emergency deploy script.
# Use ONLY when GCR / GitHub Actions is unavailable and a hotfix is needed NOW.
# Builds the image locally on the server from a git checkout — no registry required.
#
# Usage:
#   APP=bizitis bash deploy-emergency.sh
#   APP=seoapp  bash deploy-emergency.sh
#   APP=crm-mati bash deploy-emergency.sh
#
# Supported apps: bizitis | seoapp | crm-mati | beiteden | homeeye | prdaily | monitor
set -euo pipefail

APP="${APP:-}"
if [[ -z "$APP" ]]; then
  echo "ERROR: Set APP= before running. e.g.  APP=bizitis bash $0"
  exit 1
fi

# ── App registry ─────────────────────────────────────────────────────────────
declare -A APP_DIR APP_COMPOSE APP_SERVICE
APP_DIR[bizitis]="/home/ofir/bizitis"
APP_COMPOSE[bizitis]="docker-compose.yml"
APP_SERVICE[bizitis]="app"

APP_DIR[seoapp]="/home/ofir/seoapp"
APP_COMPOSE[seoapp]="docker-compose.yml"
APP_SERVICE[seoapp]="app"

APP_DIR[crm-mati]="/home/ofir/crm-mati"
APP_COMPOSE[crm-mati]="docker-compose.yml"
APP_SERVICE[crm-mati]="app"

APP_DIR[beiteden]="/home/ofir/beiteden"
APP_COMPOSE[beiteden]="docker-compose.yml"
APP_SERVICE[beiteden]="app"

APP_DIR[homeeye]="/home/ofir/homeeye"
APP_COMPOSE[homeeye]="docker-compose.yml"
APP_SERVICE[homeeye]="app"

APP_DIR[prdaily]="/home/ofir/prdaily"
APP_COMPOSE[prdaily]="docker-compose.yml"
APP_SERVICE[prdaily]="app"

# Monitor is PM2, not Docker — handled separately below
APP_DIR[monitor]="/home/ofir/monitor"

if [[ -z "${APP_DIR[$APP]+x}" ]]; then
  echo "ERROR: Unknown app '$APP'. Supported: bizitis seoapp crm-mati beiteden homeeye prdaily monitor"
  exit 1
fi

DIR="${APP_DIR[$APP]}"
TELEGRAM_SCRIPT="/home/ofir/scripts/send-telegram.sh"

alert() {
  local msg="$1"
  echo "$msg"
  [[ -x "$TELEGRAM_SCRIPT" ]] && "$TELEGRAM_SCRIPT" "$msg" || true
}

echo ""
echo "=== EMERGENCY DEPLOY: $APP ==="
echo "Started: $(date -Iseconds)"
echo "WARNING: Building locally — this skips CI, GCR, and all automated checks."
echo ""

# ── Monitor (PM2) ─────────────────────────────────────────────────────────────
if [[ "$APP" == "monitor" ]]; then
  alert "🚨 Emergency deploy started: monitor (local git pull + npm build)"
  cd "$DIR"
  git pull
  npm ci
  npm run build
  pm2 restart monitor
  alert "✅ Emergency deploy complete: monitor"
  exit 0
fi

# ── Docker apps ───────────────────────────────────────────────────────────────
COMPOSE_FILE="${APP_COMPOSE[$APP]}"
SERVICE="${APP_SERVICE[$APP]}"

alert "🚨 Emergency deploy started: $APP (local git pull + docker build)"

cd "$DIR"
git pull

# Record current image ID for rollback reference
CURRENT_ID=$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE" 2>/dev/null | head -1 || true)
echo "Current container ID: ${CURRENT_ID:-none}"

# Build locally — no registry
docker compose -f "$COMPOSE_FILE" build "$SERVICE"

# Bring up with the new local image
docker compose -f "$COMPOSE_FILE" up -d "$SERVICE"

# Basic health check — wait up to 30s for HTTP 200
echo ""
echo "Waiting for $APP to respond..."
HEALTH_URL=""
case "$APP" in
  bizitis)  HEALTH_URL="https://bizitis.co.il" ;;
  seoapp)   HEALTH_URL="https://app.m84.me" ;;
  crm-mati) HEALTH_URL="https://crm.m84.me" ;;
  beiteden) HEALTH_URL="https://beiteden.m84.me" ;;
  homeeye)  HEALTH_URL="https://homeeye.m84.me" ;;
  prdaily)  HEALTH_URL="https://pr.m84.me" ;;
esac

if [[ -n "$HEALTH_URL" ]]; then
  for i in $(seq 1 6); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")
    if [[ "$STATUS" == "200" ]]; then
      alert "✅ Emergency deploy complete: $APP — HTTP $STATUS"
      echo "Done: $(date -Iseconds)"
      exit 0
    fi
    echo "  Attempt $i/6: HTTP $STATUS — retrying in 5s..."
    sleep 5
  done
  alert "⚠️ Emergency deploy: $APP started but health check failed (last HTTP $STATUS). Check manually."
else
  alert "✅ Emergency deploy complete: $APP (no URL configured for health check)"
fi

echo "Done: $(date -Iseconds)"
