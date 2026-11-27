#!/bin/bash
# Daily backup of all app .env files to GCS.
# These are needed to restart any app after a disaster — treat as secrets.
# Cron: 55 2 * * * /home/ofir/scripts/env-backup.sh >> /home/ofir/monitoring/env-backup.log 2>&1
set -euo pipefail

GCS_BUCKET="gs://m84-backups"

# Backups are age-encrypted before they leave this script (security review
# 2026-11-27): the bucket is shared by every app on the VM, and any container
# that reaches the metadata server gets a token that can read it. Only the
# public key is needed here; the private key decrypts (restore-drill.sh, and an
# offline copy for when this VM is gone).
AGE_RECIPIENTS=/home/ofir/.config/age/m84-backups.pub
AGE_IDENTITY=/home/ofir/.config/age/m84-backups.key
[ -s "$AGE_RECIPIENTS" ] || { echo "[$(date -Iseconds)] ERROR: $AGE_RECIPIENTS missing - refusing to upload secrets unencrypted"; exit 1; }
BACKUP_DIR=$(mktemp -d /tmp/env-backup-XXXXXX)
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="/tmp/env-files-${TIMESTAMP}.tar.gz.age"

# Always clean up, even on failure — these dirs hold plaintext secrets.
trap 'rm -rf "$BACKUP_DIR" "$OUTFILE"' EXIT

# source path : name inside the archive
ENV_FILES=(
  "/opt/crm-mati/.env:crm-mati.env"
  "/home/ofir/seoapp/.env:seoapp.env"
  "/home/ofir/bizitis/.env:bizitis.env"
  "/opt/prdaily/.env:prdaily.env"
  "/home/ofir/monitor/.env.production:monitor.env"
  "/home/ofir/sheelot/.env:sheelot.env"
  "/opt/bookme/.env:bookme.env"
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

tar -czf - -C "$BACKUP_DIR" . | age -R "$AGE_RECIPIENTS" > "$OUTFILE"
age -d -i "$AGE_IDENTITY" "$OUTFILE" | gzip -t
SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "[$(date -Iseconds)] env archive ready ($SIZE, $found files, $missing missing)"

gsutil -q cp "$OUTFILE" "$GCS_BUCKET/env-files/env-files-${TIMESTAMP}.tar.gz.age"
echo "[$(date -Iseconds)] uploaded to GCS: $GCS_BUCKET/env-files/env-files-${TIMESTAMP}.tar.gz.age"

# GCS retention: 30-day delete lifecycle on the bucket.
echo "[$(date -Iseconds)] done"
