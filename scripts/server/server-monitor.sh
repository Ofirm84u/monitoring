#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# Server Monitor — checks health, auto-recovers, and alerts
# Runs via cron every 2 minutes on the GCP VM
# ──────────────────────────────────────────────────────────
set -euo pipefail

MONITOR_DIR="/home/ofir/monitoring"
STATUS_FILE="$MONITOR_DIR/status.json"
ALERT_STATE_FILE="$MONITOR_DIR/alert-state"   # one "<key> <epoch>" line per distinct issue
LOG_FILE="$MONITOR_DIR/monitor.log"
ALERT_COOLDOWN_SECONDS=1800  # 30 minutes between duplicate alerts
ALERT_EMAIL="ofir@bizitis.co.il"

# The app authenticates this script by X-Monitor-Secret. cron runs with a nearly
# empty environment, so ${MONITOR_SECRET:-} was always empty and /api/alert
# answered 401 to every alert ever sent - invisibly, because the POST failure was
# swallowed with `|| true`. Read it the way send-telegram.sh reads the bot token:
# one line out of the app env file, not a full `source` of it.
MONITOR_SECRET="${MONITOR_SECRET:-$(grep -E '^MONITOR_SECRET=' /home/ofir/monitor/.env.production 2>/dev/null | cut -d= -f2- | tr -d '"')}"

# Thresholds
MEM_WARN_MB=300       # Alert if available memory below this
DISK_WARN_PERCENT=85  # Alert if disk usage above this
LOAD_WARN=3.0         # Alert if 5-min load average above this

# Sites to check
declare -A SITES=(
  ["bizitis"]="https://bizitis.co.il"
  ["seoapp"]="https://app.m84.me"
  ["beiteden"]="https://beiteden.m84.me"
  ["mati"]="https://mati.m84.me"
  ["prdaily"]="https://pr.m84.me"
  ["sheelot"]="https://game.la-zug.co.il"
  ["bookme"]="https://bookme.m84.me"
  ["kosher"]="https://tzav.m84.me"
  # The monitor itself. It crash-looped for 40 minutes on 2026-10-02 and nothing
  # alerted, because send_alert posts THROUGH it. Only worth watching now that
  # send_alert has a path that does not depend on it being up.
  ["monitor"]="https://mon.m84.me"
)

# Sites whose healthy answer is not 2xx/3xx. Empty, and deliberately kept.
#
# game.la-zug.co.il used to live here: it sat behind a basic-auth gate, so 401
# was its correct answer and the monitor had to be told so. The gate was
# removed on 2026-08-28 and the site now answers 200 like every other one, so
# the entry is gone — as its own comment said it should be. Leaving it would
# have been worse than pointless: a site that is down behind a proxy commonly
# answers 401, and the monitor would have read a real outage as healthy.
declare -A SITE_EXTRA_OK=()

# Docker containers that should be running
REQUIRED_CONTAINERS=(
  "caddy-caddy-1"
  "bizitis-postgres-1"
  "bizitis-redis-1"
  "seoapp-web-1"
  "seoapp-api-1"
  "seoapp-db-1"
  "seoapp-redis-1"
  "beiteden-app"
  "beiteden-postgres"
  "beiteden-redis"
  "crm-mati-app"
  "crm-mati-postgres"
  "prdaily-app"
  "prdaily-worker"
  "prdaily-postgres"
  "prdaily-redis"
  "prdaily-clamav"
  "crm-mati-wa-primary"
  "crm-mati-wa-backup"
  "seoapp-worker-1"
  "bizitis-app-1"
  "sheelot-caddy"
  "sheelot-server"
  "sheelot-redis"
  "bookme-app"
  "bookme-wa"
  "bookme-postgres"
  "kosher-app"
  "kosher-jobs"
  "kosher-postgres"
)

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ISSUES=()
ISSUE_KEYS=()   # stable key per issue, so cooldown is tracked per-issue not globally
RECOVERIES=()

mkdir -p "$MONITOR_DIR"

# ── Helper: log message ──────────────────────────────────
log() {
  echo "[$NOW] $1" >> "$LOG_FILE"
}

