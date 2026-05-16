#!/bin/bash
# Nightly Postgres backup for Bizitis — uploads to GCS + keeps 7-day local copy.
# Cron: 40 3 * * * /home/ofir/bizitis/scripts/pg-backup-nightly.sh >> /home/ofir/bizitis/logs/backup.log 2>&1
set -euo pipefail

APP="bizitis"
PROJECT_DIR="/home/ofir/bizitis"
BACKUP_DIR="$PROJECT_DIR/backups"
GCS_BUCKET="gs://m84-backups"
LOCAL_RETENTION_DAYS=7
CONTAINER="bizitis-postgres-1"

mkdir -p "$BACKUP_DIR" "$PROJECT_DIR/logs"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)
OUTFILE="$BACKUP_DIR/${APP}-${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] starting pg_dump → $OUTFILE"

docker exec "$CONTAINER" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' \
  | gzip -9 > "$OUTFILE"

SIZE=$(du -h "$OUTFILE" | cut -f1)
echo "[$(date -Iseconds)] dump complete ($SIZE)"

gsutil cp "$OUTFILE" "$GCS_BUCKET/${APP}/${APP}-${TIMESTAMP}.sql.gz"
echo "[$(date -Iseconds)] uploaded to GCS: $GCS_BUCKET/$APP/"

find "$BACKUP_DIR" -name "${APP}-*.sql.gz" -mtime +$LOCAL_RETENTION_DAYS -delete
echo "[$(date -Iseconds)] pruned local backups older than $LOCAL_RETENTION_DAYS days"
