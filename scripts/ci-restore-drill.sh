#!/usr/bin/env bash
set -euo pipefail

# CI-host restore drill for W23.
# Source and recovery deployments use distinct Compose project names/volumes.
# The recovery target reuses only the encrypted backup artifact and the
# deployment encryption key; it never points at source DB/object volumes.

SOURCE_ENV="${SOURCE_ENV:-.env}"
RECOVERY_ENV="${RECOVERY_ENV:-.env.recovery}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
BACKUP_FILE="${BACKUP_FILE:-w23-ci-restore.json}"
SOURCE_PROJECT="${SOURCE_PROJECT:-openjm-workspace}"
RECOVERY_PROJECT="${RECOVERY_PROJECT:-openjm-workspace-recovery}"
RECOVERY_HTTP_PORT="${RECOVERY_HTTP_PORT:-8081}"
RECOVERY_HTTPS_PORT="${RECOVERY_HTTPS_PORT:-8444}"

test -f "$SOURCE_ENV"
mkdir -p "$BACKUP_DIR"
# The ops container runs as the non-root image user (USER node). A previous
# Compose bind-mount of ./backups can materialize this directory as root, which
# leaves it unwritable for that user even though the runner created it here, so
# grant write access explicitly. This is a disposable CI directory that only
# ever holds an encrypted artifact, and the runner provides passwordless sudo.
sudo chmod 0777 "$BACKUP_DIR"
rm -f "$BACKUP_DIR/$BACKUP_FILE" "$RECOVERY_ENV"
cp "$SOURCE_ENV" "$RECOVERY_ENV"

set_env() {
  local key="$1" value="$2" file="$3"
  if grep -q "^$key=" "$file"; then
    sed -i "s|^$key=.*|$key=$value|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

set_env HTTP_PORT "$RECOVERY_HTTP_PORT" "$RECOVERY_ENV"
set_env HTTPS_PORT "$RECOVERY_HTTPS_PORT" "$RECOVERY_ENV"
set_env APP_URL "http://localhost:$RECOVERY_HTTP_PORT" "$RECOVERY_ENV"
set_env COOKIE_SECURE "false" "$RECOVERY_ENV"
set_env CADDY_ADDRESS ":80" "$RECOVERY_ENV"
set_env CADDY_TLS_DIRECTIVE "" "$RECOVERY_ENV"

cleanup() {
  docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$RECOVERY_ENV"
}
trap cleanup EXIT

# Create and verify the encrypted source backup under an explicit maintenance
# boundary. Always bring source writers back before touching the recovery stack.
docker compose -p "$SOURCE_PROJECT" --env-file "$SOURCE_ENV" stop api collab worker
restore_source() {
  docker compose -p "$SOURCE_PROJECT" --env-file "$SOURCE_ENV" start api collab worker >/dev/null
}
trap 'restore_source; cleanup' EXIT

docker compose -p "$SOURCE_PROJECT" --env-file "$SOURCE_ENV" --profile ops run --rm ops   node --import tsx scripts/backup.ts backup "/backups/$BACKUP_FILE"
docker compose -p "$SOURCE_PROJECT" --env-file "$SOURCE_ENV" --profile ops run --rm ops   node --import tsx scripts/backup.ts verify "/backups/$BACKUP_FILE"
restore_source
trap cleanup EXIT

# Wrong-key proof is read-only and must fail before any recovery write.
wrong_key="$(printf 'f%.0s' {1..64})"
if grep -Fxq "ENCRYPTION_KEY=$wrong_key" "$SOURCE_ENV"; then
  wrong_key="$(printf 'e%.0s' {1..64})"
fi
docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" run --rm   -e ENCRYPTION_KEY="$wrong_key" --no-deps ops   node --import tsx scripts/backup.ts verify "/backups/$BACKUP_FILE"   >/tmp/w23-wrong-key.log 2>&1 && {
    echo "Wrong-key backup verification unexpectedly succeeded" >&2
    exit 1
  }
grep -F "Backup decryption failed" /tmp/w23-wrong-key.log

# Fresh project name guarantees separate database/object volumes.
docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" up -d postgres valkey
docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" run --rm migrate
docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" --profile ops run --rm ops   node --import tsx scripts/backup.ts restore "/backups/$BACKUP_FILE"
docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" up -d

for attempt in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:$RECOVERY_HTTP_PORT/ready" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" ps
    docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" logs
    exit 1
  fi
  sleep 2
done

# Verify restored data exists in the isolated database and source remains live.
source_rows="$(docker compose -p "$SOURCE_PROJECT" --env-file "$SOURCE_ENV" exec -T postgres   psql -U postgres -d workspace -At -c "SELECT count(*) FROM resources")"
recovery_rows="$(docker compose -p "$RECOVERY_PROJECT" --env-file "$RECOVERY_ENV" exec -T postgres   psql -U postgres -d workspace -At -c "SELECT count(*) FROM resources")"
test "$source_rows" -gt 0
test "$recovery_rows" -eq "$source_rows"
curl --fail --silent "http://127.0.0.1:8080/ready" >/dev/null

printf 'W23 CI RESTORE DRILL source_rows=%s recovery_rows=%s recovery_http_port=%s\n'   "$source_rows" "$recovery_rows" "$RECOVERY_HTTP_PORT"
