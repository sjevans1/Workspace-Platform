#!/usr/bin/env bash
# W27: build the patched Caddy runtime image from a freshly generated binary.
#
# The binary is never committed. This runs the reproducer, verifies the result against the frozen
# identity recorded in docs/security/W27_PATCHED_REBUILD.md, stages it into a temporary Docker
# build context, builds the patched image, and removes the temporary material.
set -euo pipefail

EXPECTED_SHA="90e5f85f9a206ea63bdc146d75c54e0ec5c8ca4d245605f0c1570706ed4a38e5"
IMAGE="${W27_CADDY_IMAGE:-ghcr.io/sjevans1/workspace-runtime-caddy}"
TAG="${W27_CADDY_TAG:-w27-patched}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

cd "$ROOT"
bash build/w27/build-caddy-patched.sh

generated="$ROOT/.w27-evidence/caddy-patched.bin"
test -s "$generated" || { echo "no generated binary at $generated"; exit 1; }
actual="$(sha256sum "$generated" | cut -d' ' -f1)"
test "$actual" = "$EXPECTED_SHA" || { echo "binary identity mismatch: expected $EXPECTED_SHA got $actual"; exit 1; }
echo "verified generated binary matches the frozen identity"

ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
cp "$ROOT/build/w27/images/caddy/Dockerfile.patched" "$ctx/Dockerfile"
cp "$generated" "$ctx/caddy-patched.bin"
docker build -f "$ctx/Dockerfile" -t "$IMAGE:$TAG" "$ctx"
rm -rf "$ctx"

docker run --rm --entrypoint /usr/bin/caddy "$IMAGE:$TAG" version
echo "built $IMAGE:$TAG from a verified generated binary; temporary context removed"
