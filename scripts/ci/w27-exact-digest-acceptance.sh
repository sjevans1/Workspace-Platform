#!/usr/bin/env bash
# W27 exact-digest acceptance for the two patched-upstream artifacts.
#
# The acceptance runs against ONE immutable digest and proves the identity chain end to end:
#
#   runtime container  ==  consumer definition (compose.yaml or the CI service)
#                      ==  provenance record (ci/w27-patched-images.json)
#                      ==  resolver output (scripts/w27-image-inventory.mjs)
#                      ==  the image the aggregate gate scanned (w27-evidence/<image>/identity.json)
#
# Image-level checks (Caddy version, Caddy configuration validation, SeaweedFS startup and its
# preserved runtime artifacts) run from the frozen digest itself. Service-level checks
# (reverse proxy, HTTP to HTTPS, trusted HTTPS, Secure-cookie behaviour, WSS collaboration, the
# S3 create/upload/download/list/delete path and the storage recovery path) run against the
# already-deployed stack, so the caller deploys first. The release pipeline deploys the stack in
# the same job that collects the security evidence; when running this by hand, bring the stack up
# before invoking it.
#
# Usage: scripts/ci/w27-exact-digest-acceptance.sh <caddy|seaweedfs> [repo-root] [evidence-dir]

set -uo pipefail

TARGET="${1:?usage: w27-exact-digest-acceptance.sh <caddy|seaweedfs> [repo-root] [evidence-dir]}"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
EVIDENCE_DIR="${3:-$ROOT/w27-evidence}"
WORK="$(mktemp -d)"
FAILURES=0
PASSES=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

pass() {
  PASSES=$((PASSES + 1))
  printf '  PASS  %s\n' "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf '  FAIL  %s\n' "$1"
}

check() { # $1 = description, rest = command
  local description="$1"
  shift
  if "$@" >"$WORK/check.log" 2>&1; then
    pass "$description"
  else
    fail "$description"
    sed 's/^/        /' "$WORK/check.log" | tail -5
  fi
}

case "$TARGET" in
  caddy)
    SERVICE="caddy"
    REF_VAR="W27_CADDY_REF"
    RECORD_NAME="caddy"
    CONSUMER_FILE="$ROOT/compose.yaml"
    ;;
  seaweedfs)
    SERVICE="seaweedfs"
    REF_VAR="W27_SEAWEEDFS_REF"
    RECORD_NAME="seaweedfs"
    CONSUMER_FILE="$ROOT/.github/workflows/ci.yml"
    ;;
  *)
    echo "unknown target: $TARGET (expected caddy or seaweedfs)" >&2
    exit 2
    ;;
esac

echo "W27 exact-digest acceptance: $TARGET"
echo

# ---------------------------------------------------------------------------------------------
# 1. Identity chain
# ---------------------------------------------------------------------------------------------
echo "Identity chain"

resolver_env="$(cd "$ROOT" && node scripts/w27-image-inventory.mjs)" || {
  echo "the release-image resolver refused this repository" >&2
  exit 1
}
REFERENCE="$(printf '%s\n' "$resolver_env" | sed -n "s/^${REF_VAR}=//p")"
DIGEST="${REFERENCE#*@}"
provenance="$(node -e '
  const fs = require("fs");
  const [file, name] = process.argv.slice(1);
  const record = JSON.parse(fs.readFileSync(file, "utf8")).images.find((image) => image.logicalName === name);
  process.stdout.write(`${record.ghcrPackage}@${record.finalImageDigest}`);
' "$ROOT/ci/w27-patched-images.json" "$RECORD_NAME")"
scanned="$(node -e '
  const fs = require("fs");
  const [file] = process.argv.slice(1);
  process.stdout.write(JSON.parse(fs.readFileSync(file, "utf8")).reference);
' "$EVIDENCE_DIR/$RECORD_NAME/identity.json" 2>/dev/null)"

printf '  reference: %s\n' "$REFERENCE"
for leg in "resolver:$REFERENCE" "provenance:$provenance" "evidence:$scanned"; do
  name="${leg%%:*}"
  value="${leg#*:}"
  if [ -z "$value" ]; then
    fail "$name does not resolve an identity for $RECORD_NAME"
  elif [ "$value" = "$REFERENCE" ]; then
    pass "$name digest equals the frozen digest"
  else
    fail "$name digest is $value, expected $REFERENCE"
  fi
done

if grep -Fq "$REFERENCE" "$CONSUMER_FILE"; then
  pass "consumer definition consumes exactly the frozen digest ($(basename "$CONSUMER_FILE"))"
else
  fail "consumer definition does not consume $REFERENCE"
fi

if [ "$TARGET" = "caddy" ] && grep -qE 'workspace-ci-mirror-caddy@sha256:' "$CONSUMER_FILE"; then
  fail "compose still consumes the Caddy mirror instead of the patched runtime"
