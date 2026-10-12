#!/usr/bin/env bash
# W27: controlled patched-upstream rebuild of SeaweedFS 4.48 (`weed`).
#
# Same discipline as the Caddy reproducer: digest-pinned builder, asserted source commit, minimal
# dependency delta, pinned analysis tool, no early-exiting pipelines (pipefail + `head` would
# SIGPIPE the run), re-runnable from a clean tree. Not a mirror: a Workspace patched acceptance
# artifact for optional S3 compatibility, not a shipped customer component.
set -euo pipefail

GO_IMAGE="golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c"
GOVULNCHECK_VERSION="v1.9.0"
SW_TAG="4.48"
SW_COMMIT="530be3e37337488ecc34d58441e0bc476e121c93"
XNET_FLOOR="v0.60.0"
EV=.w27-evidence
mkdir -p "$EV" build/w27

docker run --rm -v "$PWD/.w27-evidence:/w" -v "$PWD/build/w27:/build" -w /build \
  -e SW_TAG="$SW_TAG" -e SW_COMMIT="$SW_COMMIT" -e XNET_FLOOR="$XNET_FLOOR" \
  -e GOVULNCHECK_VERSION="$GOVULNCHECK_VERSION" \
  "$GO_IMAGE" bash -c '
set -euo pipefail
export PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export GOTOOLCHAIN=auto GOFLAGS=-mod=mod CGO_ENABLED=0

echo "### builder go version"; go version
echo "### builder pinned by digest: '"$GO_IMAGE"'"

echo "### fetching exact upstream tag $SW_TAG"
rm -rf seaweedfs
git clone --quiet --depth 1 --branch "$SW_TAG" https://github.com/seaweedfs/seaweedfs.git seaweedfs
cd seaweedfs

echo "### upstream commit: $(git rev-parse HEAD)"
echo "### expected commit: $SW_COMMIT"
echo "### upstream tag: $(git describe --tags --exact-match)"
test "$(git rev-parse HEAD)" = "$SW_COMMIT" || { echo "SOURCE DRIFT: refusing to build"; exit 42; }
echo "### source assertion: PASS"

echo "### original dependency versions (before patch)"
grep -E "^\s+golang.org/x/(net|text) " go.mod || true
echo "### applying the minimal security dependency floor (x/net only)"
go get "golang.org/x/net@$XNET_FLOOR" 2>&1 | sed -n "1,4p"
echo "### patched dependency versions (after patch)"
grep -E "^\s+golang.org/x/(net|text) " go.mod || true
echo "### module delta versus upstream:"
git diff --stat go.mod go.sum || true

echo "### building the release-configured weed binary (upstream default tags)"
go build -trimpath -ldflags "-s -w" -o /w/weed-patched.bin ./weed
test -s /w/weed-patched.bin || { echo "BUILD PRODUCED NO BINARY"; exit 43; }

echo "### frozen binary identity"
echo "### binary size bytes: $(stat -c%s /w/weed-patched.bin)"
sha256sum /w/weed-patched.bin
echo "### go version -m (complete):"
go version -m /w/weed-patched.bin | sed -n "1,12p"
echo "### weed version:"
/w/weed-patched.bin version 2>&1 | sed -n "1,3p" || true

export GOPATH=/tmp/gp
echo "### govulncheck version:"
go install "golang.org/x/vuln/cmd/govulncheck@$GOVULNCHECK_VERSION"
/tmp/gp/bin/govulncheck -version 2>&1 | sed -n "1,3p"
echo "### reachability on the rebuilt binary (complete, untruncated):"
/tmp/gp/bin/govulncheck -mode=binary /w/weed-patched.bin || echo "### govulncheck exit status: $? (3 = advisories reported)"
' 2>&1 | tee "$EV/seaweedfs-patched-build.txt"
echo W27_SEAWEEDFS_BUILD_DONE
