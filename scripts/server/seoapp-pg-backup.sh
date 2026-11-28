#!/bin/bash
# Nightly Postgres backup for SeoApp — uploads to GCS + keeps 7-day local copy.
# Cron: 20 3 * * * /home/ofir/seoapp/scripts/pg-backup.sh >> /home/ofir/seoapp/logs/backup.log 2>&1
set -euo pipefail

APP="seoapp"
BACKUP_DIR="/home/ofir/seoapp/backups"
GCS_BUCKET="gs://m84-backups"
LOCAL_RETENTION_DAYS=7
CONTAINER="seoapp-db-1"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="$BACKUP_DIR/${APP}-${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] starting pg_dump → $OUTFILE"

docker exec "$CONTAINER" sh -c   'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists'   | gzip -9 > "$OUTFILE"

SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "[$(date -Iseconds)] dump complete ($SIZE)"

OUTFILE=$(/home/ofir/scripts/encrypt-for-upload.sh "$OUTFILE")   # age-encrypt before it leaves the VM
gsutil cp "$OUTFILE" "$GCS_BUCKET/${APP}/${APP}-${TIMESTAMP}.sql.gz.age"
echo "[$(date -Iseconds)] uploaded to GCS: $GCS_BUCKET/$APP/"

find "$BACKUP_DIR" \( -name "${APP}-*.sql.gz" -o -name "${APP}-*.sql.gz.age" \) -mtime +$LOCAL_RETENTION_DAYS -delete
echo "[$(date -Iseconds)] pruned local backups older than $LOCAL_RETENTION_DAYS days"
