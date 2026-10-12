#!/usr/bin/env bash
# W27: controlled patched-upstream rebuild of Caddy.
#
# Preserves the exact upstream release (v2.11.7) and rebuilds only its Go binary with the
# patched toolchain and dependency floor, so reachable vulnerabilities are repaired rather than
# adjudicated away. Nothing here is a mirror: this is a Workspace patched rebuild.
set -euo pipefail
GO_IMAGE="golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c"
CADDY_TAG="v2.11.7"
XNET_FLOOR="v0.60.0"
EV=.w27-evidence
mkdir -p "$EV" build/w27

docker run --rm -v "$PWD/.w27-evidence:/w" -v "$PWD/build/w27:/build" -w /build "$GO_IMAGE" bash -c "
set -euo pipefail
export PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:\$PATH
export GOTOOLCHAIN=auto GOFLAGS=-mod=mod CGO_ENABLED=0
echo '### builder go version'; go version
echo '### fetching exact upstream tag $CADDY_TAG'
rm -rf caddy && git clone --quiet --depth 1 --branch $CADDY_TAG https://github.com/caddyserver/caddy.git caddy >/dev/null 2>&1
cd caddy
echo \"### upstream commit: \$(git rev-parse HEAD)\"
echo \"### upstream tag: \$(git describe --tags --exact-match)\"
echo '### original dependency versions (before patch)'
grep -E '^\s+golang.org/x/(net|text) ' go.mod || true
echo '### applying the minimal security dependency floor'
go get golang.org/x/net@$XNET_FLOOR 2>&1 | tail -2
echo '### patched dependency versions (after patch)'
grep -E '^\s+golang.org/x/(net|text) ' go.mod || true
echo '### building /usr/bin/caddy equivalent'
go build -trimpath -tags nobadger,nomysql,nopgx -ldflags '-s -w' -o /w/caddy-patched.bin ./cmd/caddy 2>&1 | tail -5
echo '### built binary identity'
sha256sum /w/caddy-patched.bin
/w/caddy-patched.bin version || true
echo '### embedded build info: go and dependency versions'
go version -m /w/caddy-patched.bin | grep -E '^\s+(mod|dep)\s+(golang.org/x/(net|text)|.)' | grep -E 'golang.org/x/(net|text)' || true
go version -m /w/caddy-patched.bin | head -3
echo '### reachability on the rebuilt binary'
export GOPATH=/tmp/gp
go install golang.org/x/vuln/cmd/govulncheck@latest >/dev/null 2>&1
/tmp/gp/bin/govulncheck -mode=binary /w/caddy-patched.bin 2>&1
" 2>&1 | tee "$EV/caddy-patched-build.txt"
echo W27_CADDY_BUILD_DONE
