# W27 patched-upstream rebuilds (Caddy, SeaweedFS)

Provenance note: the `workspace-ci-mirror-*` images remain upstream byte-for-byte mirrors. The
artifacts described here are **Workspace patched upstream rebuilds**, not mirrors, and must never
be described or recorded as mirror-provenanced (`digestVerifiedEqual=true` does not apply).

## Caddy — controlled patched rebuild (reproducible, acceptance NOT yet met)

| Field | Value |
| --- | --- |
| Upstream project | `caddyserver/caddy` |
| Upstream tag | `v2.11.7` |
| Upstream commit | `72dd0fb067f6d7826c7f79907670ba4a713bfe37` (asserted in the build: the script fails with `SOURCE DRIFT` if `git rev-parse HEAD` differs) |
| Source fetch | `git clone --depth 1 --branch v2.11.7` from `https://github.com/caddyserver/caddy.git` |
| Builder image | `golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c` (digest-pinned), `go1.26.9 linux/amd64` |
| Analysis tool | `govulncheck@v1.9.0`, pinned (not `@latest`) |
| Original dependencies | `golang.org/x/net v0.59.0`, `golang.org/x/text v0.42.0` |
| Patched dependencies | `golang.org/x/net v0.60.0` only; `golang.org/x/text` retained at `v0.42.0` (minimal delta, no opportunistic upgrade) |
| Build tags | `nobadger,nomysql,nopgx` (matching the upstream release configuration) |
| Build flags | `CGO_ENABLED=0`, `-trimpath -ldflags '-s -w'` |
| **Frozen binary size** | **51,974,306 bytes** |
| **Frozen binary SHA-256** | **`90e5f85f9a206ea63bdc146d75c54e0ec5c8ca4d245605f0c1570706ed4a38e5`** |
| Binary version string | `v2.11.7+modified (72dd0fb0…)` |
| Reachability (govulncheck v1.9.0, binary mode) | 1 affected vulnerability: `GO-2026-5932` (`Fixed in: N/A`) — the approved non-blocking residual. **Zero reachable HIGH/CRITICAL.** |
| Reproducer | `build/w27/build-caddy-patched.sh` (drifting source is fatal; no early-exit pipelines; re-runnable from a clean tree) |

The superseded pre-correction build produced `b69def3432d3072aaed1bb035b743b0df21d1bbe1bfc31c650b026492157f3b8` at 58,056,866 bytes, without the release build tags and with an unnecessary `x/text` bump. That value is retained only as history and must not be used for packaging.

Not yet done for Caddy: image packaging with the patched binary in the approved runtime stage, a
resulting image digest, SBOM, Trivy on the rebuilt image, and the HTTPS/WSS/cookie/reverse-proxy
acceptance set.

## SeaweedFS — controlled patched rebuild (not yet attempted)

Baseline is upstream `seaweedfs/seaweedfs` 4.48 with Go 1.26.9 and `golang.org/x/net >= v0.60.0`,
preserving the approved runtime contents and replacing only `/usr/bin/weed`. The three currently
reachable findings (GO-2026-6617, GO-2026-6613, GO-2026-6612) must be absent or repaired, and
they must not be VEX-adjudicated. This rebuild has not been started.

## What this means for the release

The expanded six-image gate correctly found reachable vulnerabilities in Caddy and SeaweedFS. The
patched-rebuild route has since produced a Caddy artifact that passes the binary and
configuration checks (section below), while SeaweedFS has not yet been rebuilt and therefore
remains blocking. The general fixable and reachable HIGH/CRITICAL policy was never weakened. The
PostgreSQL `gosu` adjudication is unchanged and remains the only VEX disposition in force.

## Caddy patched runtime image (built and locally qualified; not yet published)

| Field | Value |
| --- | --- |
| Dockerfile | `build/w27/images/caddy/Dockerfile.patched` |
| Base | approved runtime `ghcr.io/sjevans1/workspace-ci-mirror-caddy@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b` |
| Replaced content | `/usr/bin/caddy` only (frozen sha256 `90e5f85f9a206ea63bdc146d75c54e0ec5c8ca4d245605f0c1570706ed4a38e5`), permissions and `cap_net_bind_service` re-applied |
| Local image id | `sha256:d3ae461ffe2ebeffda4c3ca5c0fdeecac8ba2d4e562b322715597f4f9b722227` |
| Target package | `ghcr.io/sjevans1/workspace-runtime-caddy` (explicitly not a `workspace-ci-mirror-*` name) |
| OCI metadata | classification `patched-upstream`, upstream tag/commit, binary sha256 and builder digest as labels, and a description stating it is a Workspace patched build rather than an upstream image |
| `caddy version` | `v2.11.7+modified` |
| Runtime preserved | `/etc/caddy`, `/data`, `/config` present; entrypoint unchanged; `Cmd=[caddy run --config /etc/caddy/Caddyfile --adapter caddyfile]` |
| `caddy validate --config /etc/caddy/Caddyfile` | **Valid configuration** |
| Trivy, blocking policy | `usr/bin/caddy` reports **0** fixable HIGH/CRITICAL (was 21 before the rebuild) |
| Reachability | zero reachable HIGH/CRITICAL on the installed binary; only the approved residual `GO-2026-5932` remains |

Still outstanding for this artifact: SBOM generation, the all-findings (including unfixed) report,
GHCR publication to obtain the immutable image digest, and the runtime acceptance set (HTTP to
HTTPS redirect, trusted HTTPS, Secure cookies, WSS/collaboration, reverse-proxy smoke and the
existing TLS browser acceptance), which belongs in the deployment tier.