else
  pass "no mirror reference remains where the patched artifact is required"
fi

# runtime leg: the actually running container. The container is discovered by the image it runs
# rather than by a Compose service name, because in CI the SeaweedFS runtime is a workflow service
# container rather than a Compose service.
container=""
for candidate in $(docker ps -q); do
  if [ "$(docker inspect --format '{{.Image}}' "$candidate")" = "$DIGEST" ]; then
    container="$candidate"
    break
  fi
done
if [ -n "$container" ]; then
  runtime_id="$(docker inspect --format '{{.Image}}' "$container")"
  runtime_ref="$(docker inspect --format '{{index .Config.Image}}' "$container")"
  runtime_name="$(docker inspect --format '{{.Name}}' "$container" | sed 's|^/||')"
  if [ "$runtime_id" = "$DIGEST" ]; then
    pass "runtime container $runtime_name image id equals the frozen digest"
  else
    fail "runtime container image id is $runtime_id, expected $DIGEST"
  fi
  if [ "$runtime_ref" = "$REFERENCE" ]; then
    pass "runtime container was started from the frozen reference"
  else
    fail "runtime container reference is $runtime_ref"
  fi
else
  fail "no running container is using $REFERENCE: the service-level acceptance cannot be evaluated"
fi
echo

# ---------------------------------------------------------------------------------------------
# 2. Image-level acceptance from the frozen digest
# ---------------------------------------------------------------------------------------------
echo "Image-level acceptance"

if [ "$TARGET" = "caddy" ]; then
  version="$(docker run --rm --entrypoint /usr/bin/caddy "$REFERENCE" version 2>"$WORK/version.err" | head -1)"
  case "$version" in
    *72dd0fb067f6d7826c7f79907670ba4a713bfe37+modified*)
      pass "caddy version reports the qualified upstream commit and the local modification: $version" ;;
    *)
      fail "caddy version is ${version:-<none>} (expected the 72dd0fb0 commit with +modified)" ;;
  esac
  check "caddy validate accepts the shipped Caddyfile" \
    docker run --rm --entrypoint /usr/bin/caddy "$REFERENCE" validate --config /etc/caddy/Caddyfile
  check "the qualified patched binary is the installed one" \
    bash -c "test \"\$(docker run --rm --entrypoint sha256sum '$REFERENCE' /usr/bin/caddy | cut -d' ' -f1)\" = 90e5f85f9a206ea63bdc146d75c54e0ec5c8ca4d245605f0c1570706ed4a38e5"
  check "runtime base layout is preserved (/etc/caddy, /data, /config)" \
    bash -c "docker run --rm --entrypoint sh '$REFERENCE' -c 'test -e /etc/caddy && test -e /data && test -e /config'"
else
  check "the qualified patched weed binary is the installed one" \
    bash -c "test \"\$(docker run --rm --entrypoint sha256sum '$REFERENCE' /usr/bin/weed | cut -d' ' -f1)\" = ff8d09e4a8c921f35a7a65b988c541d74f0b01725197ddb7fdf5728f2be37cb2"
  check "weed reports the qualified upstream version" \
    bash -c "docker run --rm --entrypoint /usr/bin/weed '$REFERENCE' version | grep -q '4.48'"
  check "the inherited Rust artifacts are present and unchanged" \
    bash -c "docker run --rm --entrypoint sh '$REFERENCE' -c 'test \"\$(sha256sum /usr/bin/weed-volume | cut -d\" \" -f1)\" = 8b271bc326f593c1b3b7f5d90091b0ef789c89023c34dec908c919f8614384d1 && test \"\$(sha256sum /usr/bin/weed-worker | cut -d\" \" -f1)\" = 9f10828f88b4ca4e1b770af68bbe5c9a38ca06623b187cfe6fd08238e9677fca'"
fi
echo

# ---------------------------------------------------------------------------------------------
# 3. Service-level acceptance against the deployed stack
# ---------------------------------------------------------------------------------------------
if [ -z "$container" ]; then
  echo "Service-level acceptance skipped: no running $SERVICE container"
  echo
  echo "W27 exact-digest acceptance ($TARGET): FAIL ($FAILURES failure(s), $PASSES check(s) passed)"
  exit 1
fi

echo "Service-level acceptance"

