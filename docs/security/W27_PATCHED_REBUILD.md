# W27 patched-upstream rebuilds (Caddy, SeaweedFS)

Provenance note: the `workspace-ci-mirror-*` images remain upstream byte-for-byte mirrors. The
artifacts described here are **Workspace patched upstream rebuilds**, not mirrors, and must never
be described or recorded as mirror-provenanced (`digestVerifiedEqual=true` does not apply). Both
records carry `mirrorProvenance: false` in `ci/w27-patched-images.json`, and the release-image
resolver fails the gate if that is ever set to true.

Both artifacts are published, frozen and consumed. The immutable digests are:

| Artifact | Package | Immutable digest |
| --- | --- | --- |
| Caddy (shipped runtime) | `ghcr.io/sjevans1/workspace-runtime-caddy` | `sha256:05754b18a137780b49fa3280d864c7e8cb4a88270785fcce77108a471e0983cb` |
| SeaweedFS (acceptance only) | `ghcr.io/sjevans1/workspace-acceptance-seaweedfs` | `sha256:0f7b74e17d3d85c88419bfeba3af9fb56976b8df7fccf40802df2cf7fddda5ef` |

Publication run `38267553760` produced both. `ghcr.io/sjevans1/workspace-runtime-caddy` is
consumed by `compose.yaml` as the Caddy service; `ghcr.io/sjevans1/workspace-acceptance-seaweedfs`
is consumed by the CI SeaweedFS acceptance service in `.github/workflows/ci.yml`. Neither name is a
`workspace-ci-mirror-*` package.

## Why the rebuilds exist

FULL run `38250970609` failed the six-image gate honestly. The expanded gate found, by binary
reachability analysis of the exact shipped binaries:

- Caddy's `usr/bin/caddy`: 21 fixable HIGH findings, 4 of them reachable (`GO-2026-6629`,
  `GO-2026-6617`, `GO-2026-6613`, `GO-2026-6612`);
- SeaweedFS's `usr/bin/weed`: 5 fixable HIGH findings, 3 of them reachable (`GO-2026-6617`,
  `GO-2026-6613`, `GO-2026-6612`).

The response was an image-refresh decision, not a VEX decision: rebuild each upstream project at a
newer upstream source with the minimum module change that carries the fixes, keep the runtime
contents identical, and re-run reachability. PostgreSQL/gosu was separately and narrowly
VEX-adjudicated on its own evidence; nothing from that adjudication was reused here.

## Caddy: controlled patched rebuild (published, qualified)

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
| Approved module delta | exactly `golang.org/x/net` `v0.59.0` to `v0.60.0`; any other added, removed or version-changed line fails the build (exit 46) and fails the release-image resolver |
| Build tags | `nobadger,nomysql,nopgx` (matching the upstream release configuration) |
| Build flags | `CGO_ENABLED=0`, `-trimpath -ldflags '-s -w'` |
| **Frozen binary size** | **51,974,306 bytes** |
| **Frozen binary SHA-256** | **`90e5f85f9a206ea63bdc146d75c54e0ec5c8ca4d245605f0c1570706ed4a38e5`** |
| Binary version string | `v2.11.7+modified (72dd0fb0…)` |
| Runtime base | the approved runtime `ghcr.io/sjevans1/workspace-ci-mirror-caddy@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b` |
| Replaced content | `/usr/bin/caddy` only, with permissions and `cap_net_bind_service` re-applied |
| Runtime preserved | `/etc/caddy`, `/data`, `/config` present; entrypoint unchanged; `Cmd=[caddy run --config /etc/caddy/Caddyfile --adapter caddyfile]` |
| `caddy validate --config /etc/caddy/Caddyfile` | **Valid configuration** |
| Trivy, blocking policy | `usr/bin/caddy` reports **0** fixable HIGH/CRITICAL (was 21 before the rebuild) |
| Reachability (govulncheck v1.9.0, binary mode) | 1 affected advisory: `GO-2026-5932` (`Fixed in: N/A`), not called. **Zero reachable HIGH/CRITICAL.** |
| VEX | **none.** `GO-2026-5932` remains visible, non-VEXed and non-blocking. |
| Reproducer | `build/w27/build-caddy-patched.sh` (drifting source is fatal; no early-exit pipelines; re-runnable from a clean tree) |
| Publication | run `38267553760`; digest `sha256:05754b18a137780b49fa3280d864c7e8cb4a88270785fcce77108a471e0983cb` |

The superseded pre-correction build produced `b69def3432d3072aaed1bb035b743b0df21d1bbe1bfc31c650b026492157f3b8` at 58,056,866 bytes, without the release build tags and with an unnecessary `x/text` bump. That value is retained only as history and must not be used for packaging.

## SeaweedFS: controlled patched acceptance rebuild (published, qualified)