## SeaweedFS patched acceptance rebuild (binary qualified; image and publication outstanding)

| Field | Value |
| --- | --- |
| Upstream tag | `4.48` |
| Upstream commit | `530be3e37337488ecc34d58441e0bc476e121c93` (asserted; the build fails with `SOURCE DRIFT` on mismatch) |
| Builder image | `golang@sha256:d9c68c2c…` (digest-pinned), `go1.26.9 linux/amd64` |
| Analysis tool | `govulncheck@v1.9.0`, pinned |
| Original dependencies | `golang.org/x/net v0.58.0`, `golang.org/x/text v0.42.0` |
| Patched dependencies | `golang.org/x/net v0.60.0` only; `golang.org/x/text` retained at `v0.42.0` |
| Build | `go build -trimpath -ldflags '-s -w' ./weed`, upstream default tags; only `/usr/bin/weed` is to be replaced in the runtime |
| **Frozen binary size** | **157,339,810 bytes** |
| **Frozen binary SHA-256** | **`ff8d09e4a8c921f35a7a65b988c541d74f0b01725197ddb7fdf5728f2be37cb2`** |
| Reproducer | `build/w27/build-seaweedfs-patched.sh` |

### Reachability outcome

The three previously reachable blocking findings are **eliminated**: `GO-2026-6617`,
`GO-2026-6613` and `GO-2026-6612` no longer appear in the rebuilt binary.

Three unfixed reachable items remain, none of them HIGH or CRITICAL, so none blocks under the
approved policy:

| Finding | Module | Fixed in | Severity |
| --- | --- | --- | --- |
| `GO-2022-0646` (CVE-2020-8911, GHSA-f5pg-7wfw-84q9) | `github.com/aws/aws-sdk-go` (S3 Crypto SDK) | N/A | MODERATE |
| `GO-2022-0635` (CVE-2020-8912, GHSA-7f33-f4f5-xwgw) | `github.com/aws/aws-sdk-go` (S3 Crypto SDK) | N/A | LOW |
| `GO-2026-5932` | `golang.org/x/crypto/openpgp` | N/A | unmaintained advisory, already decided for Caddy |

`aws-sdk-go` was not changed by this rebuild, so these two are upstream parity rather than
something the patch introduced. They stay visible and unadjudicated.

**No SeaweedFS VEX exists and none was created.** The Caddy treatment of `GO-2026-5932` is
explicitly not generalized here: the same advisory appearing in `weed` is recorded as its own
visible unfixed item with no disposition attached. The PostgreSQL/gosu VEX remains the only VEX
in W27.

Outstanding for this artifact: the patched runtime image (replacing only `/usr/bin/weed` while
preserving the Alpine runtime, entrypoint, filer configuration and the Rust `weed-volume` and
worker binaries), SBOM, all-findings report, GHCR publication as
`ghcr.io/sjevans1/workspace-acceptance-seaweedfs`, and the S3 acceptance set.

## SeaweedFS patched acceptance image (built and locally verified; not yet published)

| Field | Value |
| --- | --- |
| Dockerfile | `build/w27/images/seaweedfs/Dockerfile.patched` |
| Runtime base | `docker.io/chrislusf/seaweedfs:4.48` (index digest `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`) |
| Base choice | deliberately the upstream 4.48 image rather than the CI-H1 mirror, which records upstream tag 4.47 and would not be the approved 4.48 runtime |
| Replaced content | `/usr/bin/weed` only (frozen sha256 `ff8d09e4a8c921f35a7a65b988c541d74f0b01725197ddb7fdf5728f2be37cb2`), verified inside the built image by `sha256sum` in the build step |
| Local image id | `sha256:51c85ba0a48e71840223abcf02bb4d6029fbdeb67d5e2edecf1706406ddd8454` |
| Target package | `ghcr.io/sjevans1/workspace-acceptance-seaweedfs` (non-mirror; not a `workspace-ci-mirror-*` name) |
| OCI metadata | classification `patched-upstream`, intendedUse `acceptance-only`, upstream tag/commit, weed binary SHA-256 and builder digest |
| `weed version` | `version 30GB 4.48 linux amd64` |
| Runtime preserved | Alpine Linux v3.24; `/entrypoint.sh` and `/usr/bin/weed-volume` present; `Entrypoint=[/entrypoint.sh]`, `Cmd=[mini -dir=/data]` |
| Runtime layout note | `/usr/bin/worker` does not exist in the upstream 4.48 image. Nothing was removed by this rebuild; the upstream runtime simply does not ship that path, so no worker binary is preserved there. |

Outstanding for this artifact: SBOM, raw Trivy JSON, all-findings report, GHCR publication to an
immutable digest, and the S3 acceptance set (bucket create, upload, download, list, delete and the
existing recovery path). Publication and acceptance are not claimed here.

### Evidence improvements carried into both reproducers

`build/w27/build-seaweedfs-patched.sh` now retains the complete `go version -m
/w/weed-patched.bin` output rather than the first twelve lines. Both reproducers now assert the
exact permitted module delta rather than relying on `git diff --stat`: `golang.org/x/net` must be
`v0.60.0` and `golang.org/x/text` must remain `v0.42.0`, and the build fails (exit 44 or 45) on any
other value, with the complete module diff printed line by line so an unexpected direct or
transitive change cannot pass unnoticed.
