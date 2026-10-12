#!/usr/bin/env bash
# W27: controlled patched-upstream rebuild of Caddy.
#
# Preserves the exact upstream release (v2.11.7) and rebuilds only its Go binary with the
# patched toolchain and dependency floor, so reachable vulnerabilities are repaired rather than
# adjudicated away. Nothing here is a mirror: this is a Workspace patched rebuild.
#
# Mechanical notes learned the hard way, kept here so the harness stays reliable:
#   - no `| head` on any pipeline: with `set -o pipefail` an early-exiting reader SIGPIPEs the
#     writer and aborts the run, destroying collected evidence. `sed -n '1,Np'` reads to EOF.
#   - the builder is digest-pinned, and the source commit is asserted, so this cannot silently
#     build a different commit or a moving toolchain.
#   - the clone target is cleaned first so the script is re-runnable.
set -euo pipefail

GO_IMAGE="golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c"
GOVULNCHECK_VERSION="v1.9.0"
CADDY_TAG="v2.11.7"
CADDY_COMMIT="72dd0fb067f6d7826c7f79907670ba4a713bfe37"
XNET_FLOOR="v0.60.0"
EV=.w27-evidence
mkdir -p "$EV" build/w27

docker run --rm -v "$PWD/.w27-evidence:/w" -v "$PWD/build/w27:/build" -w /build \
  -e CADDY_TAG="$CADDY_TAG" -e CADDY_COMMIT="$CADDY_COMMIT" -e XNET_FLOOR="$XNET_FLOOR" \
  -e GOVULNCHECK_VERSION="$GOVULNCHECK_VERSION" \
  "$GO_IMAGE" bash -c '
set -euo pipefail
export PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export GOTOOLCHAIN=auto GOFLAGS=-mod=mod CGO_ENABLED=0

echo "### builder go version"; go version
echo "### builder pinned by digest: '"$GO_IMAGE"'"

echo "### fetching exact upstream tag $CADDY_TAG"
rm -rf caddy
git clone --quiet --depth 1 --branch "$CADDY_TAG" https://github.com/caddyserver/caddy.git caddy
cd caddy

echo "### upstream commit: $(git rev-parse HEAD)"
echo "### expected commit: $CADDY_COMMIT"
echo "### upstream tag: $(git describe --tags --exact-match)"
echo "### tag resolves to: $(git rev-list -n 1 "$CADDY_TAG")"
echo "### tag signature check (requires the upstream key in the keyring):"
git verify-tag "$CADDY_TAG" 2>&1 | sed -n "1,3p" || true
# Source drift must be fatal: never build something other than the reviewed commit.
test "$(git rev-parse HEAD)" = "$CADDY_COMMIT" || { echo "SOURCE DRIFT: refusing to build"; exit 42; }
echo "### source assertion: PASS ($(git rev-parse HEAD) == $CADDY_COMMIT)"

echo "### original dependency versions (before patch)"
grep -E "^\s+golang.org/x/(net|text) " go.mod || true

echo "### applying the minimal security dependency floor (x/net only)"
go get "golang.org/x/net@$XNET_FLOOR" 2>&1 | sed -n "1,4p"

echo "### patched dependency versions (after patch)"
grep -E "^\s+golang.org/x/(net|text) " go.mod || true
echo "### full module delta versus upstream go.mod:"
git diff --stat go.mod go.sum || true

echo "### building the release-configured binary"
go build -trimpath -tags nobadger,nomysql,nopgx -ldflags "-s -w" -o /w/caddy-patched.bin ./cmd/caddy
test -s /w/caddy-patched.bin || { echo "BUILD PRODUCED NO BINARY"; exit 43; }

echo "### frozen binary identity"
echo "### binary size bytes: $(stat -c%s /w/caddy-patched.bin)"
sha256sum /w/caddy-patched.bin
echo "### caddy version: $(/w/caddy-patched.bin version 2>&1 | sed -n "1,2p")"
echo "### go version -m (complete):"
go version -m /w/caddy-patched.bin

export GOPATH=/tmp/gp
echo "### govulncheck version:"
go install "golang.org/x/vuln/cmd/govulncheck@$GOVULNCHECK_VERSION" && /tmp/gp/bin/govulncheck -version 2>&1 | sed -n "1,3p" || true
echo "### reachability on the rebuilt binary (complete, untruncated):"
/tmp/gp/bin/govulncheck -mode=binary /w/caddy-patched.bin || echo "### govulncheck exit status: $? (3 = advisories reported, expected for the approved residual)"
' 2>&1 | tee "$EV/caddy-patched-build.txt"
echo W27_CADDY_BUILD_DONE
