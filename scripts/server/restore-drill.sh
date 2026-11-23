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
#
# A failure opens a GitHub issue and stays open until a later drill proves the
# backup restores again. Telegram alone was not enough: a notification scrolls
# away and nothing records that anybody read it, which on a 29-day cycle means
# a dead backup can be announced once and then forgotten for a month.
set -uo pipefail

BUCKET="gs://m84-backups"
# Overridable so the drill can be exercised without resetting the live 29-day
# clock or paging anybody. With STATE hardcoded, the only way to test a change
# was to overwrite the cadence of the thing being tested.
STATE="${STATE:-/home/ofir/monitoring/restore-drill-state}"
INTERVAL_DAYS=29
TELEGRAM="${TELEGRAM:-/home/ofir/scripts/send-telegram.sh}"
GSUTIL=$(command -v gsutil || echo /snap/bin/gsutil)
WORK=$(mktemp -d /tmp/restore-drill-XXXXXX)

# GitHub is the record; Telegram is the alarm. Both, not either: the issue
# survives being ignored, and Telegram still fires when GitHub is unreachable.
# Set GITHUB_REPO to the empty string to switch GitHub reporting off entirely
# (note the `-` rather than `:-`, so an explicit empty value is honoured).
GITHUB_REPO="${GITHUB_REPO-Ofirm84u/monitoring}"
GITHUB_ENV_FILE="${GITHUB_ENV_FILE:-/home/ofir/monitor/.env.production}"
ISSUE_LABEL="restore-drill"
ISSUE_TITLE_PREFIX="Restore drill"
GITHUB_TOKEN=""
GH_BROKEN=0
REPORT=()

# label | gcs prefix | object prefix | kind | image | production container
TARGETS=(
  "crm-mati|crm-mati/|crm-mati-|pg|postgres:16-alpine|crm-mati-postgres"
  "seoapp|seoapp/|seoapp-|pg|postgres:16-alpine|seoapp-db-1"
  "bizitis|bizitis/|bizitis-|pg|postgres:16-alpine|bizitis-postgres-1"
  "prdaily|prdaily/|prdaily-2|pg|postgres:16-alpine|prdaily-postgres"
  "bookme|bookme/|bookme-|pg|postgres:17-alpine|bookme-postgres"
  "kosher|kosher/|kosher-|pg|postgres:18-alpine|kosher-postgres"
  "sheelot|sheelot/|sheelot-couple-|redis|redis:7-alpine|sheelot-couple-redis"
  "pg-globals|pg-globals/|kosher-postgres-|globals|-|kosher-postgres"
  "env-files|env-files/|env-files-|tar|-|-"
  "prdaily-files|prdaily/files/|prdaily-files-|tar|-|-"
)

log() { echo "[$(date -Iseconds)] $*"; }

# Read the token out of the env file, not the environment: cron runs with
# almost none, which is how server-monitor.sh came to post 401s for weeks
# without anyone noticing.
github_token() {
  [[ -r "$GITHUB_ENV_FILE" ]] || return 1
  local t
  t=$(sed -n 's/^GITHUB_TOKEN=//p' "$GITHUB_ENV_FILE" | head -1 | tr -d '"\r')
  [[ -n "$t" ]] || return 1
  printf '%s' "$t"
}

