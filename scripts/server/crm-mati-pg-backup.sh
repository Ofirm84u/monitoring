#!/bin/bash
# Nightly Postgres backup for CRM Mati — uploads to GCS + keeps 7-day local copy.
# Cron: 0 3 * * * /home/ofir/crm-mati/scripts/pg-backup.sh >> /home/ofir/crm-mati/logs/backup.log 2>&1
set -euo pipefail

APP="crm-mati"
PROJECT_DIR="/home/ofir/crm-mati"
BACKUP_DIR="$PROJECT_DIR/backups"
GCS_BUCKET="gs://m84-backups"
LOCAL_RETENTION_DAYS=7
CONTAINER="crm-mati-postgres"

# Backups are age-encrypted before they leave this script (security review
# 2026-11-27): the bucket is shared by every app on the VM, and any container
# that reaches the metadata server gets a token that can read it. Only the
# public key is needed here; the private key decrypts (restore-drill.sh, and an
# offline copy for when this VM is gone).
AGE_RECIPIENTS=/home/ofir/.config/age/m84-backups.pub
AGE_IDENTITY=/home/ofir/.config/age/m84-backups.key
[ -s "$AGE_RECIPIENTS" ] || { echo "[$(date -Iseconds)] ERROR: $AGE_RECIPIENTS missing - refusing to write an unencrypted backup"; exit 1; }

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="$BACKUP_DIR/${APP}-${TIMESTAMP}.sql.gz.age"

echo "[$(date -Iseconds)] starting pg_dump → $OUTFILE"

docker exec "$CONTAINER" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' \
  | gzip -9 | age -R "$AGE_RECIPIENTS" > "$OUTFILE"
chmod 600 "$OUTFILE"

# Prove it decrypts and is a complete gzip before it counts as a backup.
age -d -i "$AGE_IDENTITY" "$OUTFILE" | gzip -t

SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "[$(date -Iseconds)] dump complete ($SIZE)"

gsutil cp "$OUTFILE" "$GCS_BUCKET/${APP}/${APP}-${TIMESTAMP}.sql.gz.age"
echo "[$(date -Iseconds)] uploaded to GCS: $GCS_BUCKET/$APP/"

find "$BACKUP_DIR" -name "${APP}-*.sql.gz*" -mtime +$LOCAL_RETENTION_DAYS -delete
echo "[$(date -Iseconds)] pruned local backups older than $LOCAL_RETENTION_DAYS days"
