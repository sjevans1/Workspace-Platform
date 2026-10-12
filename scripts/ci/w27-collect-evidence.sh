#!/usr/bin/env bash
# W27 phase 1: six-image evidence collection.
#
# This script NEVER decides and NEVER aborts on a scanner failure. It records what it could
# collect for each of the six qualification images, records what failed in
# <evidence>/<image>/collection-errors.txt, and keeps going, so one broken image cannot hide
# the evidence for the other five. The single blocking aggregate evaluator
# (scripts/w27-security-aggregate.mjs) is the only component that decides PASS/FAIL.
#
# Evidence produced per image:
#   identity.json             exact image identity (reference, resolved image id, provenance class)
#   sbom.cdx.json             CycloneDX SBOM
#   trivy-raw.json            raw scanner JSON, every severity, unfixed included
#   trivy-all-findings.txt    human-readable all-findings report
#   trivy-fixable.json        raw scanner JSON under the blocking policy (fixable HIGH/CRITICAL)
#   reachability.json         where the policy requires reachability evidence
#   vex.json                  where the policy requires a VEX disposition (PostgreSQL only)
#
# Usage: scripts/ci/w27-collect-evidence.sh [evidence-dir] [repo-root]
#
# Environment:
#   TRIVY_BIN            trivy executable (default: trivy)
#   SYFT_BIN             syft executable (default: syft)
#   GOVULNCHECK_IMAGE    digest-pinned golang image used to run pinned govulncheck
#   GOVULNCHECK_VERSION  pinned govulncheck version (default: v1.9.0)
#   W27_SKIP_REACHABILITY  set to 1 to collect everything except reachability evidence

set -uo pipefail

EVIDENCE_DIR="${1:-w27-evidence}"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TRIVY_BIN="${TRIVY_BIN:-trivy}"
SYFT_BIN="${SYFT_BIN:-syft}"
GOVULNCHECK_IMAGE="${GOVULNCHECK_IMAGE:-golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c}"
GOVULNCHECK_VERSION="${GOVULNCHECK_VERSION:-v1.9.0}"
W27_SKIP_REACHABILITY="${W27_SKIP_REACHABILITY:-0}"

IMAGES="${W27_IMAGES:-workspace clamav postgres caddy valkey seaweedfs}"
# Reachability is required by the policy for these images, together with the binary that carries
# the findings inside the image.
REACHABILITY_BINARIES="postgres:/usr/local/bin/gosu caddy:/usr/bin/caddy seaweedfs:/usr/bin/weed"
VEX_IMAGE="postgres"

record_error() { # $1 = image dir, $2 = step, $3 = message
  printf '%s\t%s\n' "$2" "$3" >>"$1/collection-errors.txt"
}

mkdir -p "$EVIDENCE_DIR"
EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd)"

# ---------------------------------------------------------------------------------------------
# Resolver record. The workflow resolves the references itself; when this script runs on its own
# it produces the same record so the evaluator validates identical inputs.
# ---------------------------------------------------------------------------------------------
if [ ! -f "$EVIDENCE_DIR/resolver.json" ]; then
  ( cd "$ROOT" && node scripts/w27-image-inventory.mjs ) >"$EVIDENCE_DIR/resolver.env" 2>"$EVIDENCE_DIR/resolver.err"
  status=$?
  node -e '
    const fs = require("fs");
    const [dir, code] = process.argv.slice(1);
    fs.writeFileSync(
      require("path").join(dir, "resolver.json"),
      JSON.stringify(
        {
          command: "node scripts/w27-image-inventory.mjs",
          exitCode: Number(code),
          stdout: fs.readFileSync(require("path").join(dir, "resolver.env"), "utf8"),
          stderr: fs.readFileSync(require("path").join(dir, "resolver.err"), "utf8"),
        },
        null,
        2,
      ) + "\n",
    );
  ' "$EVIDENCE_DIR" "$status"
fi

# shellcheck disable=SC1090
. "$EVIDENCE_DIR/resolver.env" 2>/dev/null || true

reference_for() {
  case "$1" in
    workspace) printf '%s' "${W27_WORKSPACE_REF:-}" ;;
    clamav) printf '%s' "${W27_CLAMAV_REF:-}" ;;
    postgres) printf '%s' "${W27_POSTGRES_REF:-}" ;;
    caddy) printf '%s' "${W27_CADDY_REF:-}" ;;
    valkey) printf '%s' "${W27_VALKEY_REF:-}" ;;
    seaweedfs) printf '%s' "${W27_SEAWEEDFS_REF:-}" ;;
  esac
}

