# Server scripts

Operational scripts that live on the GCP VM (not used by Next.js or the
Telegram bot). Kept here for version control / disaster recovery.

The VM is `first-1appseo` in GCP project `ofirs-381811`, zone `me-west1-c`
(external IP `34.165.51.161`).

## Deployment paths on the VM

| Script | VM path |
|---|---|
| `send-telegram.sh` | `/home/ofir/scripts/send-telegram.sh` |
| `backup-freshness-check.sh` | `/home/ofir/scripts/backup-freshness-check.sh` |
| `bizitis-pg-backup.sh` | `/home/ofir/bizitis/scripts/pg-backup-nightly.sh` |
| `prdaily-files-backup.sh` | `/opt/prdaily/scripts/files-backup.sh` |
| `crm-mati-pg-backup.sh` | `/home/ofir/crm-mati/scripts/pg-backup.sh` |
| `server-monitor.sh` | `/home/ofir/monitoring/server-monitor.sh` |
| `crm-gmail-check.sh` | `/home/ofir/monitoring/crm-gmail-check.sh` |
| `env-backup.sh` | `/home/ofir/scripts/env-backup.sh` |

Note the two directories are different and both are in use: the Next.js app
lives in `/home/ofir/monitor`, while the cron scripts, their logs and state
files live in `/home/ofir/monitoring`.

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

# Server health check + auto-recovery — every 2 minutes
*/2 * * * * /home/ofir/monitoring/server-monitor.sh >> /home/ofir/monitoring/monitor.log 2>&1

# CRM Gmail sync staleness check — every 15 minutes
*/15 * * * * /home/ofir/monitoring/crm-gmail-check.sh >> /home/ofir/monitoring/crm-gmail-check.log 2>&1

# Nightly .env secrets backup (02:55 UTC, before the DB backups)
55 2 * * * /home/ofir/scripts/env-backup.sh >> /home/ofir/monitoring/env-backup.log 2>&1
```

## Dependencies

- `send-telegram.sh` reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID`
  from `/home/ofir/monitor/.env.production` (override with `MONITOR_ENV_FILE`).
- `backup-freshness-check.sh` and `prdaily-files-backup.sh` need `gsutil`
  authenticated to write to `gs://m84-backups`.
- `prdaily-files-backup.sh` needs passwordless `sudo` for the chroma volume
  (root-owned).
- All backup scripts assume the Docker container names listed inside the file.
- `crm-gmail-check.sh` reads `CALLMEBOT_APIKEY`, `CRON_SECRET` and `WA_PHONE`
  from `/home/ofir/monitoring/crm-gmail.conf`. That file holds secrets and a
  phone number and is deliberately **not** in this repo — recreate it by hand
  when restoring. With `CALLMEBOT_APIKEY` unset the WhatsApp path is skipped
  and alerts go out by email only.
- `server-monitor.sh` keeps per-issue alert cooldowns in
  `/home/ofir/monitoring/alert-state` (one `<key> <epoch>` line per issue), so
  one persistently-failing check can never suppress the alert for a different,
  newly-broken one. Delete that file to force every active issue to re-alert.
- `env-backup.sh` warns and continues on a missing `.env` instead of aborting,
  and clears its temp dir through an `EXIT` trap. Both matter: a missing file
  used to kill the whole run silently, and the failed runs left plaintext
  secrets sitting in `/tmp`.