# ── Helper: per-issue alert cooldown ─────────────────────
# A noisy issue must never suppress the alert for a different, new issue.
key_should_alert() {
  local key="$1"
  [[ -f "$ALERT_STATE_FILE" ]] || return 0
  local last
  last=$(awk -v k="$key" '$1 == k { print $2 }' "$ALERT_STATE_FILE" | tail -1)
  [[ -z "$last" ]] && return 0
  local now_epoch
  now_epoch=$(date +%s)
  (( now_epoch - last >= ALERT_COOLDOWN_SECONDS ))
}

mark_alerted() {
  local key="$1"
  local now_epoch
  now_epoch=$(date +%s)
  touch "$ALERT_STATE_FILE"
  grep -v "^${key} " "$ALERT_STATE_FILE" > "${ALERT_STATE_FILE}.tmp" 2>/dev/null || true
  echo "${key} ${now_epoch}" >> "${ALERT_STATE_FILE}.tmp"
  mv "${ALERT_STATE_FILE}.tmp" "$ALERT_STATE_FILE"
}

# ── Helper: send alert email via Bizitis API ─────────────
send_alert() {
  local subject="$1"
  local body="$2"

  # Primary: the monitoring app, which sends the email.
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X POST http://localhost:3040/api/alert \
    -H "Content-Type: application/json" \
    -H "X-Monitor-Secret: ${MONITOR_SECRET:-}" \
    -d "{\"subject\":\"$subject\",\"body\":\"$body\"}" 2>/dev/null || echo "000")

  # Fallback: straight to Telegram, which needs nothing on this box to be
  # healthy. Every alert used to be posted through the monitoring app and the
  # failure swallowed with `|| true`, so the one outage guaranteed to silence
  # every alarm was an outage of the alarm itself — which is exactly what
  # happened on 2026-10-02, unnoticed for 40 minutes.
  if [[ ! "$code" =~ ^2 ]]; then
    /home/ofir/scripts/send-telegram.sh "⚠️ ${subject}

${body}

(the monitoring app did not accept this alert: HTTP ${code})" 2>/dev/null \
      && log "ALERT SENT via Telegram fallback (app returned ${code}): $subject" \
      || log "ALERT FAILED on both paths (app ${code}, telegram failed): $subject"
    return
  fi

  log "ALERT SENT: $subject"
}

# ── Check 1: HTTP uptime ─────────────────────────────────
declare -A SITE_STATUS
for name in "${!SITES[@]}"; do
  url="${SITES[$name]}"
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 10 "$url" 2>/dev/null || echo "000")
  extra_ok="${SITE_EXTRA_OK[$name]:-}"
  if [[ "$http_code" =~ ^(200|301|302|303|307|308)$ ]] || [[ -n "$extra_ok" && "$http_code" == "$extra_ok" ]]; then
    SITE_STATUS[$name]="up"
  else
    SITE_STATUS[$name]="down"
    ISSUES+=("Site $name ($url) returned HTTP $http_code")
    ISSUE_KEYS+=("site:$name")
    log "FAIL: $name returned $http_code"
  fi
done

# ── Check 2: Docker containers ───────────────────────────
RUNNING_CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null || echo "")
declare -A CONTAINER_STATUS
for container in "${REQUIRED_CONTAINERS[@]}"; do
  if echo "$RUNNING_CONTAINERS" | grep -q "^${container}$"; then
    CONTAINER_STATUS[$container]="running"
  elif [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == "true" ]]; then
    # `docker ps` missed it but the daemon says it is running. That happened once
    # on 2026-10-05: crm-mati-app had been up for two weeks with RestartCount 0,
    # was reported down, and `docker start` "recovered" it by succeeding on a
    # container that was already running. A single transient miss in ~360 cycles
    # is not worth an alert, and a false alarm on a channel you have only just
    # started receiving is worse than silence.
    CONTAINER_STATUS[$container]="running"
    log "NOTE: $container missing from docker ps but inspect says running - not alerting"
  else
    CONTAINER_STATUS[$container]="stopped"
    ISSUES+=("Container $container is not running")
    ISSUE_KEYS+=("container:$container")
    log "FAIL: Container $container not running"

    # Auto-recovery: try to start the container
    if docker start "$container" > /dev/null 2>&1; then
      RECOVERIES+=("Auto-started container $container")
      CONTAINER_STATUS[$container]="recovered"
      log "RECOVERY: Started container $container"
    else
      log "RECOVERY FAILED: Could not start $container"
    fi
  fi
