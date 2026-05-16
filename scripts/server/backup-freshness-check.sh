#!/bin/bash
# Daily backup freshness check — scans GCS for stale backups, alerts via Telegram.
# Cron: 0 10 * * * /home/ofir/scripts/backup-freshness-check.sh >> /home/ofir/scripts/freshness.log 2>&1
set -uo pipefail

MAX_AGE_HOURS=30
NOW_EPOCH=$(date +%s)

# Format: label|gcs-path|filename-prefix
SOURCES=(
  "CRM Mati|gs://crm-mati-backups/|"
  "HomeEye|gs://m84-backups/homeeye/|homeeye-"
  "SEO App|gs://m84-backups/seoapp/|seoapp-"
  "Beit Eden|gs://m84-backups/beiteden/|beiteden-"
  "Bizitis|gs://m84-backups/bizitis/|bizitis-"
  "Hudson|gs://m84-backups/hudson/|hudson-"
  "PR Daily DB|gs://m84-backups/prdaily/|prdaily-2"
  "PR Daily files|gs://m84-backups/prdaily/files/|prdaily-files-"
  "env-files|gs://m84-backups/env-files/|"
)

STALE_LIST=""

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r label bucket prefix <<<"$entry"

  # Pull listing — use ls -l (size + date + path). Last column = path.
  listing=$(gsutil ls -l "$bucket" 2>/dev/null | grep -v '^TOTAL' | grep -E "$prefix" || true)

  if [[ -z "$listing" ]]; then
    STALE_LIST+="• ${label}: no backups found in bucket\n"
    continue
  fi

  # Find newest date string (format: 2026-05-16T04:00:06Z)
  latest_date=$(echo "$listing" | awk '{print $2}' | sort -r | head -1)
  if [[ -z "$latest_date" ]]; then
    STALE_LIST+="• ${label}: cannot parse latest date\n"
    continue
  fi

  latest_epoch=$(date -d "$latest_date" +%s 2>/dev/null || echo "0")
  age_hours=$(( (NOW_EPOCH - latest_epoch) / 3600 ))

  if (( age_hours > MAX_AGE_HOURS )); then
    days=$(( age_hours / 24 ))
    remh=$(( age_hours % 24 ))
    if (( days > 0 )); then
      age_label="${days}d ${remh}h"
    else
      age_label="${age_hours}h"
    fi
    STALE_LIST+="• ${label}: ${age_label} ago (latest: $(basename "$latest_date"))\n"
  fi
done

if [[ -n "$STALE_LIST" ]]; then
  MSG="⚠️ Stale backups (>${MAX_AGE_HOURS}h old):"$'\n\n'$(printf "$STALE_LIST")
  /home/ofir/scripts/send-telegram.sh "$MSG" || echo "[$(date -Iseconds)] failed to send Telegram alert"
  echo "[$(date -Iseconds)] alert sent: $(echo "$STALE_LIST" | grep -c '^•')stale"
else
  echo "[$(date -Iseconds)] all backups fresh (≤${MAX_AGE_HOURS}h)"
fi
