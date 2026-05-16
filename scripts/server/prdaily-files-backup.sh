#!/bin/bash
# Nightly file backup for PR Daily — backs up marketing plans + chroma vector DB.
# Excludes regenerable assets (images / photos / videos).
# Cron: 5 4 * * * /opt/prdaily/scripts/files-backup.sh >> /opt/prdaily/backups/files-backup.log 2>&1
set -euo pipefail

APP="prdaily"
BACKUP_DIR="/opt/prdaily/backups"
GCS_BUCKET="gs://m84-backups"
LOCAL_RETENTION_DAYS=7

MARKETING_DIR="/opt/prdaily/docs/marketing"
CHROMA_DIR="/var/lib/docker/volumes/prdaily_prdaily_chroma/_data"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="$BACKUP_DIR/${APP}-files-${TIMESTAMP}.tar.gz"

echo "[$(date -Iseconds)] starting file backup → $OUTFILE"

# Create tar.gz of marketing + chroma. Use sudo for chroma volume (root-owned).
sudo tar -czf "$OUTFILE" \
  -C / \
  "${MARKETING_DIR#/}" \
  "${CHROMA_DIR#/}"

sudo chown ofir:ofir "$OUTFILE"
SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "[$(date -Iseconds)] tar complete ($SIZE)"

gsutil cp "$OUTFILE" "$GCS_BUCKET/${APP}/files/${APP}-files-${TIMESTAMP}.tar.gz"
echo "[$(date -Iseconds)] uploaded to GCS: $GCS_BUCKET/$APP/files/"

find "$BACKUP_DIR" -name "${APP}-files-*.tar.gz" -mtime +$LOCAL_RETENTION_DAYS -delete
echo "[$(date -Iseconds)] pruned local file-backups older than $LOCAL_RETENTION_DAYS days"
