#!/usr/bin/env bash
# W27: bounded exact-digest runtime identity proof for one of the two patched-upstream services.
#
# Proves the RUNNING service is the frozen artifact. Every expected identity is read from the
# repository's authoritative provenance record, which scripts/w27-image-inventory.mjs validates, so
# no digest is duplicated in the workflow:
#
#   resolver reference (drift is refused by the resolver)
#     == the provenance reference
#     == the container's configured image reference, or the reference its image resolves to
#     == an entry in the local image's RepoDigests
#     == the SHA-256 of the binary installed in the running container
#     == the version string the running binary reports
#
# Docker's local image id is recorded as evidence only and is deliberately NOT compared to the
# registry manifest or index digest: it is a local, storage-backend-dependent value, not a registry
# identity. FULL 38305744176 failed on exactly that invalid comparison.
#
# Usage: scripts/ci/w27-runtime-identity.sh <caddy|seaweedfs> [repo-root]
set -uo pipefail

TARGET="${1:?usage: w27-runtime-identity.sh <caddy|seaweedfs> [repo-root]}"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
case "$TARGET" in
  caddy) SERVICE=caddy; REF_VAR=W27_CADDY_REF ;;
  seaweedfs) SERVICE=seaweedfs; REF_VAR=W27_SEAWEEDFS_REF ;;
  *) echo "unknown target: $TARGET (expected caddy or seaweedfs)" >&2; exit 2 ;;
esac

ATTEMPTS="${W27_IDENTITY_ATTEMPTS:-30}"
PAUSE="${W27_IDENTITY_PAUSE:-2}"
FAILURES=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  FAIL  %s\n' "$1"; }

echo "W27 exact-digest runtime identity: $TARGET"

REF="$(cd "$ROOT" && node scripts/w27-image-inventory.mjs | sed -n "s/^${REF_VAR}=//p")"
if [ -z "$REF" ]; then echo "the authoritative resolver produced no $REF_VAR" >&2; exit 1; fi

EXPECTED="$(cd "$ROOT" && node -e '
  const fs = require("fs");
  const [file, name] = process.argv.slice(1);
  const record = JSON.parse(fs.readFileSync(file, "utf8")).images.find((image) => image.logicalName === name);
  process.stdout.write([record.ghcrPackage + "@" + record.finalImageDigest, record.binaryPath, record.binarySha256, record.upstreamCommit, record.upstreamTag].join("|"));
' ci/w27-patched-images.json "$TARGET")"
IFS="|" read -r PROVENANCE_REF BINARY_PATH BINARY_SHA UPSTREAM_COMMIT UPSTREAM_TAG <<<"$EXPECTED"

if [ "$PROVENANCE_REF" = "$REF" ]; then
  pass "resolver reference equals the provenance reference: $REF"
else
  fail "the resolver reference $REF is not the provenance reference $PROVENANCE_REF"
fi

CONTAINER=""
for _ in $(seq 1 "$ATTEMPTS"); do
  if [ -z "$CONTAINER" ]; then
    candidate="$(cd "$ROOT" && docker compose ps -q "$SERVICE" 2>/dev/null || true)"
    [ -n "$candidate" ] && CONTAINER="$candidate"
  fi
  if [ -z "$CONTAINER" ]; then
    for id in $(docker ps -q 2>/dev/null); do
      img="$(docker inspect --format '{{.Image}}' "$id" 2>/dev/null)"
      digests="$(docker image inspect --format '{{json .RepoDigests}}' "$img" 2>/dev/null)"
      cfg="$(docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null)"
      case "$cfg:$digests" in
        *"$REF"*) CONTAINER="$id"; break ;;
      esac
    done
  fi
  [ -n "$CONTAINER" ] && break
  sleep "$PAUSE"
done

if [ -z "$CONTAINER" ]; then
  fail "no running $SERVICE container using $REF was found within the bounded wait"
  echo "W27 exact-digest runtime identity ($TARGET): FAIL ($FAILURES failure(s))"
  exit 1
fi
CONTAINER_NAME="$(docker inspect --format '{{.Name}}' "$CONTAINER" | sed "s|^/||")"
pass "running $SERVICE container identified: $CONTAINER_NAME"

[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER")" = "true" ]   && pass "the container is running"   || fail "the container is not running"

CFGREF="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")"
IMGID="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
DIGESTS="$(docker image inspect --format '{{json .RepoDigests}}' "$IMGID" 2>/dev/null)"

if [ "$CFGREF" = "$REF" ]; then
  pass "the container was created from the exact frozen reference"
else
  case "$DIGESTS" in
    *"$REF"*) pass "the container was created from $CFGREF, whose image resolves to the frozen reference" ;;
    *) fail "the container's configured image ($CFGREF) neither is nor resolves to the frozen reference" ;;
  esac
fi

case "$DIGESTS" in
  *"$REF"*) pass "RepoDigests contains the authoritative immutable reference" ;;
  *) fail "RepoDigests does not contain the authoritative immutable reference: ${DIGESTS:-<none>}" ;;
esac

case "$IMGID" in
  sha256:*) pass "local image id recorded as evidence only, never compared to the registry digest: $IMGID" ;;
  *) fail "the container reports no local image id" ;;
esac

BINARY_SHA_SEEN=""
for _ in $(seq 1 "$ATTEMPTS"); do
  BINARY_SHA_SEEN="$(docker exec "$CONTAINER" sha256sum "$BINARY_PATH" 2>/dev/null | cut -d" " -f1)"
  [ -n "$BINARY_SHA_SEEN" ] && break
  sleep "$PAUSE"
done
if [ "$BINARY_SHA_SEEN" = "$BINARY_SHA" ]; then
  pass "installed $BINARY_PATH SHA-256 equals the frozen binary identity"
else
  fail "installed $BINARY_PATH SHA-256 is ${BINARY_SHA_SEEN:-<none>}, expected $BINARY_SHA"
fi

# Read the FULL version output. The earlier form piped through `head -1`, which closes the pipe
# after the first line and can turn a transient short read into what looks like a wrong version.
# The assertion itself is unchanged: the reported version MUST still contain the qualified string.
VERSION_OUT=""
for _ in $(seq 1 "$ATTEMPTS"); do
  VERSION_OUT="$(docker exec "$CONTAINER" "$BINARY_PATH" version 2>&1)"
  [ -n "$VERSION_OUT" ] && break
  sleep "$PAUSE"
done
VERSION_LINE="$(printf '%s' "$VERSION_OUT" | sed -n '1p')"
if [ "$TARGET" = "caddy" ]; then
  case "$VERSION_OUT" in
    *"$UPSTREAM_COMMIT+modified"*) pass "version reports the qualified upstream commit and the local modification: $VERSION_LINE" ;;
    *) fail "version output does not report $UPSTREAM_COMMIT+modified: ${VERSION_LINE:-<none>}" ;;
  esac
else
  case "$VERSION_OUT" in
    *"$UPSTREAM_TAG"*) pass "version reports the qualified upstream release $UPSTREAM_TAG: $VERSION_LINE" ;;
    *) fail "version output does not report $UPSTREAM_TAG: ${VERSION_LINE:-<none>}" ;;
  esac
fi

echo "W27 exact-digest runtime identity ($TARGET): $([ "$FAILURES" -eq 0 ] && echo PASS || echo FAIL) ($FAILURES failure(s))"
[ "$FAILURES" -eq 0 ]