if [ "$TARGET" = "caddy" ]; then
  BASE_URL="${E2E_BASE_URL:-https://workspace.test}"
  HOST_PORT="${HTTPS_PORT:-443}"
  # The internal CA is generated by Caddy at first start; extract it from the running container
  # so trusted HTTPS is verified against the real chain rather than with certificate validation
  # disabled.
  for _ in $(seq 1 30); do
    if docker cp "$container:/data/caddy/pki/authorities/local/root.crt" "$WORK/root.crt" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ -s "$WORK/root.crt" ]; then
    pass "extracted the Caddy internal root CA from the running container"
  else
    fail "could not extract the Caddy internal root CA"
  fi

  resolve=("--resolve" "workspace.test:${HOST_PORT}:127.0.0.1")

  redirect="$(curl -sS -o /dev/null -w '%{http_code}' "${resolve[@]}" -H 'Host: workspace.test' "http://127.0.0.1:${HTTP_PORT:-80}/ready" 2>/dev/null)"
  if [ "$redirect" = "308" ]; then
    pass "HTTP to HTTPS redirects with 308"
  else
    fail "HTTP to HTTPS returned ${redirect:-<none>} instead of 308"
  fi

  ready="$(curl -sS -o /dev/null -w '%{http_code}' "${resolve[@]}" --cacert "$WORK/root.crt" "$BASE_URL/ready" 2>/dev/null)"
  if [ "$ready" = "200" ]; then
    pass "trusted HTTPS through Caddy reaches the API readiness route (chain verified against the internal CA)"
  else
    fail "trusted HTTPS returned ${ready:-<none>} instead of 200"
  fi

  hsts="$(curl -sS -D - -o /dev/null "${resolve[@]}" --cacert "$WORK/root.crt" "$BASE_URL/ready" 2>/dev/null | tr -d '\r' | grep -i '^strict-transport-security:' | head -1)"
  case "$hsts" in
    *max-age=31536000*) pass "HSTS is served through the reverse proxy" ;;
    *) fail "HSTS header missing or wrong: ${hsts:-<none>}" ;;
  esac

  metrics="$(curl -sS -o /dev/null -w '%{http_code}' "${resolve[@]}" --cacert "$WORK/root.crt" "$BASE_URL/metrics" 2>/dev/null)"
  if [ "$metrics" = "401" ]; then
    pass "the reverse proxy routes /metrics to the API and the credentialless read is refused"
  else
    fail "reverse-proxied /metrics returned ${metrics:-<none>} instead of 401"
  fi

  # Secure-cookie behaviour: complete first-run setup over trusted HTTPS and inspect the cookie
  # the API issues. A session cookie must be Secure, HttpOnly and SameSite=Lax.
  setup_required="$(curl -sS "${resolve[@]}" --cacert "$WORK/root.crt" "$BASE_URL/api/v1/setup" 2>/dev/null | tr -d ' ')"
  if printf '%s' "$setup_required" | grep -q '"required":true'; then
    setup_token="$(sed -n 's/^SETUP_TOKEN=//p' "$ROOT/.env" 2>/dev/null)"
    cookie_header="$(curl -sS -D - -o "$WORK/setup.json" "${resolve[@]}" --cacert "$WORK/root.crt" \
      -X POST "$BASE_URL/api/v1/setup" \
      -H 'content-type: application/json' \
      -H "x-setup-token: ${setup_token}" \
      -d '{"organisation":"OpenJM","workspace":"Team workspace","name":"Shane Evans","email":"browser@example.test","password":"browser-password-123"}' 2>/dev/null | tr -d '\r')"
  else
    cookie_header="$(curl -sS -D - -o "$WORK/setup.json" "${resolve[@]}" --cacert "$WORK/root.crt" \
      -X POST "$BASE_URL/api/v1/auth/login" \
      -H 'content-type: application/json' \
      -d '{"email":"browser@example.test","password":"browser-password-123"}' 2>/dev/null | tr -d '\r')"
  fi
  session_cookie="$(printf '%s\n' "$cookie_header" | grep -i '^set-cookie: workspace_session=' | head -1)"
  if [ -z "$session_cookie" ]; then
    fail "no workspace_session cookie was issued over HTTPS"
  else
    case "$session_cookie" in *Secure*) pass "the session cookie is Secure" ;; *) fail "the session cookie is not Secure" ;; esac
    case "$session_cookie" in *HttpOnly*) pass "the session cookie is HttpOnly" ;; *) fail "the session cookie is not HttpOnly" ;; esac
    case "$session_cookie" in *SameSite=Lax*) pass "the session cookie is SameSite=Lax" ;; *) fail "the session cookie is not SameSite=Lax" ;; esac
  fi

  # WSS collaboration path through the reverse proxy, carrying the session cookie.
  session_value="$(printf '%s\n' "$session_cookie" | sed -n 's/.*workspace_session=\([^;]*\).*/\1/p')"
  node -e '
    const tls = require("node:tls");
    const fs = require("node:fs");
    const [caFile, cookie, port] = process.argv.slice(1);
    const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString("base64");
    const socket = tls.connect({ host: "127.0.0.1", port: Number(port), servername: "workspace.test", ca: fs.readFileSync(caFile) }, () => {
      socket.write(
        [
          "GET /collaboration HTTP/1.1",
          "Host: workspace.test",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          cookie ? `Cookie: workspace_session=${cookie}` : null,
          "",
          "",
        ]
          .filter((line) => line !== null)
          .join("\r\n"),
      );
    });
    let data = "";
    socket.setTimeout(10000);
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      const first = data.split("\r\n")[0];
      if (/ 101 /.test(first)) {
        console.log("101");
        socket.destroy();
        process.exit(0);
      }
      if (data.includes("\r\n\r\n")) {
        console.log(first);
        socket.destroy();
        process.exit(1);
      }
    });
    socket.on("timeout", () => {
      console.log("<timeout>");
      process.exit(1);
    });
    socket.on("error", (error) => {
      console.log(`<error: ${error.message}>`);
      process.exit(1);
    });
  ' "$WORK/root.crt" "$session_value" "${HTTPS_PORT:-443}" >"$WORK/wss.log" 2>&1
  if [ "$(cat "$WORK/wss.log")" = "101" ]; then
    pass "WSS collaboration upgrades through Caddy (101 Switching Protocols)"
  else
    fail "WSS collaboration did not upgrade: $(cat "$WORK/wss.log")"
  fi
