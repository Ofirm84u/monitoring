#!/bin/bash
# Daily backup check — scans GCS for stale or truncated backups, names the
# reason from the app's own log, and alerts via Telegram.
# Cron: 0 10 * * * /home/ofir/scripts/backup-freshness-check.sh >> /home/ofir/scripts/freshness.log 2>&1
set -uo pipefail

# How old the newest backup may be before it counts as missing.
#
# Not 30. Every backup here runs nightly between 02:55 and 04:05 and this check
# runs at 10:00, so a healthy backup is ~6h old and one missed night is ~30.2h.
# At MAX_AGE_HOURS=30 that 30.2 truncated to 30, `30 > 30` was false, and the
# first missed night passed silently — BookMe skipped 2026-09-25 and this check
# reported "all backups fresh" that morning. 26 leaves four hours of slack for a
# late run while still catching a single miss the same morning.
MAX_AGE_HOURS=26

# Smallest a healthy backup can plausibly be.
#
# A pg_dump that fails part-way, or a container that is down, still uploads a
# file with a fresh timestamp. The smallest healthy backup here is BookMe's
# schema-only dump at ~3.5KB, env-files next at ~4KB, everything else 29KB or
# more; a truncated dump or captured error output is a few hundred bytes. This is
# a corruption guard, not a data-volume check — never raise it towards the
# current size of a backup, or a healthy one starts crying wolf.
MIN_SIZE_BYTES=1024

# One "<key> <consecutive_days>" line per app still failing. Without it every
# morning's message is identical, and an alert that repeats unchanged for days is
# indistinguishable from no alert.
STATE_FILE="${STATE_FILE:-/home/ofir/monitoring/backup-alert-state}"
TELEGRAM="${TELEGRAM:-/home/ofir/scripts/send-telegram.sh}"

NOW_EPOCH=$(date +%s)

# Format: label|gcs-path|filename-prefix|log-path
#
# The log path is what turns "something is wrong" into "here is what is wrong".
# BookMe's backup died for three nights on `Permission denied` and then four more
# on `gsutil: command not found`, both sitting in its own log the whole time
# while the alert said only how many hours had passed.
SOURCES=(
  "CRM Mati|gs://m84-backups/crm-mati/|crm-mati-|/home/ofir/crm-mati/logs/backup.log"
  "BookMe|gs://m84-backups/bookme/|bookme-|/opt/bookme/logs/backup.log"
  "Kosher|gs://m84-backups/kosher/|kosher-|/opt/kosher/logs/backup.log"
  "SEO App|gs://m84-backups/seoapp/|seoapp-|/home/ofir/seoapp/logs/backup.log"
  "Beit Eden|gs://m84-backups/beiteden/|beiteden-|/opt/beiteden/logs/backup.log"
  "Bizitis|gs://m84-backups/bizitis/|bizitis-|/home/ofir/bizitis/logs/backup.log"
  "PR Daily DB|gs://m84-backups/prdaily/|prdaily-2|/opt/prdaily/backups/cron.log"
  "PR Daily files|gs://m84-backups/prdaily/files/|prdaily-files-|/opt/prdaily/backups/files-backup.log"
  "env-files|gs://m84-backups/env-files/||/home/ofir/monitoring/env-backup.log"
)

# A stable key per app, for the state file.
key_for() { printf '%s' "$1" | tr '[:upper:] ' '[:lower:]-'; }

# How many consecutive days this app has been failing, from the previous run.
prior_days() {
  [[ -r "$STATE_FILE" ]] || { echo 0; return; }
  awk -v k="$1" '$1==k {print $2; found=1} END {if (!found) print 0}' "$STATE_FILE" | head -1
}

# The last line of the app's own log that looks like a failure. This is the
# single most useful thing the message can carry.
failure_reason() {
  local log="$1"
  [[ -n "$log" && -r "$log" ]] || return 0
  tail -40 "$log" 2>/dev/null \
    | grep -iE 'refus|permission denied|command not found|no such file|error|failed|fatal|cannot|denied' \
    | tail -1 \
    | tr -d '\r' \
    | cut -c1-150
}

