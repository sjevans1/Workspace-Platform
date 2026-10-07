#!/usr/bin/env bash
# W23 CI/host restore qualification.
# Creates a backup from the running source deployment, restores it into an
# isolated Compose project with fresh volumes, compares durable state, proves
# the recovered stack is ready, and removes only the recovery project.
set -euo pipefail

cd "$(dirname "$0")/.."

test -f .env || { echo ".env is required" >&2; exit 1; }
mkdir -p backups restore-results

SOURCE_ARCHIVE="w23-source-${GITHUB_RUN_ID:-$$}.json"
TARGET_ARCHIVE="w23-restored-${GITHUB_RUN_ID:-$$}.json"
TARGET_PROJECT="openjm-workspace-recovery-${GITHUB_RUN_ID:-$$}"
TARGET_HTTP_PORT="${RESTORE_HTTP_PORT:-8081}"
TARGET_HTTPS_PORT="${RESTORE_HTTPS_PORT:-8444}"
SOURCE_WRITERS_STOPPED=0

target_compose() {
  HTTP_PORT="$TARGET_HTTP_PORT" HTTPS_PORT="$TARGET_HTTPS_PORT" APP_URL="http://localhost:$TARGET_HTTP_PORT" CADDY_ADDRESS=":80" CADDY_TLS_DIRECTIVE="" COOKIE_SECURE="false" BIND_ADDRESS="127.0.0.1" docker compose -p "$TARGET_PROJECT" "$@"
}

cleanup() {
  status=$?
  trap - EXIT
  if [ "$SOURCE_WRITERS_STOPPED" -eq 1 ]; then
    docker compose start api collab worker >/dev/null 2>&1 || true
  fi
  target_compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "${KEEP_RESTORE_BACKUPS:-false}" != "true" ]; then
    rm -f "backups/$SOURCE_ARCHIVE" "backups/$TARGET_ARCHIVE"
  fi
  exit "$status"
}
trap cleanup EXIT

echo "W23: stopping source writers for a stable backup boundary"
docker compose stop api collab worker
SOURCE_WRITERS_STOPPED=1

docker compose --profile ops run --rm ops   node --import tsx scripts/backup.ts backup "/backups/$SOURCE_ARCHIVE"
docker compose --profile ops run --rm ops   node --import tsx scripts/backup.ts verify "/backups/$SOURCE_ARCHIVE"

docker compose start api collab worker
SOURCE_WRITERS_STOPPED=0

# A recovery operator holding the wrong deployment key must not be able to
# trust or restore the archive. Use a deterministic wrong key that cannot
# accidentally equal the source key.
SOURCE_KEY="$(sed -n 's/^ENCRYPTION_KEY=//p' .env)"
test -n "$SOURCE_KEY"
WRONG_KEY="$(printf 'b%.0s' {1..64})"
if [ "$WRONG_KEY" = "$SOURCE_KEY" ]; then
  WRONG_KEY="$(printf 'c%.0s' {1..64})"
fi
set +e
ENCRYPTION_KEY="$WRONG_KEY" target_compose --profile ops run --rm --no-deps ops   node --import tsx scripts/backup.ts verify "/backups/$SOURCE_ARCHIVE"   >/tmp/w23-wrong-key.log 2>&1
wrong_key_status=$?
set -e
if [ "$wrong_key_status" -eq 0 ]; then
  cat /tmp/w23-wrong-key.log >&2
  echo "Wrong-key backup verification unexpectedly succeeded" >&2
  exit 1
fi
grep -E "different ENCRYPTION_KEY|Backup decryption failed" /tmp/w23-wrong-key.log

echo "W23: provisioning isolated recovery database"
target_compose up -d postgres
for attempt in $(seq 1 60); do
  id="$(target_compose ps -q postgres)"
  if [ -n "$id" ] && [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")" = "healthy" ]; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    target_compose logs postgres
    echo "Recovery PostgreSQL did not become healthy" >&2
    exit 1
  fi
  sleep 2
done

target_compose run --rm migrate
target_compose --profile ops run --rm ops   node --import tsx scripts/backup.ts restore "/backups/$SOURCE_ARCHIVE"

# Back up the restored target before any writers start and compare every
# durable table row plus every captured private-object checksum.
target_compose --profile ops run --rm ops   node --import tsx scripts/backup.ts backup "/backups/$TARGET_ARCHIVE"
target_compose --profile ops run --rm ops   node --import tsx scripts/backup.ts compare   "/backups/$SOURCE_ARCHIVE" "/backups/$TARGET_ARCHIVE"   | tee restore-results/w23-restore-comparison.txt

echo "W23: starting recovered stack on isolated host ports"
target_compose up -d
for attempt in $(seq 1 120); do
  if curl --fail --silent "http://127.0.0.1:$TARGET_HTTP_PORT/ready" >/dev/null; then
    target_compose ps
    cat > restore-results/w23-restore-summary.json <<JSON
{
  "schema": 1,
  "source_archive_verified": true,
  "wrong_key_rejected": true,
  "canonical_round_trip_match": true,
  "recovered_ready": true,
  "target_project": "$TARGET_PROJECT",
  "target_http_port": $TARGET_HTTP_PORT,
  "note": "Disposable isolated Compose recovery qualification; source volumes were never destroyed."
}
JSON
    echo "W23 isolated recovery qualification passed"
    exit 0
  fi
  if [ "$attempt" -eq 120 ]; then
    target_compose ps
    target_compose logs
    echo "Recovered stack did not become ready" >&2
    exit 1
  fi
  sleep 2
done
