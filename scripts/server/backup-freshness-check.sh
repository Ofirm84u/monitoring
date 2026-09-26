#!/bin/bash
# Daily backup freshness check — scans GCS for stale or truncated backups,
# alerts via Telegram.
# Cron: 0 10 * * * /home/ofir/scripts/backup-freshness-check.sh >> /home/ofir/scripts/freshness.log 2>&1
set -uo pipefail

MAX_AGE_HOURS=30

# Smallest a healthy backup can plausibly be.
#
# Age alone cannot tell a good backup from a broken one: a pg_dump that fails
# part-way, or a container that is down, still uploads a file with a fresh
# timestamp, and the check goes green until the night someone needs to restore.
# A truncated dump or captured error output is a few hundred bytes; the smallest
# healthy backup here is BookMe's schema-only dump at ~3.5KB, with env-files
# next at ~4KB and everything else 29KB or more. 1KB sits clear of both.
#
# This is a corruption guard, not a data-volume check — never raise it towards
# the current size of a backup, or a healthy one starts crying wolf.
MIN_SIZE_BYTES=1024

NOW_EPOCH=$(date +%s)

# Format: label|gcs-path|filename-prefix
SOURCES=(
  "CRM Mati|gs://m84-backups/crm-mati/|crm-mati-"
  "BookMe|gs://m84-backups/bookme/|bookme-"
  "Kosher|gs://m84-backups/kosher/|kosher-"
  "SEO App|gs://m84-backups/seoapp/|seoapp-"
  "Beit Eden|gs://m84-backups/beiteden/|beiteden-"
  "Bizitis|gs://m84-backups/bizitis/|bizitis-"
  "PR Daily DB|gs://m84-backups/prdaily/|prdaily-2"
  "PR Daily files|gs://m84-backups/prdaily/files/|prdaily-files-"
  "env-files|gs://m84-backups/env-files/|"
)

STALE_LIST=""
SMALL_LIST=""

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r label bucket prefix <<<"$entry"

  # Pull listing — use ls -l (size + date + path). Last column = path.
  listing=$(gsutil ls -l "$bucket" 2>/dev/null | grep -v '^TOTAL' | grep -E "$prefix" || true)

  if [[ -z "$listing" ]]; then
    STALE_LIST+="• ${label}: no backups found in bucket\n"
    continue
  fi

  # Take the whole newest row, not just its date: the size on that same line is
  # what the corruption check needs, and it has to describe the same file.
  latest_row=$(echo "$listing" | sort -k2,2 -r | head -1)
  latest_size=$(echo "$latest_row" | awk '{print $1}')
  latest_date=$(echo "$latest_row" | awk '{print $2}')
  latest_name=$(basename "$(echo "$latest_row" | awk '{print $3}')")

  if [[ -z "$latest_date" || -z "$latest_size" ]]; then
    STALE_LIST+="• ${label}: cannot parse latest backup\n"
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
    STALE_LIST+="• ${label}: ${age_label} ago (latest: ${latest_name})\n"
  fi

  # A fresh file can still be a failed dump, so this is checked independently of
  # the age above rather than as an else-branch.
  if (( latest_size < MIN_SIZE_BYTES )); then
    SMALL_LIST+="• ${label}: ${latest_size}B (${latest_name})\n"
  fi
done

if [[ -n "$STALE_LIST" || -n "$SMALL_LIST" ]]; then
  MSG="⚠️ Backup check failed:"
  if [[ -n "$STALE_LIST" ]]; then
    MSG+=$'\n\n'"Stale (>${MAX_AGE_HOURS}h old):"$'\n'$(printf "$STALE_LIST")
  fi
  if [[ -n "$SMALL_LIST" ]]; then
    # Named separately from staleness: a fresh but tiny file means the backup
    # ran and produced nothing usable, which is a different fault to chase.
    MSG+=$'\n\n'"Too small to be a real backup (<${MIN_SIZE_BYTES}B):"$'\n'$(printf "$SMALL_LIST")
  fi
  /home/ofir/scripts/send-telegram.sh "$MSG" || echo "[$(date -Iseconds)] failed to send Telegram alert"
  echo "[$(date -Iseconds)] alert sent: $(echo -e "$STALE_LIST" | grep -c '^•') stale, $(echo -e "$SMALL_LIST" | grep -c '^•') undersized"
else
  echo "[$(date -Iseconds)] all backups fresh (≤${MAX_AGE_HOURS}h) and above ${MIN_SIZE_BYTES}B"
fi
