# Server scripts

Operational scripts that live on the GCP VM (not used by Next.js or the
Telegram bot). Kept here for version control / disaster recovery.

## Deployment paths on the VM

| Script | VM path |
|---|---|
| `send-telegram.sh` | `/home/ofir/scripts/send-telegram.sh` |
| `backup-freshness-check.sh` | `/home/ofir/scripts/backup-freshness-check.sh` |
| `bizitis-pg-backup.sh` | `/home/ofir/bizitis/scripts/pg-backup-nightly.sh` |
| `prdaily-files-backup.sh` | `/opt/prdaily/scripts/files-backup.sh` |
| `crm-mati-pg-backup.sh` | `/home/ofir/crm-mati/scripts/pg-backup.sh` |

## Cron entries

Add to `crontab -e` on the VM:

```cron
# Bizitis nightly Postgres backup (03:40 UTC)
40 3 * * * /home/ofir/bizitis/scripts/pg-backup-nightly.sh >> /home/ofir/bizitis/logs/backup.log 2>&1

# PR Daily file backup — marketing plans + chroma vector DB (04:05 UTC, 5min after DB)
5 4 * * * /opt/prdaily/scripts/files-backup.sh >> /opt/prdaily/backups/files-backup.log 2>&1

# Daily backup-freshness check + Telegram alert (10:00 UTC = 13:00 Israel)
0 10 * * * /home/ofir/scripts/backup-freshness-check.sh >> /home/ofir/scripts/freshness.log 2>&1

# CRM Mati nightly Postgres backup (03:00 UTC)
0 3 * * * /home/ofir/crm-mati/scripts/pg-backup.sh >> /home/ofir/crm-mati/logs/backup.log 2>&1

# Daily Docker image prune (04:30 UTC) — removes all unused images
# Changed 2026-06-03: weekly wasn't enough — bizitis backup tags accumulate mid-week and fill disk
30 4 * * * docker image prune -a -f >> /home/ofir/monitoring/docker-prune.log 2>&1
```

## Dependencies

- `send-telegram.sh` reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`
  from `/home/ofir/monitor/.env.production` (override with `MONITOR_ENV_FILE`).
- `backup-freshness-check.sh` and `prdaily-files-backup.sh` need `gsutil`
  authenticated to write to `gs://m84-backups`.
- `prdaily-files-backup.sh` needs passwordless `sudo` for the chroma volume
  (root-owned).
- All backup scripts assume the Docker container names listed inside the file.