else
  # SeaweedFS: S3 create/setup, upload, download, list, delete and the storage recovery path,
  # driven through the repository's own acceptance harnesses against this exact service.
  S3_HOST_ENDPOINT="http://127.0.0.1:${S3_PORT:-8333}"
  check "the service accepts a TCP connection on its S3 port (service startup)" \
    bash -c "exec 3<>/dev/tcp/127.0.0.1/${S3_PORT:-8333}"
  # S3 bucket create/setup, exactly as the release pipeline prepares the acceptance service.
  bucket_setup() {
    cd "$ROOT" || return 1
    S3_ACCEPT_ENDPOINT="$S3_HOST_ENDPOINT" \
      S3_ACCEPT_ACCESS_KEY="${S3_ACCESS_KEY:-workspace-ci}" \
      S3_ACCEPT_SECRET_KEY="${S3_SECRET_KEY:-workspace-ci-secret}" \
      node --input-type=module -e '
        import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
        const client = new S3Client({
          endpoint: process.env.S3_ACCEPT_ENDPOINT,
          region: "us-east-1",
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.S3_ACCEPT_ACCESS_KEY,
            secretAccessKey: process.env.S3_ACCEPT_SECRET_KEY,
          },
        });
        for (const Bucket of ["openjm-acceptance-source", "openjm-acceptance-recovery"]) {
          try {
            await client.send(new CreateBucketCommand({ Bucket }));
          } catch (error) {
            if (error?.name !== "BucketAlreadyOwnedByYou") throw error;
          }
        }
        client.destroy();
      '
  }
  if bucket_setup >"$WORK/bucket-setup.log" 2>&1; then
    pass "S3 bucket create/setup on the exact-digest service"
  else
    fail "S3 bucket create/setup failed"
    tail -10 "$WORK/bucket-setup.log" | sed 's/^/        /'
  fi
  # The harnesses write through the real storage layer and the real recovery path.
  ( cd "$ROOT" && \
    TEST_DATABASE_URL="${TEST_DATABASE_URL:-}" \
    S3_ACCEPT_PROVIDER_LABEL=SeaweedFS-exact-digest \
    S3_ACCEPT_ENDPOINT="$S3_HOST_ENDPOINT" \
    S3_ACCEPT_ACCESS_KEY="${S3_ACCESS_KEY:-workspace-ci}" \
    S3_ACCEPT_SECRET_KEY="${S3_SECRET_KEY:-workspace-ci-secret}" \
    S3_ACCEPT_SOURCE_BUCKET=openjm-acceptance-source \
    S3_ACCEPT_RECOVERY_BUCKET=openjm-acceptance-recovery \
    S3_ACCEPT_ALLOW_INSECURE=true \
    S3_ACCEPT_WRITE_CONFIRMATION=I_UNDERSTAND_THIS_WRITES_TEST_OBJECTS \
    npm run accept:s3 ) >"$WORK/accept-s3.log" 2>&1
  if [ $? -eq 0 ]; then
    pass "S3 acceptance: bucket setup, upload, download, list, delete and storage recovery"
  else
    fail "S3 acceptance harness failed"
    tail -20 "$WORK/accept-s3.log" | sed 's/^/        /'
  fi
fi

echo
echo "W27 exact-digest acceptance ($TARGET): $([ "$FAILURES" -eq 0 ] && echo PASS || echo FAIL) ($FAILURES failure(s), $PASSES check(s) passed)"
echo "  accepted reference: $REFERENCE"
[ "$FAILURES" -eq 0 ]
