#!/bin/bash
# Prove the backups actually restore. Not that the files exist — that they load.
#
# Cron: 0 6 * * * /home/ofir/scripts/restore-drill.sh >> /home/ofir/scripts/restore-drill.log 2>&1
# Runs daily, acts only once every INTERVAL_DAYS. Pass --now to force.
#
# Why 29 days and not 30: gs://m84-backups deletes at age 30, so a drill on a
# 30-day cycle can drift past the window and test nothing. The check has to be
# shorter than the retention it is checking.
#
# Why this exists at all: until 2026-10-31 nothing had ever been restored here.
# Every check only proved a file was present, fresh, valid gzip and contained
# CREATE TABLE. None of that proves it loads — and this month alone, three
# things that "looked right" were wrong: BookMe's guard saw a fault that did not
# exist, an os.replace left Caddy reading a stale config, and a pkill pattern
# matched its own wrapper.
#
# It NEVER touches production. Every restore goes into a throwaway container
# with --network none and no volumes, which is destroyed afterwards. Production
# is only ever read, for the row-count comparison. The dumps are made with
# --clean --if-exists and carry over a hundred DROP statements, so restoring
# into the live instance by mistake would drop its tables.
set -uo pipefail

BUCKET="gs://m84-backups"
STATE=/home/ofir/monitoring/restore-drill-state
INTERVAL_DAYS=29
TELEGRAM=/home/ofir/scripts/send-telegram.sh
GSUTIL=$(command -v gsutil || echo /snap/bin/gsutil)
WORK=$(mktemp -d /tmp/restore-drill-XXXXXX)

# label | gcs prefix | object prefix | kind | image | production container
TARGETS=(
  "crm-mati|crm-mati/|crm-mati-|pg|postgres:16-alpine|crm-mati-postgres"
  "seoapp|seoapp/|seoapp-|pg|postgres:16-alpine|seoapp-db-1"
  "bizitis|bizitis/|bizitis-|pg|postgres:16-alpine|bizitis-postgres-1"
  "prdaily|prdaily/|prdaily-2|pg|postgres:16-alpine|prdaily-postgres"
  "bookme|bookme/|bookme-|pg|postgres:17-alpine|bookme-postgres"
  "kosher|kosher/|kosher-|pg|postgres:18-alpine|kosher-postgres"
  "sheelot|sheelot/|sheelot-couple-|redis|redis:7-alpine|sheelot-couple-redis"
  "env-files|env-files/|env-files-|tar|-|-"
  "prdaily-files|prdaily/files/|prdaily-files-|tar|-|-"
)

log() { echo "[$(date -Iseconds)] $*"; }

# The dump is plaintext customer data. Leaving it in /tmp is the same leak as
# the /tmp/env-backup-* dirs found on 2026-08-25, so clear it on every exit.
cleanup() {
  rm -rf "$WORK"
  docker rm -f drill-pg drill-redis >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ "${1:-}" == "--now" ]] && FORCE=1 || FORCE=0
if (( ! FORCE )) && [[ -r "$STATE" ]]; then
  last=$(cat "$STATE" 2>/dev/null || echo 0)
  age_days=$(( ( $(date +%s) - last ) / 86400 ))
  if (( age_days < INTERVAL_DAYS )); then
    exit 0   # silent: this runs daily and acts every 29 days
  fi
fi

log "=== restore drill starting (interval ${INTERVAL_DAYS}d) ==="
PASS=0; FAILED=""

newest_object() {  # $1=gcs prefix  $2=object prefix
  "$GSUTIL" ls -l "${BUCKET}/${1}**" 2>/dev/null | grep -v '^TOTAL' \
    | grep -E "/${2}[^/]*$" | sort -k2,2 | tail -1 | awk '{print $3}'
}