done

# ── Check 3: PM2 / Monitor process ──────────────────────
PM2_STATUS="unknown"
if systemctl is-active --quiet pm2-ofir 2>/dev/null; then
  PM2_STATUS="active"
  # Double-check the monitor process is actually running in PM2 (bizitis moved to Docker 2026-05)
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  if pm2 list --no-color 2>/dev/null | grep -q "monitor.*online"; then
    PM2_STATUS="active"
  else
    PM2_STATUS="degraded"
    ISSUES+=("PM2 service active but monitor process not online")
    ISSUE_KEYS+=("pm2:degraded")
    log "FAIL: PM2 active but monitor not online"
    # Try to resurrect
    pm2 resurrect > /dev/null 2>&1 || true
    RECOVERIES+=("Attempted pm2 resurrect")
    log "RECOVERY: Attempted pm2 resurrect"
  fi
else
  PM2_STATUS="failed"
  ISSUES+=("PM2 systemd service is not active")
  ISSUE_KEYS+=("pm2:down")
  log "FAIL: pm2-ofir service not active"
  # Auto-recovery: restart PM2
  sudo systemctl restart pm2-ofir > /dev/null 2>&1 || true
  sleep 3
  if systemctl is-active --quiet pm2-ofir 2>/dev/null; then
    PM2_STATUS="recovered"
    RECOVERIES+=("Auto-restarted pm2-ofir service")
    log "RECOVERY: Restarted pm2-ofir service"
  else
    log "RECOVERY FAILED: Could not restart pm2-ofir"
  fi
fi

# ── Check 4: System resources ───────────────────────────
# Memory
MEM_AVAILABLE=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
MEM_TOTAL=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
MEM_USED=$((MEM_TOTAL - MEM_AVAILABLE))
MEM_PERCENT=$((MEM_USED * 100 / MEM_TOTAL))

if [[ $MEM_AVAILABLE -lt $MEM_WARN_MB ]]; then
  ISSUES+=("Low memory: ${MEM_AVAILABLE}MB available (${MEM_PERCENT}% used)")
  ISSUE_KEYS+=("resource:memory")
  log "WARN: Low memory - ${MEM_AVAILABLE}MB available"
fi

# Disk
DISK_PERCENT=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
DISK_USED=$(df -h / | awk 'NR==2 {print $3}')
DISK_TOTAL=$(df -h / | awk 'NR==2 {print $2}')

if [[ $DISK_PERCENT -ge $DISK_WARN_PERCENT ]]; then
  ISSUES+=("High disk usage: ${DISK_PERCENT}% (${DISK_USED}/${DISK_TOTAL})")
  ISSUE_KEYS+=("resource:disk")
  log "WARN: High disk usage - ${DISK_PERCENT}%"
fi

# CPU load
LOAD_AVG=$(awk '{print $2}' /proc/loadavg)
LOAD_HIGH=$(awk "BEGIN {print ($LOAD_AVG > $LOAD_WARN) ? 1 : 0}")

if [[ "$LOAD_HIGH" == "1" ]]; then
  ISSUES+=("High CPU load: $LOAD_AVG (threshold: $LOAD_WARN)")
  ISSUE_KEYS+=("resource:load")
  log "WARN: High CPU load - $LOAD_AVG"
fi

# Uptime
UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)
UPTIME_DAYS=$((UPTIME_SECONDS / 86400))
UPTIME_HOURS=$(( (UPTIME_SECONDS % 86400) / 3600 ))

# ── Build status JSON ───────────────────────────────────
SITES_JSON="{"
first=true
for name in "${!SITE_STATUS[@]}"; do
  $first || SITES_JSON+=","
  SITES_JSON+="\"$name\":\"${SITE_STATUS[$name]}\""
  first=false
done
SITES_JSON+="}"

CONTAINERS_JSON="{"
first=true
for name in "${!CONTAINER_STATUS[@]}"; do
  $first || CONTAINERS_JSON+=","
  CONTAINERS_JSON+="\"$name\":\"${CONTAINER_STATUS[$name]}\""
  first=false