provenance_for() {
  case "$1" in
    workspace | clamav) printf 'built-local' ;;
    postgres) printf 'mirror' ;;
    caddy | seaweedfs) printf 'patched-upstream' ;;
    valkey) printf 'immutable-non-mirror' ;;
  esac
}

kind_for() {
  case "$1" in
    workspace | clamav) printf 'local-build' ;;
    *) printf 'registry-digest' ;;
  esac
}

reachability_binary_for() {
  for entry in $REACHABILITY_BINARIES; do
    if [ "${entry%%:*}" = "$1" ]; then
      printf '%s' "${entry#*:}"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# Scanners. Each is guarded: a failure is recorded, never fatal.
# ---------------------------------------------------------------------------------------------
scan_image() { # $1 = image ref, $2 = image dir
  local ref="$1" dir="$2"
  if ! "$TRIVY_BIN" image --format json --scanners vuln --output "$dir/trivy-raw.json" "$ref" >/dev/null 2>"$dir/trivy-raw.err"; then
    record_error "$dir" "trivy-raw" "trivy exited non-zero; $(tail -c 400 "$dir/trivy-raw.err" | tr '\n' ' ')"
  fi
  if ! "$TRIVY_BIN" image --format table --scanners vuln --output "$dir/trivy-all-findings.txt" "$ref" >/dev/null 2>"$dir/trivy-all-findings.err"; then
    record_error "$dir" "trivy-all-findings" "trivy exited non-zero; $(tail -c 400 "$dir/trivy-all-findings.err" | tr '\n' ' ')"
  fi
  # The blocking-policy scan is evidence here, not a decision: exit code 1 means "findings
  # exist", which the aggregate evaluator adjudicates. A non-zero exit is therefore not an
  # error by itself; only a missing or unreadable result file is.
  "$TRIVY_BIN" image --format json --scanners vuln --ignore-unfixed --severity HIGH,CRITICAL \
    --output "$dir/trivy-fixable.json" "$ref" >/dev/null 2>"$dir/trivy-fixable.err"
  if [ ! -s "$dir/trivy-fixable.json" ]; then
    record_error "$dir" "trivy-fixable" "no fixable-result file produced; $(tail -c 400 "$dir/trivy-fixable.err" | tr '\n' ' ')"
  fi
}

generate_sbom() { # $1 = image ref, $2 = image dir
  local ref="$1" dir="$2"
  if ! "$SYFT_BIN" "registry:$ref" -o "cyclonedx-json=$dir/sbom.cdx.json" >/dev/null 2>"$dir/sbom.err"; then
    if ! "$SYFT_BIN" "$ref" -o "cyclonedx-json=$dir/sbom.cdx.json" >/dev/null 2>>"$dir/sbom.err"; then
      record_error "$dir" "sbom" "syft exited non-zero; $(tail -c 400 "$dir/sbom.err" | tr '\n' ' ')"
    fi
  fi
}

run_govulncheck() { # $1 = image ref, $2 = binary path, $3 = image dir
  local ref="$1" binpath="$2" dir="$3"
  local work
  work="$(mktemp -d)"
  local cid
  cid="$(docker create "$ref")" || {
    record_error "$dir" "govulncheck" "could not create a container from $ref"
    rm -rf "$work"
    return 0
  }
  if ! docker cp "$cid:$binpath" "$work/binary" >/dev/null 2>"$dir/govulncheck.err"; then
    record_error "$dir" "govulncheck" "could not extract $binpath from $ref"
    docker rm -f "$cid" >/dev/null 2>&1
    rm -rf "$work"
    return 0
  fi
  docker rm -f "$cid" >/dev/null 2>&1
  sha256sum "$work/binary" | cut -d' ' -f1 >"$work/binary.sha256"
  if ! docker run --rm -v "$work:/w" -w /w -e GOTOOLCHAIN=local -e GOFLAGS=-mod=mod "$GOVULNCHECK_IMAGE" \
    /bin/sh -c "set -e; export PATH=\$PATH:/usr/local/go/bin:\$(/usr/local/go/bin/go env GOPATH)/bin; /usr/local/go/bin/go install golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION} >/dev/null 2>&1; govulncheck -mode=binary -json /w/binary > /w/govulncheck.json" \
    >>"$dir/govulncheck.err" 2>&1; then
    record_error "$dir" "govulncheck" "pinned govulncheck run failed; $(tail -c 400 "$dir/govulncheck.err" | tr '\n' ' ')"
    rm -rf "$work"
    return 0
  fi
  if ! node "$ROOT/scripts/w27-normalize-reachability.mjs" \
    --govulncheck "$work/govulncheck.json" \
    --binary-sha "$work/binary.sha256" \
    --binary-path "$binpath" \
    --image "$ref" \
    --trivy "$dir/trivy-raw.json" \
    --out "$dir/reachability.json" >>"$dir/govulncheck.err" 2>&1; then
    record_error "$dir" "govulncheck" "could not normalize govulncheck output"
  fi
  rm -rf "$work"
}

write_identity() { # $1 = logical name, $2 = image ref, $3 = image dir
  local name="$1" ref="$2" dir="$3"
  local image_id architecture os_name repo_digests
  image_id="$(docker image inspect --format '{{.Id}}' "$ref" 2>"$dir/identity.err")"
  if [ -z "$image_id" ]; then
    record_error "$dir" "identity" "image $ref is not present locally; $(tail -c 300 "$dir/identity.err" | tr '\n' ' ')"
    return 0
  fi
  architecture="$(docker image inspect --format '{{.Architecture}}' "$ref" 2>/dev/null)"
  os_name="$(docker image inspect --format '{{.Os}}' "$ref" 2>/dev/null)"
  repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$ref" 2>/dev/null)"
  node -e '
    const fs = require("fs");
    const path = require("path");
    const [dir, name, ref, id, arch, os, repoDigests] = process.argv.slice(1);
    fs.writeFileSync(
      path.join(dir, "identity.json"),
      JSON.stringify(
        {
          schemaVersion: "1.0.0",
          logicalName: name,
          reference: ref,
          kind: ref.includes("@sha256:") ? "registry-digest" : "local-build",
          provenanceClass: process.env.W27_PROVENANCE_CLASS,
          resolvedImageId: id,
          architecture: arch,
          os,
          repoDigests: JSON.parse(repoDigests || "[]"),
        },
        null,
        2,
      ) + "\n",
    );
  ' "$dir" "$name" "$ref" "$image_id" "$architecture" "$os_name" "$repo_digests"
}

# ---------------------------------------------------------------------------------------------
# Collection loop.
# ---------------------------------------------------------------------------------------------
collect_image() {
  local name="$1"
  local dir="$EVIDENCE_DIR/$name"
  mkdir -p "$dir"
  : >"$dir/collection-errors.txt"
  local ref
  ref="$(reference_for "$name")"
  if [ -z "$ref" ]; then
    record_error "$dir" "resolve" "the inventory did not resolve a reference for $name"
    return 0
  fi
  W27_PROVENANCE_CLASS="$(provenance_for "$name")" write_identity "$name" "$ref" "$dir"
  scan_image "$ref" "$dir"
  generate_sbom "$ref" "$dir"
  if [ "$name" = "$VEX_IMAGE" ]; then
    # The VEX disposition is a reviewed repository artifact; the evidence bundle retains the
    # exact copy the evaluator validates against the policy.
    cp "$ROOT/docs/security/vex-gosu-postgres-17.11-bookworm.json" "$dir/vex.json" 2>/dev/null ||
      record_error "$dir" "vex" "could not copy the committed PostgreSQL VEX"
  fi
  if [ "$W27_SKIP_REACHABILITY" != "1" ]; then
    local binpath
    if binpath="$(reachability_binary_for "$name")"; then
      run_govulncheck "$ref" "$binpath" "$dir"
    fi
  fi
  rm -f "$dir"/*.err 2>/dev/null
  if [ -s "$dir/collection-errors.txt" ]; then
    echo "w27-evidence: $name collected with recorded failures"
  else
    echo "w27-evidence: $name collected"
  fi
}

for name in $IMAGES; do
  collect_image "$name"
done

"$TRIVY_BIN" --version >"$EVIDENCE_DIR/trivy-version.txt" 2>&1 || true
"$SYFT_BIN" --version >"$EVIDENCE_DIR/syft-version.txt" 2>&1 || true
echo "w27-evidence: phase 1 collection finished (no decision taken here)"
exit 0
