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
| `caddy-health-check.sh` | `/home/ofir/scripts/caddy-health-check.sh` |

Note the two directories are different and both are in use: the Next.js app
lives in `/home/ofir/monitor`, while the cron scripts, their logs and state
files live in `/home/ofir/monitoring`.

## Cron entries

Add to `crontab -e` on the VM:

```cron
# --- Backups (all UTC; Israel is UTC+3) ---
55 2 * * * /home/ofir/scripts/env-backup.sh >> /home/ofir/monitoring/env-backup.log 2>&1
0 3 * * * /home/ofir/crm-mati/scripts/pg-backup.sh >> /home/ofir/crm-mati/logs/backup.log 2>&1
20 3 * * * /home/ofir/seoapp/scripts/pg-backup.sh >> /home/ofir/seoapp/logs/backup.log 2>&1
30 3 * * * /opt/beiteden/scripts/pg-backup.sh >> /opt/beiteden/logs/backup.log 2>&1
40 3 * * * /home/ofir/bizitis/scripts/pg-backup-nightly.sh >> /home/ofir/bizitis/logs/backup.log 2>&1
50 3 * * * /home/ofir/sheelot/backup-couple.sh >> /home/ofir/sheelot/logs/backup.log 2>&1
55 3 * * * /opt/kosher/scripts/pg-backup.sh >> /opt/kosher/logs/backup.log 2>&1
0 4 * * * /opt/prdaily/scripts/pg-backup.sh >> /opt/prdaily/backups/cron.log 2>&1
# PR Daily files - marketing plans + chroma vector DB, 5 min after its DB dump
5 4 * * * /opt/prdaily/scripts/files-backup.sh >> /opt/prdaily/backups/files-backup.log 2>&1

# --- Monitoring ---
*/2 * * * * /home/ofir/monitoring/server-monitor.sh >> /home/ofir/monitoring/monitor.log 2>&1
# Host-side Caddy check. Deliberately separate from server-monitor.sh, which
# alerts THROUGH an app that sits behind Caddy.
*/5 * * * * /home/ofir/scripts/caddy-health-check.sh >> /home/ofir/scripts/caddy-health.log 2>&1
*/15 * * * * /home/ofir/monitoring/crm-gmail-check.sh >> /home/ofir/monitoring/crm-gmail-check.log 2>&1
# Backup-freshness check + Telegram alert (10:00 UTC = 13:00 Israel)
0 10 * * * /home/ofir/scripts/backup-freshness-check.sh >> /home/ofir/scripts/freshness.log 2>&1

# --- Disk hygiene ---
# Changed 2026-06-03: weekly wasn't enough - bizitis backup tags accumulate
# mid-week and fill the disk.
30 4 * * * docker image prune -a -f >> /home/ofir/monitoring/docker-prune.log 2>&1
# Note: plain `-f`, so cache from recent builds is kept. This is why build
# cache still reaches several GB between runs.
0 2 * * 0 docker builder prune -f >> /home/ofir/monitoring/monitor.log 2>&1

# --- App cron endpoints ---
# The real Authorization header carries a live bearer token. It is NOT
# reproduced here because this repo is public - copy it from the VM crontab
# (`crontab -l`) or from the app's own env file when restoring.
*/15 * * * * curl -s https://mati.m84.me/api/cron/sync-emails -H "Authorization: Bearer <MATI_CRON_SECRET>" > /dev/null 2>&1
0 7 * * * curl -s https://mati.m84.me/api/cron/reminders -H "Authorization: Bearer <MATI_CRON_SECRET>" > /dev/null 2>&1
# Present TWICE in the live crontab - a known duplicate, one copy should go.
0 2 * * 0-4 curl -s -X POST https://mati.m84.me/api/cron/ai-scan -H "Authorization: Bearer <MATI_CRON_SECRET>"
0 6 * * * /home/ofir/bizitis/scripts/run-daily-blogs.sh
```

Three scripts referenced above are not in this repo because they belong to
their own apps: `/opt/kosher/scripts/pg-backup.sh`,
`/home/ofir/sheelot/backup-couple.sh` and
`/home/ofir/bizitis/scripts/run-daily-blogs.sh`.

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
- `server-monitor.sh` reads `MONITOR_SECRET` out of
  `/home/ofir/monitor/.env.production` itself. It must not rely on the
  environment: cron runs with almost none, so `${MONITOR_SECRET:-}` was empty
  and `/api/alert` answered 401 to every alert, silently, because the POST
  failure was swallowed with `|| true`. It now falls back to Telegram whenever
  the app does not return 2xx, so an outage of the alerting app cannot silence
  the alarms - which is what happened on 2026-10-02 for 40 minutes.
- `caddy-health-check.sh` talks to the Docker daemon directly and alerts over
  Telegram, so it depends on nothing that sits behind Caddy. That is the whole
  point of it: Caddy is a single point of failure for all the sites, and the
  dashboard that normally raises alerts is itself one of them. It keeps its own
  cooldown in `/tmp/caddy-health-last-alert` and clears it on recovery, so a
  second outage alerts immediately rather than waiting out the window.
