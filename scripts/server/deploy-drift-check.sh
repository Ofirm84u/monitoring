#!/bin/bash
# Deploy drift check — does what is RUNNING match origin/main?
#
# Cron: 0 11 * * * /home/ofir/scripts/deploy-drift-check.sh >> /home/ofir/scripts/drift.log 2>&1
#
# Why this exists. On 2026-10-23 bizitis.co.il started serving 1.4.1. GitHub main
# was 1.4.0, the VM's own clone said 1.3.0, and the image was untagged with no
# RepoDigests, so nothing on this machine could say which commit was running.
# Nobody noticed for four days, and establishing it afterwards took hours of
# reading package.json out of a running container. This asks the question daily
# instead, and says plainly when it cannot answer.
#
# It never writes, pulls or deploys. `git fetch` only, which does not touch a
# working tree — important, because /home/ofir/bizitis is 37 commits behind and
# a pull there would build an old version over a live site.
set -uo pipefail

TELEGRAM=/home/ofir/scripts/send-telegram.sh
NOW=$(date -Iseconds)

# app | container | git clone | kind
#   node  : version read from /app/package.json inside the container
#   pm2   : not a container; the deployed tree is itself the clone
#   other : no package.json (python etc) — reported as unknown, which is itself
#           the finding: that app cannot be verified until its image is tagged
APPS=(
  "bizitis|bizitis-app-1|/home/ofir/bizitis|node"
  "crm-mati|crm-mati-app|/opt/crm-mati|node"
  "bookme|bookme-app|/opt/bookme|node"
  "kosher|kosher-app|/opt/kosher|node"
  "seoapp|seoapp-web-1|/home/ofir/seoapp|node"
  "prdaily|prdaily-app|/opt/prdaily|other"
  "monitor|-|/home/ofir/monitor|pm2"
)

pkg_version() { grep -m1 '"version"' 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }

DRIFT=""
UNKNOWN=""
printf '[%s] %-10s %-12s %-12s %-10s %-10s %-7s %s\n' \
  "$NOW" APP RUN_VER MAIN_VER RUN_SHA MAIN_SHA CLONE VERDICT

for entry in "${APPS[@]}"; do
  IFS='|' read -r app container clone kind <<< "$entry"

  run_ver="-"; run_sha="-"; main_ver="-"; main_sha="-"; behind="-"; verdict="UNKNOWN"; why=""

  # What is running.
  if [[ "$kind" == "pm2" ]]; then
    [[ -r "$clone/package.json" ]] && run_ver=$(pkg_version < "$clone/package.json")
    # For a clone-based deploy the tree IS what is running, so HEAD is the
    # authoritative answer and the version string is worthless: the monitoring
    # repo has sat at "version": "1.0.0" for its whole life, so comparing
    # versions reported MATCH while /home/ofir/monitor was 8 commits behind
    # origin/main — a green light over a real gap, which is worse than no check.
    # Feeding HEAD in as run_sha lets the SHA comparison below handle it.
    run_sha=$(git -C "$clone" rev-parse --short HEAD 2>/dev/null || echo "-")
    [[ -z "$run_sha" ]] && run_sha="-"
  elif [[ -n "$container" && "$container" != "-" ]]; then
    # Prefer the OCI revision label. It is written at build time and survives
    # retagging, whereas .Config.Image is only whatever the deploy happened to
    # name. bizitis is exactly that case: its image carries the tags
    # bizitis-app:1.5.1, bizitis-app:251aee1 and bizitis-app:latest, but the
    # container names it plain "bizitis-app" — so reading the tag finds no SHA
    # while the label gives 251aee1. Any app adopting this label is picked up
    # here automatically, with no change to this list.
    run_sha=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container" 2>/dev/null)
    [[ -z "$run_sha" || "$run_sha" == "<no value>" ]] && run_sha="-"
    if [[ "$run_sha" == "-" ]]; then
      image=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null)
      # Failing that, a registry tag shaped like a git SHA.
      if [[ "$image" =~ :([0-9a-f]{7,40})$ ]]; then run_sha="${BASH_REMATCH[1]}"; fi
    fi
    if [[ "$kind" == "node" ]]; then
      run_ver=$(docker exec "$container" cat /app/package.json 2>/dev/null | pkg_version)
    fi
  fi
  [[ -z "$run_ver" ]] && run_ver="-"

  # What origin/main says. fetch only; never touches the working tree.
  if git -C "$clone" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$clone" fetch -q origin 2>/dev/null
    main_sha=$(git -C "$clone" rev-parse --short origin/main 2>/dev/null || echo "-")
    main_ver=$(git -C "$clone" show origin/main:package.json 2>/dev/null | pkg_version)
    [[ -z "$main_ver" ]] && main_ver="-"
    behind=$(git -C "$clone" rev-list --count HEAD..origin/main 2>/dev/null || echo "-")
  else
    why="no clone on this host"
  fi

  # Verdict: prefer SHA, fall back to version, otherwise say we cannot tell.
  if [[ "$run_sha" != "-" && "$main_sha" != "-" ]]; then
    if [[ "$main_sha" == "$run_sha"* || "$run_sha" == "$main_sha"* ]]; then verdict="MATCH"; else verdict="DRIFT"; why="running $run_sha, origin/main $main_sha"; fi
  elif [[ "$run_ver" != "-" && "$main_ver" != "-" ]]; then
    if [[ "$run_ver" == "$main_ver" ]]; then verdict="MATCH"; else verdict="DRIFT"; why="running v$run_ver, origin/main v$main_ver"; fi
  else
    verdict="UNKNOWN"
    [[ -z "$why" ]] && why="image is untagged and no version readable — cannot verify"
  fi

  printf '[%s] %-10s %-12s %-12s %-10s %-10s %-7s %s %s\n' \
    "$NOW" "$app" "$run_ver" "$main_ver" "$run_sha" "$main_sha" "$behind" "$verdict" "${why:+($why)}"

  [[ "$verdict" == "DRIFT"   ]] && DRIFT+="• ${app}: ${why}"$'\n'
  [[ "$verdict" == "UNKNOWN" ]] && UNKNOWN+="${app} "
done

# Alert only on real drift. UNKNOWN is logged but never alerted: it is a known,
# standing gap (untagged images) and paging about it daily would be noise of
# exactly the kind that buried a backup alert for 19 days.
if [[ -n "$DRIFT" ]]; then
  MSG="⚠️ Deploy drift — running code differs from origin/main:"$'\n\n'"${DRIFT}"
  [[ -n "$UNKNOWN" ]] && MSG+=$'\n'"(cannot verify: ${UNKNOWN})"
  if [[ -x "$TELEGRAM" ]] && "$TELEGRAM" "$MSG" >/dev/null 2>&1; then
    echo "[$NOW] alert sent: $(printf '%s' "$DRIFT" | grep -c '^•') app(s) drifting"
  else
    echo "[$NOW] ALERT FAILED to send; drift was: $(printf '%s' "$DRIFT" | tr '\n' ' ')" >&2
  fi
else
  echo "[$NOW] no drift${UNKNOWN:+ (cannot verify: ${UNKNOWN})}"
fi