drill_pg() {  # label image prod_container object
  local label="$1" image="$2" prod="$3" obj="$4"
  local sql="$WORK/${label}.sql"
  "$GSUTIL" cat "$obj" 2>/dev/null | zcat > "$sql" || { echo "download/gunzip failed"; return 1; }
  local want_tables; want_tables=$(grep -c '^CREATE TABLE' "$sql")
  (( want_tables > 0 )) || { echo "dump contains no CREATE TABLE"; return 1; }

  docker rm -f drill-pg >/dev/null 2>&1
  docker run -d --name drill-pg --network none \
    -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=drill "$image" >/dev/null 2>&1 \
    || { echo "could not start $image"; return 1; }
  local i; for i in $(seq 1 30); do docker exec drill-pg pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done

  # >/dev/null matters: this function's stdout becomes the log detail, and psql
  # echoes setval/set_config rows that otherwise drown the real message.
  if ! docker exec -i drill-pg psql -U postgres -d drill -v ON_ERROR_STOP=1 --quiet \
       < "$sql" >/dev/null 2>"$WORK/${label}.err"; then
    echo "psql failed: $(head -2 "$WORK/${label}.err" | tr '\n' ' ')"; return 1
  fi

  local got_tables
  got_tables=$(docker exec drill-pg psql -U postgres -d drill -At \
    -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')" 2>/dev/null)
  [[ "$got_tables" == "$want_tables" ]] || { echo "restored $got_tables tables, dump declared $want_tables"; return 1; }

  # A dump can restore 38 empty tables and still be worthless. Compare the
  # biggest table against production, read-only.
  local biggest rows_restored rows_prod pu pd
  biggest=$(docker exec drill-pg psql -U postgres -d drill -At \
    -c "select relname from pg_stat_user_tables order by n_live_tup desc limit 1" 2>/dev/null)
  [[ -n "$biggest" ]] || { echo "no tables with rows after restore"; return 1; }
  rows_restored=$(docker exec drill-pg psql -U postgres -d drill -At -c "select count(*) from \"$biggest\"" 2>/dev/null)
  (( rows_restored > 0 )) || { echo "largest table \"$biggest\" restored empty"; return 1; }

  if [[ "$prod" != "-" ]] && docker ps --format '{{.Names}}' | grep -qx "$prod"; then
    pu=$(docker inspect "$prod" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_USER=' | cut -d= -f2)
    pd=$(docker inspect "$prod" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_DB=' | cut -d= -f2)
    rows_prod=$(docker exec "$prod" psql -U "$pu" -d "$pd" -At -c "select count(*) from \"$biggest\"" 2>/dev/null)
    echo "${got_tables} tables; \"${biggest}\" restored=${rows_restored} prod=${rows_prod:-?}"
  else
    echo "${got_tables} tables; \"${biggest}\" restored=${rows_restored} (no production to compare)"
  fi
  return 0
}

drill_redis() {  # label image object
  local label="$1" image="$2" obj="$3"
  "$GSUTIL" cat "$obj" 2>/dev/null | zcat > "$WORK/dump.rdb" || { echo "download/gunzip failed"; return 1; }
  # create, copy, THEN start. Starting first and restarting does not work:
  # redis saves its (empty) dataset on shutdown and overwrites the RDB being
  # tested before it is ever read — which is why this reported "empty" on a
  # perfectly good backup.
  docker rm -f drill-redis >/dev/null 2>&1
  docker create --name drill-redis --network none "$image" >/dev/null 2>&1 || { echo "could not create $image"; return 1; }
  docker cp "$WORK/dump.rdb" drill-redis:/data/dump.rdb >/dev/null 2>&1 || { echo "docker cp failed"; return 1; }
  docker start drill-redis >/dev/null 2>&1 || { echo "could not start container"; return 1; }
  local i; for i in $(seq 1 20); do docker exec drill-redis redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 1; done
  local keys; keys=$(docker exec drill-redis redis-cli dbsize 2>/dev/null | tr -dc 0-9)
  [[ -n "$keys" ]] || { echo "redis did not answer after loading the RDB"; return 1; }
  (( keys > 0 )) || { echo "RDB loaded but the database is empty"; return 1; }
  echo "RDB loaded, ${keys} keys"
  return 0
}

drill_tar() {  # label object
  local label="$1" obj="$2" f="$WORK/${label}.tar.gz"
  "$GSUTIL" cp "$obj" "$f" >/dev/null 2>&1 || { echo "download failed"; return 1; }
  gzip -t "$f" 2>/dev/null || { echo "gzip integrity failed"; return 1; }
  local n; n=$(tar -tzf "$f" 2>/dev/null | grep -c .)
  (( n > 0 )) || { echo "archive is empty"; return 1; }
  echo "${n} entries, gzip valid"
  return 0
}

for entry in "${TARGETS[@]}"; do
  IFS='|' read -r label gcs obj_prefix kind image prod <<<"$entry"
  object=$(newest_object "$gcs" "$obj_prefix")
  if [[ -z "$object" ]]; then
    log "FAIL ${label}: no object found under ${BUCKET}/${gcs}"
    FAILED+="${label} "; continue
  fi
  case "$kind" in
    pg)    detail=$(drill_pg "$label" "$image" "$prod" "$object") ; rc=$? ;;
    redis) detail=$(drill_redis "$label" "$image" "$object")      ; rc=$? ;;
    tar)   detail=$(drill_tar "$label" "$object")                 ; rc=$? ;;
    *)     detail="unknown kind"; rc=1 ;;
  esac
  if (( rc == 0 )); then
    log "PASS ${label}: ${detail}  [$(basename "$object")]"
    PASS=$((PASS + 1))
  else
    log "FAIL ${label}: ${detail}  [$(basename "$object")]"
    FAILED+="${label} "
  fi
  docker rm -f drill-pg drill-redis >/dev/null 2>&1 || true
  rm -f "$WORK"/*.sql "$WORK"/dump.rdb
done

log "=== drill finished: ${PASS}/${#TARGETS[@]} restored ${FAILED:+| FAILED: ${FAILED}} ==="

# The cadence is recorded whether or not the drill passed. A known-failing
# source would otherwise make this retry every day and alert every day, and a
# daily alarm about a problem already in the log is how alarms get ignored —
# the exact pattern that hid a dead .env backup for 18 days.
date +%s > "$STATE"
log "state written; next drill in ${INTERVAL_DAYS} days"

if [[ -n "$FAILED" ]]; then
  [[ -x "$TELEGRAM" ]] && "$TELEGRAM" "🚨 Restore drill FAILED for: ${FAILED}
${PASS}/${#TARGETS[@]} restored cleanly. A backup that does not restore is not a backup — see /home/ofir/scripts/restore-drill.log" >/dev/null 2>&1
  exit 1
fi
