#!/bin/bash
# One-time Hudson retirement script — stops Docker containers, removes volumes/images, deletes GCS backups, removes on-disk dirs.
# Run on the production server as ofir:
#   bash /home/ofir/monitor/scripts/server/hudson-retire.sh
set -euo pipefail

HUDSON_DIR="/home/ofir/hudson"
HUDSON_APP_DIR="/home/ofir/hudson-app"
OPT_HUDSON_DIR="/opt/hudson"
GCS_BUCKET="gs://m84-backups/hudson/"

echo "=== Hudson Retirement Script ==="
echo "Started: $(date -Iseconds)"

# 1. Stop and remove containers + volumes via docker compose (preferred)
if [[ -f "$HUDSON_DIR/docker-compose.yml" ]]; then
  echo ""
  echo "[1/4] Stopping Hudson via docker compose..."
  docker compose -f "$HUDSON_DIR/docker-compose.yml" down --volumes
  echo "      docker compose down complete."
else
  echo ""
  echo "[1/4] No docker-compose.yml at $HUDSON_DIR — falling back to manual container removal."
  CONTAINERS=$(docker ps -a --filter "name=hudson" --format "{{.Names}}" 2>/dev/null || true)
  if [[ -n "$CONTAINERS" ]]; then
    echo "      Stopping containers: $CONTAINERS"
    docker stop $CONTAINERS
    docker rm $CONTAINERS
    echo "      Containers removed."
  else
    echo "      No Hudson containers found."
  fi

  VOLUMES=$(docker volume ls --filter "name=hudson" --format "{{.Name}}" 2>/dev/null || true)
  if [[ -n "$VOLUMES" ]]; then
    echo "      Removing volumes: $VOLUMES"
    docker volume rm $VOLUMES
    echo "      Volumes removed."
  else
    echo "      No Hudson volumes found."
  fi
fi

# 2. Remove Hudson Docker images
echo ""
echo "[2/4] Removing Hudson Docker images..."
IMAGES=$(docker images --filter "reference=hudson*" --format "{{.ID}}" 2>/dev/null || true)
if [[ -n "$IMAGES" ]]; then
  docker rmi -f $IMAGES
  echo "      Images removed."
else
  echo "      No Hudson images found (may have been shared base images — skipped)."
fi

# 3. Delete GCS backup objects
echo ""
echo "[3/6] Deleting GCS backups at $GCS_BUCKET ..."
if gsutil ls "$GCS_BUCKET" &>/dev/null; then
  gsutil -m rm -r "$GCS_BUCKET"
  echo "      GCS bucket contents deleted."
else
  echo "      Bucket $GCS_BUCKET not found or already empty — nothing to delete."
fi

# 4. Remove on-disk app directories
echo ""
echo "[4/6] Removing /home/ofir/hudson-app/ ..."
if [[ -d "$HUDSON_APP_DIR" ]]; then
  rm -rf "$HUDSON_APP_DIR"
  echo "      Removed $HUDSON_APP_DIR"
else
  echo "      $HUDSON_APP_DIR not found — skipped."
fi

echo ""
echo "[5/6] Removing /opt/hudson/ ..."
if [[ -d "$OPT_HUDSON_DIR" ]]; then
  sudo rm -rf "$OPT_HUDSON_DIR"
  echo "      Removed $OPT_HUDSON_DIR"
else
  echo "      $OPT_HUDSON_DIR not found — skipped."
fi

# 6. Remind about nginx
echo ""
echo "[6/6] Nginx reminder:"
echo "      If hudson.m84.me has an nginx site config, remove it manually:"
echo "        sudo rm /etc/nginx/sites-enabled/hudson*"
echo "        sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "=== Retirement complete: $(date -Iseconds) ==="