| Field | Value |
| --- | --- |
| Upstream tag | `4.48` |
| Upstream commit | `530be3e37337488ecc34d58441e0bc476e121c93` (asserted; the build fails with `SOURCE DRIFT` on mismatch) |
| Builder image | `golang@sha256:d9c68c2c…` (digest-pinned), `go1.26.9 linux/amd64` |
| Analysis tool | `govulncheck@v1.9.0`, pinned |
| Original dependencies | `golang.org/x/net v0.58.0`, `golang.org/x/text v0.42.0` |
| Patched dependencies | `golang.org/x/net v0.60.0` only; `golang.org/x/text` retained at `v0.42.0` |
| Approved module delta | exactly `golang.org/x/net` `v0.58.0` to `v0.60.0`; any other change fails the build and the release-image resolver |
| Build | `go build -trimpath -ldflags '-s -w' ./weed`, upstream default tags; only `/usr/bin/weed` is replaced in the runtime |
| **Frozen binary size** | **157,339,810 bytes** |
| **Frozen binary SHA-256** | **`ff8d09e4a8c921f35a7a65b988c541d74f0b01725197ddb7fdf5728f2be37cb2`** |
| Runtime base | `docker.io/chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` (upstream tag 4.48, `linux/amd64`), deliberately the upstream image rather than the CI-H1 mirror, which records upstream tag 4.47 and would not be the approved 4.48 runtime |
| Runtime preserved | Alpine Linux v3.24; `/entrypoint.sh` present; `Entrypoint=[/entrypoint.sh]`, `Cmd=[mini -dir=/data]` |
| `weed version` | `version 30GB 4.48 linux amd64` |
| Inherited Rust artifact `/usr/bin/weed-volume` | exists, **39,475,480 bytes**, sha256 `8b271bc326f593c1b3b7f5d90091b0ef789c89023c34dec908c919f8614384d1`, real ELF, preserved unchanged |
| Inherited Rust artifact `/usr/bin/weed-worker` | exists, **252,739,408 bytes**, sha256 `9f10828f88b4ca4e1b770af68bbe5c9a38ca06623b187cfe6fd08238e9677fca`, real ELF, preserved unchanged |
| Trivy, blocking policy | `usr/bin/weed` reports **0** fixable HIGH/CRITICAL (was 5 before the rebuild) |
| Reproducer | `build/w27/build-seaweedfs-patched.sh` |
| Publication | run `38267553760`; digest `sha256:0f7b74e17d3d85c88419bfeba3af9fb56976b8df7fccf40802df2cf7fddda5ef` |

Runtime layout note: an earlier version of this record claimed the upstream image ships no worker
because it checked `/usr/bin/worker`, which is absent. That was the wrong path. Upstream 4.48
installs the Rust maintenance worker at `/usr/bin/weed-worker` and its own `docker/entrypoint.sh`
executes exactly that path. The corrected inventory above is authoritative. Only `/usr/bin/weed`
is replaced; both Rust artifacts are inherited untouched.

### Reachability outcome (SeaweedFS)

The three previously reachable blocking findings are **eliminated**: `GO-2026-6617`,
`GO-2026-6613` and `GO-2026-6612` no longer appear anywhere in the rebuilt binary, and the
aggregate evaluator fails if any of them reappears.

Three unfixed reachable items remain, none of them HIGH or CRITICAL, so none blocks under the
approved policy:

| Finding | Module | Fixed in | Severity |
| --- | --- | --- | --- |
| `GO-2022-0646` (CVE-2020-8911, GHSA-f5pg-7wfw-84q9) | `github.com/aws/aws-sdk-go` (S3 Crypto SDK) | N/A | MODERATE |
| `GO-2022-0635` (CVE-2020-8912, GHSA-7f33-f4f5-xwgw) | `github.com/aws/aws-sdk-go` (S3 Crypto SDK) | N/A | LOW |
| `GO-2026-5932` | `golang.org/x/crypto/openpgp` | N/A | unmaintained advisory, retained as its own visible item |

`aws-sdk-go` was not changed by this rebuild, so these two are upstream parity rather than
something the patch introduced. They stay visible and unadjudicated.

**No SeaweedFS VEX exists and none was created.** The Caddy treatment of `GO-2026-5932` is
explicitly not generalized here: the same advisory appearing in `weed` is recorded as its own
visible unfixed item with no disposition attached, and the aggregate evaluator rejects any attempt
by either patched image to inherit the PostgreSQL/gosu disposition. The PostgreSQL/gosu VEX
remains the only VEX in W27.

## Evidence improvements carried into both reproducers

`build/w27/build-seaweedfs-patched.sh` retains the complete `go version -m /w/weed-patched.bin`
output rather than the first twelve lines. Both reproducers assert the exact permitted module delta
rather than relying on `git diff --stat`: `golang.org/x/net` must be `v0.60.0` and
`golang.org/x/text` must remain `v0.42.0`, and the build fails (exit 44 or 45) on any other value,
with the complete module diff printed line by line so an unexpected direct or transitive change
cannot pass unnoticed. The release-image resolver independently re-asserts the same delta on the
recorded provenance, so a record edited after the build cannot loosen it.

## What this means for the release

- FULL `38250970609` failed, and that failure was correct: both images really did contain reachable
  release blockers.
- The blockers were repaired by rebuilding the upstream projects, not by weakening the policy and
  not by widening the PostgreSQL adjudication. The general fixable and reachable HIGH/CRITICAL
  policy is unchanged.
- PostgreSQL/gosu remains the only VEX disposition in force.
- The patched artifacts are rebuilds, not mirrors; the mirror inventory is untouched.
- SeaweedFS remains acceptance-only infrastructure, never a shipped customer image.
- Exact-digest acceptance for both artifacts is run against only the frozen digests above, and the
  results are recorded in `docs/W27_SECURITY_PRIVACY_DISTRIBUTION_ACCEPTANCE.md`.
