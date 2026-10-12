#!/usr/bin/env bash
# W27: build the patched SeaweedFS acceptance image from a freshly generated binary.
# The binary is never committed: reproduce, verify against the frozen identity, stage into a
# temporary Docker build context, build, then remove the temporary material.
set -euo pipefail
EXPECTED_SHA="ff8d09e4a8c921f35a7a65b988c541d74f0b01725197ddb7fdf5728f2be37cb2"
IMAGE="${W27_SW_IMAGE:-ghcr.io/sjevans1/workspace-acceptance-seaweedfs}"
TAG="${W27_SW_TAG:-w27-patched}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
bash build/w27/build-seaweedfs-patched.sh
generated="$ROOT/.w27-evidence/weed-patched.bin"
test -s "$generated" || { echo "no generated binary at $generated"; exit 1; }
actual="$(sha256sum "$generated" | cut -d' ' -f1)"
test "$actual" = "$EXPECTED_SHA" || { echo "binary identity mismatch: expected $EXPECTED_SHA got $actual"; exit 1; }
EXPECTED_BASE="sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
resolved="$(docker image inspect docker.io/chrislusf/seaweedfs:4.48 --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//')"
test -n "$resolved" || { echo "runtime base not present locally"; exit 1; }
test "$resolved" = "$EXPECTED_BASE" || { echo "RUNTIME BASE MISMATCH: expected $EXPECTED_BASE got $resolved"; exit 1; }
echo "runtime base identity verified: $resolved (linux/amd64)"

ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
cp "$ROOT/build/w27/images/seaweedfs/Dockerfile.patched" "$ctx/Dockerfile"
cp "$generated" "$ctx/weed-patched.bin"
docker build -f "$ctx/Dockerfile" -t "$IMAGE:$TAG" "$ctx"
rm -rf "$ctx"
docker run --rm --entrypoint sh "$IMAGE:$TAG" -c 'sha256sum /usr/bin/weed'
echo "built $IMAGE:$TAG from a verified generated binary; temporary context removed"
