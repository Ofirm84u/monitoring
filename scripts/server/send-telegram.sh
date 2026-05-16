#!/bin/bash
# Send a message to the locked Telegram user via the monitor bot.
# Usage: /home/ofir/scripts/send-telegram.sh "Your message here"
# Reads TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID from /home/ofir/monitor/.env.production.
set -euo pipefail

ENV_FILE="${MONITOR_ENV_FILE:-/home/ofir/monitor/.env.production}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "send-telegram: env file not found: $ENV_FILE" >&2
  exit 1
fi

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')
CHAT_ID=$(grep -E '^TELEGRAM_ALLOWED_USER_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')
MESSAGE="${1:-}"

if [[ -z "$TOKEN" || -z "$CHAT_ID" || -z "$MESSAGE" ]]; then
  echo "send-telegram: TOKEN/CHAT_ID/MESSAGE missing" >&2
  exit 1
fi

curl -sS --max-time 15 -X POST \
  "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" \
  --data-urlencode "disable_web_page_preview=true" \
  >/dev/null
