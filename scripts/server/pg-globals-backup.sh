#!/bin/bash
# Back up the cluster-level objects that pg_dump leaves behind: roles, their
# passwords, memberships and grants.
#
# Cron: 45 2 * * * /home/ofir/scripts/pg-globals-backup.sh >> /home/ofir/scripts/pg-globals.log 2>&1
#       (02:45 UTC — before the per-database dumps start at 02:55)
#
# Why. The restore drill on 2026-10-31 could not rebuild kosher: its dump
# carries 102 RLS policies referencing the role cosher_app, and pg_dump does
# not create roles — they live in the cluster, not the database. Production had
# six non-builtin roles (anon, authenticated, cosher_app, cosher_report,
# kosher, service_role) and no backup held any of them, so the role
# definitions existed only inside the running database. A dump you know will
# not restore is worse than one you have not checked.
#
# Containers are discovered, not listed, so an app added later is covered
# without editing this file.
set -uo pipefail

BUCKET="gs://m84-backups/pg-globals"
LOCAL=/home/ofir/pg-globals
RETAIN_DAYS=7
GSUTIL=$(command -v gsutil || echo /snap/bin/gsutil)
TELEGRAM=/home/ofir/scripts/send-telegram.sh
STAMP=$(date -u +%Y-%m-%d-%H%M)

log() { echo "[$(date -Iseconds)] $*"; }

mkdir -p "$LOCAL"
# The output contains SCRAM password hashes. Treat it like the .env archive:
# never echo its contents, and keep it unreadable to anyone else.
chmod 700 "$LOCAL"

[[ -x "$GSUTIL" ]] || { log "ERROR: gsutil not found"; exit 1; }

# Discovery by image name alone is not enough: kosher-jobs runs FROM
# postgres:18-alpine but is a job runner, not a server, and pg_dumpall against
# it simply fails. Ask each candidate whether it is actually accepting
# connections, and skip the ones that are not instead of reporting a failure.
mapfile -t CANDIDATES < <(docker ps --format '{{.Names}}\t{{.Image}}' \
  | awk -F'\t' '$2 ~ /^postgres:/ {print $1}' | sort)
CONTAINERS=()
for c in "${CANDIDATES[@]}"; do
  if docker exec "$c" pg_isready -q 2>/dev/null; then
    CONTAINERS+=("$c")
  else
    log "skip $c: runs a postgres image but is not accepting connections"
  fi
done

if (( ${#CONTAINERS[@]} == 0 )); then
  log "ERROR: no running postgres containers found — nothing to back up"
  exit 1
fi

ok=0; failed=""
for c in "${CONTAINERS[@]}"; do
  su=$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' \
       | grep '^POSTGRES_USER=' | cut -d= -f2)
  [[ -n "$su" ]] || { log "FAIL $c: no POSTGRES_USER in the container env"; failed+="$c "; continue; }

  out="$LOCAL/${c}-${STAMP}.sql.gz"
  if ! docker exec "$c" sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_dumpall -U \"\$POSTGRES_USER\" --globals-only" 2>/dev/null \
       | gzip -9 > "$out"; then
    log "FAIL $c: pg_dumpall failed"; failed+="$c "; rm -f "$out"; continue
  fi
  chmod 600 "$out"

  # A globals dump with no CREATE ROLE is not a globals dump. Counting, not
  # printing: these lines carry password hashes.
  roles=$(zcat "$out" | grep -c '^CREATE ROLE' || true)
  if (( roles == 0 )); then
    log "FAIL $c: dump contains no CREATE ROLE — refusing to publish it"
    mv "$out" "${out}.rejected"; failed+="$c "; continue
  fi

  if ! "$GSUTIL" -q cp "$out" "${BUCKET}/${c}-${STAMP}.sql.gz" 2>/dev/null; then
    log "FAIL $c: upload failed — the local copy at $out is the only one"
    failed+="$c "; continue
  fi
  log "OK $c: ${roles} roles, $(wc -c < "$out")B uploaded"
  ok=$((ok + 1))
done

find "$LOCAL" -name '*.sql.gz' -mtime +$RETAIN_DAYS -delete 2>/dev/null
log "done: ${ok}/${#CONTAINERS[@]} clusters${failed:+ | FAILED: ${failed}}"

if [[ -n "$failed" ]]; then
  [[ -x "$TELEGRAM" ]] && "$TELEGRAM" "⚠️ pg-globals backup failed for: ${failed}
Without these, a rebuild cannot recreate roles, and any dump with RLS policies or grants will not restore." >/dev/null 2>&1
  exit 1
fi