STALE_LIST=""
SMALL_LIST=""
RECOVERED_LIST=""
NEW_STATE=""
WORST_DAYS=0

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r label bucket prefix logpath <<<"$entry"
  key=$(key_for "$label")
  was_failing=$(prior_days "$key")
  failing=0

  # Pull listing — ls -l gives size, date, path.
  listing=$(gsutil ls -l "$bucket" 2>/dev/null | grep -v '^TOTAL' | grep -E "$prefix" || true)

  if [[ -z "$listing" ]]; then
    failing=1
    STALE_LIST+="• ${label}: no backups found in bucket\n"
  else
    # The whole newest row, not just its date: the size has to describe the same
    # file whose age is being judged.
    latest_row=$(echo "$listing" | sort -k2,2 -r | head -1)
    latest_size=$(echo "$latest_row" | awk '{print $1}')
    latest_date=$(echo "$latest_row" | awk '{print $2}')
    latest_name=$(basename "$(echo "$latest_row" | awk '{print $3}')")

    if [[ -z "$latest_date" || -z "$latest_size" ]]; then
      failing=1
      STALE_LIST+="• ${label}: cannot parse latest backup\n"
    else
      latest_epoch=$(date -d "$latest_date" +%s 2>/dev/null || echo "0")
      age_hours=$(( (NOW_EPOCH - latest_epoch) / 3600 ))

      if (( age_hours > MAX_AGE_HOURS )); then
        failing=1
        days=$(( age_hours / 24 )); remh=$(( age_hours % 24 ))
        if (( days > 0 )); then age_label="${days}d ${remh}h"; else age_label="${age_hours}h"; fi
        STALE_LIST+="• ${label}: ${age_label} ago (latest: ${latest_name})\n"
      fi

      # Checked independently of age: a fresh file can still be a failed dump.
      if (( latest_size < MIN_SIZE_BYTES )); then
        failing=1
        SMALL_LIST+="• ${label}: ${latest_size}B (${latest_name})\n"
      fi
    fi
  fi

  if (( failing )); then
    reason=$(failure_reason "$logpath")
    day_count=$(( was_failing + 1 ))
    (( day_count > WORST_DAYS )) && WORST_DAYS=$day_count
    if (( day_count > 1 )); then
      STALE_LIST+="    day ${day_count} of this failure\n"
    fi
    if [[ -n "$reason" ]]; then
      STALE_LIST+="    ${reason}\n"
    else
      STALE_LIST+="    nothing in ${logpath:-its log} explains it\n"
    fi
    NEW_STATE+="${key} ${day_count}"$'\n'
  elif (( was_failing > 0 )); then
    # Say so explicitly. Silence after an alert is ambiguous: it reads the same
    # whether the backup recovered or the check stopped running.
    RECOVERED_LIST+="• ${label}: backing up again after ${was_failing}d\n"
  fi
done

printf '%s' "$NEW_STATE" > "$STATE_FILE" 2>/dev/null \
  || echo "[$(date -Iseconds)] warning: cannot write $STATE_FILE — repeat alerts will not escalate" >&2

if [[ -n "$STALE_LIST" || -n "$SMALL_LIST" ]]; then
  if (( WORST_DAYS > 1 )); then
    MSG="🚨 Backups still failing — day ${WORST_DAYS}:"
  else
    MSG="⚠️ Backup check failed:"
  fi
  if [[ -n "$STALE_LIST" ]]; then
    MSG+=$'\n\n'"Missing (>${MAX_AGE_HOURS}h old):"$'\n'$(printf "$STALE_LIST")
  fi
  if [[ -n "$SMALL_LIST" ]]; then
    MSG+=$'\n\n'"Too small to be a real backup (<${MIN_SIZE_BYTES}B):"$'\n'$(printf "$SMALL_LIST")
  fi
  if [[ -n "$RECOVERED_LIST" ]]; then
    MSG+=$'\n\n'"Recovered:"$'\n'$(printf "$RECOVERED_LIST")
  fi
  "$TELEGRAM" "$MSG" || echo "[$(date -Iseconds)] failed to send Telegram alert"
  echo "[$(date -Iseconds)] alert sent: $(echo -e "$STALE_LIST" | grep -c '^•') missing, $(echo -e "$SMALL_LIST" | grep -c '^•') undersized, day ${WORST_DAYS}"
elif [[ -n "$RECOVERED_LIST" ]]; then
  "$TELEGRAM" "✅ Backups recovered:"$'\n\n'"$(printf "$RECOVERED_LIST")" \
    || echo "[$(date -Iseconds)] failed to send Telegram alert"
  echo "[$(date -Iseconds)] recovery sent: $(echo -e "$RECOVERED_LIST" | grep -c '^•') back to normal"
else
  echo "[$(date -Iseconds)] all backups fresh (≤${MAX_AGE_HOURS}h) and above ${MIN_SIZE_BYTES}B"
fi
