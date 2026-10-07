#!/usr/bin/env bash
# Scheduled encrypted Workspace backup with bounded retention and visible
# failures. Install from cron or a systemd timer on the host that runs the
# Docker Compose deployment.
#
# The ops profile mounts the repository's ./backups directory at /backups, so
# the archive name is identical on the host and inside the container.
#
# Any non-zero exit is a failed backup and should raise an alert. ENCRYPTION_KEY
# and the database URL come from the deployment environment; never put them in a
# crontab.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ENCRYPTION_KEY:?ENCRYPTION_KEY must be supplied by the deployment environment}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
ARCHIVE_NAME="workspace-backup-$(date -u +%Y%m%dT%H%M%SZ).json"

if ! [ "$BACKUP_KEEP" -ge 1 ] 2>/dev/null; then
  echo "BACKUP_KEEP must be a positive integer, got '$BACKUP_KEEP'" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Writers must come back even when the backup, verify or rotate step fails.
restore_writers() { docker compose start api collab worker; }
trap restore_writers EXIT

docker compose stop api collab worker

docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts backup "/backups/$ARCHIVE_NAME"

# Prove the archive we just wrote is decryptable and internally consistent
# before retention is allowed to delete anything.
docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts verify "/backups/$ARCHIVE_NAME"

docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts rotate /backups --keep "$BACKUP_KEEP"

echo "Backup completed: $BACKUP_DIR/$ARCHIVE_NAME (retaining $BACKUP_KEEP)"
