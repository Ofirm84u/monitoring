#!/bin/bash
# Nightly backup of CRM Mati attachments (/opt/crm-mati/uploads): files people
# attach to contacts and deals. Not in the pg_dump, and until 2026-11-27 not in
# any backup at all. Encrypted like the CRM dump: either the master key or the
# CRM-only recovery key decrypts it.
#
# Cron: 10 3 * * * /home/ofir/crm-mati/scripts/files-backup.sh >> /home/ofir/crm-mati/logs/files-backup.log 2>&1
set -euo pipefail

APP="crm-mati"
SRC="/opt/crm-mati/uploads"          # 1000:1000 2770; ofir reads it via group 1000
BACKUP_DIR="/home/ofir/crm-mati/backups"
GCS_BUCKET="gs://m84-backups"
LOCAL_RETENTION_DAYS=7
AGE_RECIPIENTS=/home/ofir/.config/age/crm-mati.recipients
AGE_IDENTITY=/home/ofir/.config/age/m84-backups.key

[ -s "$AGE_RECIPIENTS" ] || { echo "[$(date -Iseconds)] ERROR: $AGE_RECIPIENTS missing - refusing to write an unencrypted backup"; exit 1; }
[ -d "$SRC" ] || { echo "[$(date -Iseconds)] ERROR: $SRC not found"; exit 1; }

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="$BACKUP_DIR/${APP}-files-${TIMESTAMP}.tar.gz.age"
COUNT=$(find "$SRC" -type f | wc -l)

echo "[$(date -Iseconds)] backing up $COUNT files from $SRC -> $OUTFILE"
tar -czf - -C "$SRC" . | age -R "$AGE_RECIPIENTS" > "$OUTFILE"
chmod 600 "$OUTFILE"

# Prove it decrypts, is a complete gzip, and holds the same number of files.
IN_ARCHIVE=$(age -d -i "$AGE_IDENTITY" "$OUTFILE" | tar -tzf - | grep -vc '/$' || true)
[ "$IN_ARCHIVE" -eq "$COUNT" ] || { echo "[$(date -Iseconds)] ERROR: archive has $IN_ARCHIVE files, source has $COUNT"; exit 1; }

gsutil -q cp "$OUTFILE" "$GCS_BUCKET/${APP}-files/${APP}-files-${TIMESTAMP}.tar.gz.age"
echo "[$(date -Iseconds)] uploaded $(du -h "$OUTFILE" | cut -f1) ($COUNT files) to $GCS_BUCKET/${APP}-files/"

find "$BACKUP_DIR" -name "${APP}-files-*.tar.gz.age" -mtime +$LOCAL_RETENTION_DAYS -delete
