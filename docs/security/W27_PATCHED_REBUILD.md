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

Acceptance status after the corrected rebuild: **the binary itself is qualified.** The previously
blocking reachable HIGH/toolchain findings are cleared, and the only reachable item is the
already-approved non-blocking residual `GO-2026-5932`. Image packaging, GHCR publication and
runtime acceptance are the remaining steps and are not claimed here., which is
`golang.org/x/crypto/openpgp` reported as unmaintained and unsafe by design with **`Fixed in:
N/A`**, i.e. an unfixed reachable finding rather than a fixable one. Because the approved blocking
policy is `--ignore-unfixed`, that finding does not by itself fail the Trivy gate, but it is
unfixed, reachable, and therefore a release-risk decision for Sol rather than something to
adjudicate, suppress, or VEX here. It stays visible in the all-findings report. The release rule for this decision is
explicit: if any other reachable finding remains, stop and report it, and do not create a Caddy
VEX merely because the binary was built in-house. No VEX record exists for Caddy and none was
created. The rebuilt binary therefore does **not** replace the current Caddy image.

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
patched-rebuild route is proven feasible for Caddy's toolchain and dependency floor, but it has
not yet produced an artifact that passes reachability, so **the release remains blocked** and the
general HIGH/CRITICAL policy is untouched. The PostgreSQL `gosu` adjudication is unchanged and
remains the only VEX disposition in force.
