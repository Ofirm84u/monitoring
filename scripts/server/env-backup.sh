#!/bin/bash
# Daily backup of all app .env files to GCS.
# These are needed to restart any app after a disaster — treat as secrets.
# Cron: 55 2 * * * /home/ofir/scripts/env-backup.sh >> /home/ofir/monitoring/env-backup.log 2>&1
set -euo pipefail

GCS_BUCKET="gs://m84-backups"
BACKUP_DIR=$(mktemp -d /tmp/env-backup-XXXXXX)
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="/tmp/env-files-${TIMESTAMP}.tar.gz"

# Always clean up, even on failure — these dirs hold plaintext secrets.
trap 'rm -rf "$BACKUP_DIR" "$OUTFILE"' EXIT

# source path : name inside the archive
ENV_FILES=(
  "/opt/crm-mati/.env:crm-mati.env"
  "/opt/beiteden/.env:beiteden.env"
  "/home/ofir/seoapp/.env:seoapp.env"
  "/home/ofir/bizitis/.env:bizitis.env"
  "/opt/prdaily/.env:prdaily.env"
  "/home/ofir/monitor/.env.production:monitor.env"
)

# A missing file must NOT abort the run — one decommissioned app should never
# take the whole backup down (it did, silently, 2026-08-07 → 2026-08-25).
found=0
missing=0
for entry in "${ENV_FILES[@]}"; do
  src="${entry%%:*}"
  dest="${entry##*:}"
  if [ -f "$src" ]; then
    cp "$src" "$BACKUP_DIR/$dest"
    found=$((found + 1))
  else
    echo "[$(date -Iseconds)] WARN: missing $src — skipped"
    missing=$((missing + 1))
  fi
done

if [ "$found" -eq 0 ]; then
  echo "[$(date -Iseconds)] ERROR: no .env files collected — aborting, nothing uploaded"
  exit 1
fi

tar -czf "$OUTFILE" -C "$BACKUP_DIR" .
SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "[$(date -Iseconds)] env archive ready ($SIZE, $found files, $missing missing)"

gsutil -q cp "$OUTFILE" "$GCS_BUCKET/env-files/env-files-${TIMESTAMP}.tar.gz"
echo "[$(date -Iseconds)] uploaded to GCS: $GCS_BUCKET/env-files/env-files-${TIMESTAMP}.tar.gz"

# GCS retention: 30-day delete lifecycle on the bucket.
echo "[$(date -Iseconds)] done"