done
CONTAINERS_JSON+="}"

ISSUES_JSON="["
first=true
for issue in "${ISSUES[@]+"${ISSUES[@]}"}"; do
  $first || ISSUES_JSON+=","
  # Escape quotes in issue text
  escaped=$(echo "$issue" | sed 's/"/\\"/g')
  ISSUES_JSON+="\"$escaped\""
  first=false
done
ISSUES_JSON+="]"

RECOVERIES_JSON="["
first=true
for recovery in "${RECOVERIES[@]+"${RECOVERIES[@]}"}"; do
  $first || RECOVERIES_JSON+=","
  escaped=$(echo "$recovery" | sed 's/"/\\"/g')
  RECOVERIES_JSON+="\"$escaped\""
  first=false
done
RECOVERIES_JSON+="]"

OVERALL="healthy"
if [[ ${#ISSUES[@]} -gt 0 ]]; then
  OVERALL="degraded"
  # Check if any site is completely down
  for name in "${!SITE_STATUS[@]}"; do
    if [[ "${SITE_STATUS[$name]}" == "down" ]]; then
      OVERALL="critical"
      break
    fi
  done
fi

cat > "$STATUS_FILE" << ENDJSON
{
  "timestamp": "$NOW",
  "overall": "$OVERALL",
  "sites": $SITES_JSON,
  "containers": $CONTAINERS_JSON,
  "pm2": "$PM2_STATUS",
  "system": {
    "memoryUsedMb": $MEM_USED,
    "memoryTotalMb": $MEM_TOTAL,
    "memoryPercent": $MEM_PERCENT,
    "memoryAvailableMb": $MEM_AVAILABLE,
    "diskPercent": $DISK_PERCENT,
    "diskUsed": "$DISK_USED",
    "diskTotal": "$DISK_TOTAL",
    "loadAverage": $LOAD_AVG,
    "uptimeDays": $UPTIME_DAYS,
    "uptimeHours": $UPTIME_HOURS
  },
  "issues": $ISSUES_JSON,
  "recoveries": $RECOVERIES_JSON
}
ENDJSON

# ── Alert if issues found ───────────────────────────────
if [[ ${#ISSUES[@]} -gt 0 ]]; then
  # Alert only about issues that are outside their OWN cooldown window, so a
  # persistently noisy check can never suppress a different, newly-broken one.
  NEW_ISSUES=()
  for idx in "${!ISSUES[@]}"; do
    ikey="${ISSUE_KEYS[$idx]}"
    if key_should_alert "$ikey"; then
      NEW_ISSUES+=("${ISSUES[$idx]}")
      mark_alerted "$ikey"
    fi
  done

  if [[ ${#NEW_ISSUES[@]} -gt 0 ]]; then
    issue_list=$(printf '\\n- %s' "${NEW_ISSUES[@]}")
    recovery_list=""
    if [[ ${#RECOVERIES[@]} -gt 0 ]]; then
      recovery_list=$(printf '\\n- %s' "${RECOVERIES[@]}")
      recovery_list="\\n\\nAuto-recovery actions:$recovery_list"
    fi
    send_alert \
      "[Bizitis Monitor] ${OVERALL^^}: ${#NEW_ISSUES[@]} issue(s) detected" \
      "Issues found at $NOW:$issue_list$recovery_list"
  else
    log "SUPPRESSED: ${#ISSUES[@]} issue(s) still active, all within cooldown"
  fi
else
  log "OK: All checks passed"
fi

# Forget resolved issues so a recurrence alerts immediately instead of waiting
# out a cooldown that was started the last time it broke.
if [[ -f "$ALERT_STATE_FILE" ]]; then
  : > "${ALERT_STATE_FILE}.keep"
  for ikey in "${ISSUE_KEYS[@]+"${ISSUE_KEYS[@]}"}"; do
    grep "^${ikey} " "$ALERT_STATE_FILE" >> "${ALERT_STATE_FILE}.keep" 2>/dev/null || true
  done
  mv "${ALERT_STATE_FILE}.keep" "$ALERT_STATE_FILE"
fi

# ── Trim log file (keep last 500 lines) ─────────────────
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt 500 ]]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