# curl exits 0 on a 403, so a call's success can only be read off the status
# code. Returning curl's exit status instead is how an earlier version logged
# "commented on issue #15" for a request GitHub had refused outright.
github_api() {  # method path [json body] -> sets GH_STATUS and GH_BODY
  local method="$1" path="$2" body="${3:-}" out="$WORK/gh-response.json"
  GH_STATUS=000; GH_BODY=""
  [[ -n "$GITHUB_TOKEN" ]] || return 1
  local -a args=( -sS --max-time 30 -o "$out" -w '%{http_code}' -X "$method"
                  -H "Accept: application/vnd.github+json"
                  -H "X-GitHub-Api-Version: 2022-11-28"
                  --config - )
  [[ -n "$body" ]] && args+=( -H "Content-Type: application/json" --data-binary "$body" )
  # The token arrives through a config file on stdin and never through argv:
  # anything on a command line is readable in `ps` for the life of the call.
  GH_STATUS=$(printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' \
                "https://api.github.com${path}" "$GITHUB_TOKEN" \
              | curl "${args[@]}" 2>/dev/null)
  GH_BODY=$(cat "$out" 2>/dev/null)
  rm -f "$out"
  [[ "$GH_STATUS" == 2* ]]
}

gh_error() {  # what was being attempted
  local msg; msg=$(printf '%s' "$GH_BODY" | jq -r '.message // empty' 2>/dev/null)
  log "GitHub: $1 failed - HTTP ${GH_STATUS}${msg:+ - ${msg}}"
  GH_BROKEN=1
}

# A label GitHub does not know is dropped from the request silently rather than
# rejected, so the label-based lookup below then finds nothing and the drill
# opens a fresh duplicate issue every cycle.
ensure_label() {
  github_api GET "/repos/${GITHUB_REPO}/labels/${ISSUE_LABEL}" && return 0
  github_api POST "/repos/${GITHUB_REPO}/labels" \
    "$(jq -nc --arg n "$ISSUE_LABEL" \
       '{name:$n, color:"b60205", description:"Opened by the restore drill"}')" && return 0
  log "GitHub: label ${ISSUE_LABEL} is missing and could not be created (HTTP ${GH_STATUS}); matching on the title prefix instead"
  return 1
}

# The number of the drill's own open issue, or nothing. Called in a command
# substitution, so this runs in a subshell: nothing it leaves in GH_STATUS or
# GH_BODY is visible to the caller.
open_issue_number() {
  local n
  if github_api GET "/repos/${GITHUB_REPO}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100"; then
    n=$(printf '%s' "$GH_BODY" | jq -r 'map(select(.pull_request|not)) | .[0].number // empty' 2>/dev/null)
    [[ -n "$n" ]] && { printf '%s' "$n"; return 0; }
  fi
  # select(.pull_request|not) is not optional: /issues returns pull requests
  # too, and without it the drill posts its backup results onto an open PR.
  if github_api GET "/repos/${GITHUB_REPO}/issues?state=open&per_page=100"; then
    printf '%s' "$GH_BODY" | jq -r --arg p "$ISSUE_TITLE_PREFIX" \
      'map(select((.pull_request|not) and (.title|startswith($p)))) | .[0].number // empty' 2>/dev/null
  fi
}

issue_body() {
  printf '%s\n' \
    "Restore drill on \`$(hostname -s)\`, $(date -Iseconds)." \
    "" \
    "**${PASS}/${#TARGETS[@]} sources restored cleanly.**${FAILED:+ Failed: \`${FAILED% }\`}" \
    ""
  printf '%s\n' "${REPORT[@]}"
  printf '%s\n' \
    "" \
    "Every restore ran in a throwaway container with \`--network none\` and no volumes; production was only read, for the row-count comparison. Full log: \`/home/ofir/scripts/restore-drill.log\` on the VM." \
    "" \
    "A backup that does not restore is not a backup."
}

report_to_github() {  # pass|fail  body
  local verdict="$1" body="$2" existing title
  if [[ -z "$GITHUB_REPO" ]]; then
    log "GitHub reporting is off (GITHUB_REPO is empty)"
    return 0
  fi
  if ! GITHUB_TOKEN=$(github_token); then
    log "GitHub: no GITHUB_TOKEN in ${GITHUB_ENV_FILE}, cannot report"
    GH_BROKEN=1
    return 1
  fi
  ensure_label || true
  existing=$(open_issue_number)

  if [[ "$verdict" == "fail" ]]; then
    if [[ -n "$existing" ]]; then
      # Comment rather than open: the same broken backup every 29 days should
      # be one issue with a history, not a pile of identical ones.
      if github_api POST "/repos/${GITHUB_REPO}/issues/${existing}/comments" \
           "$(jq -nc --arg b "$body" '{body:$b}')"; then
        log "GitHub: commented on open issue #${existing}"
      else
        gh_error "commenting on #${existing}"
      fi
      return 0
    fi
    title="${ISSUE_TITLE_PREFIX} failed: ${PASS}/${#TARGETS[@]} backups restored ($(date +%F))"
    if github_api POST "/repos/${GITHUB_REPO}/issues" \
         "$(jq -nc --arg t "$title" --arg b "$body" --arg l "$ISSUE_LABEL" \
            '{title:$t, body:$b, labels:[$l]}')"; then
      log "GitHub: opened issue #$(printf '%s' "$GH_BODY" | jq -r '.number // "?"')"
    else
      gh_error "opening an issue"
    fi
    return 0
  fi

  # A passing drill says nothing unless there is an issue to close. An issue
  # left open after the backups recover is noise, and a tracker full of stale
  # issues gets ignored the same way a daily alert does.
  [[ -n "$existing" ]] || return 0
  if github_api POST "/repos/${GITHUB_REPO}/issues/${existing}/comments" \
       "$(jq -nc --arg b "$body" '{body:$b}')"; then
    log "GitHub: recorded the recovery on #${existing}"
  else
    gh_error "commenting on #${existing}"
  fi
  if github_api PATCH "/repos/${GITHUB_REPO}/issues/${existing}" '{"state":"closed"}'; then
    log "GitHub: closed #${existing}"
  else
    gh_error "closing #${existing}"
  fi
}

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

  # Globals first, then the database — that is the real recovery order, and
  # skipping it is why kosher failed: pg_dump does not create roles, so its 102
  # RLS policies referencing cosher_app had nothing to attach to. Restoring the
  # roles first is not a workaround for the drill; it is the procedure.
  local globals
  globals=$("$GSUTIL" ls "${BUCKET}/pg-globals/${prod}-*" 2>/dev/null | sort | tail -1)
  if [[ -n "$globals" ]]; then
    "$GSUTIL" cat "$globals" 2>/dev/null | zcat > "$WORK/${label}.globals.sql"
    # ON_ERROR_STOP is deliberately off here: a globals dump re-creates the
    # superuser the container already has, which errors harmlessly.
    docker exec -i drill-pg psql -U postgres -d postgres --quiet \
      < "$WORK/${label}.globals.sql" >/dev/null 2>&1
    GLOBALS_NOTE=" (+globals: $(grep -c '^CREATE ROLE' "$WORK/${label}.globals.sql") roles)"
  else
    GLOBALS_NOTE=" (no globals backup found)"
  fi

  # >/dev/null matters: this function's stdout becomes the log detail, and psql
  # echoes setval/set_config rows that otherwise drown the real message.
  if ! docker exec -i drill-pg psql -U postgres -d drill -v ON_ERROR_STOP=1 --quiet \
       < "$sql" >/dev/null 2>"$WORK/${label}.err"; then
    echo "psql failed: $(head -2 "$WORK/${label}.err" | tr '\n' ' ')"; return 1
  fi

  # BASE TABLE only: information_schema.tables counts views too, and kosher has
  # 11 of them, which made 35 declared tables look like 46 restored. The count
  # also has to span every schema, not just public — bookme keeps
  # __drizzle_migrations in a drizzle schema, which made 13 look like 12.
  local got_tables
  got_tables=$(docker exec drill-pg psql -U postgres -d drill -At \
    -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema') and table_type = 'BASE TABLE'" 2>/dev/null)
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
    echo "${got_tables} tables; \"${biggest}\" restored=${rows_restored} prod=${rows_prod:-?}${GLOBALS_NOTE:-}"
  else
    echo "${got_tables} tables; \"${biggest}\" restored=${rows_restored} (no production to compare)${GLOBALS_NOTE:-}"
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

drill_globals() {  # label object — a globals dump with no roles is not a backup
  local label="$1" obj="$2" f="$WORK/${label}.sql"
  "$GSUTIL" cat "$obj" 2>/dev/null | zcat > "$f" || { echo "download/gunzip failed"; return 1; }
  local roles; roles=$(grep -c '^CREATE ROLE' "$f")
  (( roles > 0 )) || { echo "no CREATE ROLE statements"; return 1; }
  grep -q 'PASSWORD' "$f" || echo -n ""   # hashes present is normal; never printed
  echo "${roles} roles"
  return 0
}

for entry in "${TARGETS[@]}"; do
  IFS='|' read -r label gcs obj_prefix kind image prod <<<"$entry"
  object=$(newest_object "$gcs" "$obj_prefix")
  if [[ -z "$object" ]]; then
    log "FAIL ${label}: no object found under ${BUCKET}/${gcs}"
    REPORT+=("- **${label}** - FAILED: no object found under \`${BUCKET}/${gcs}\`")
    FAILED+="${label} "; continue
  fi
  case "$kind" in
    pg)    detail=$(drill_pg "$label" "$image" "$prod" "$object") ; rc=$? ;;
    redis) detail=$(drill_redis "$label" "$image" "$object")      ; rc=$? ;;
    tar)   detail=$(drill_tar "$label" "$object")                 ; rc=$? ;;
    globals) detail=$(drill_globals "$label" "$object")            ; rc=$? ;;
    *)     detail="unknown kind"; rc=1 ;;
  esac
  if (( rc == 0 )); then
    log "PASS ${label}: ${detail}  [$(basename "$object")]"
    REPORT+=("- **${label}** - restored: ${detail} \`$(basename "$object")\`")
    PASS=$((PASS + 1))
  else
    log "FAIL ${label}: ${detail}  [$(basename "$object")]"
    REPORT+=("- **${label}** - FAILED: ${detail} \`$(basename "$object")\`")
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
  report_to_github fail "$(issue_body)"
else
  report_to_github pass "$(issue_body)"
fi

# Not being able to file the report is itself worth paging about. An expired or
# under-scoped token fails silently otherwise, and the drill would go on
# "reporting to GitHub" into nothing for months.
if (( GH_BROKEN )) && [[ -x "$TELEGRAM" ]]; then
  "$TELEGRAM" "⚠️ Restore drill could not report to GitHub (${GITHUB_REPO:-unset}).
Check the token scope — details in /home/ofir/scripts/restore-drill.log" >/dev/null 2>&1
fi

if [[ -n "$FAILED" ]]; then
  [[ -x "$TELEGRAM" ]] && "$TELEGRAM" "🚨 Restore drill FAILED for: ${FAILED}
${PASS}/${#TARGETS[@]} restored cleanly. A backup that does not restore is not a backup — see /home/ofir/scripts/restore-drill.log" >/dev/null 2>&1
  exit 1
fi
