# W27 patched-upstream rebuilds (Caddy, SeaweedFS)

Provenance note: the `workspace-ci-mirror-*` images remain upstream byte-for-byte mirrors. The
artifacts described here are **Workspace patched upstream rebuilds**, not mirrors, and must never
be described or recorded as mirror-provenanced (`digestVerifiedEqual=true` does not apply).

## Caddy — controlled patched rebuild (reproducible, acceptance NOT yet met)

| Field | Value |
| --- | --- |
| Upstream project | `caddyserver/caddy` |
| Upstream tag | `v2.11.7` (exact tag; resolved to commit `72dd0fb067f6d7826c7f79907670ba4a713bfe37`, matching the required baseline) |
| Source fetch | `git clone --depth 1 --branch v2.11.7` |
| Builder image | `golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c` (digest-pinned; `go version go1.26.9 linux/amd64`) |
| Go compiler | 1.26.9 |
| Original deps | `golang.org/x/net v0.59.0`, `golang.org/x/text v0.42.0` |
| Patched deps | `golang.org/x/net v0.60.0` only; **`golang.org/x/text` deliberately retained at v0.42.0** (no opportunistic upgrade; the earlier x/text bump was removed as instructed) |
| Build flags | release tags `nobadger,nomysql,nopgx`, `CGO_ENABLED=0`, `-trimpath -ldflags '-s -w'` |
| Binary | `/w/caddy-patched.bin`, 58,056,866 bytes (pre-correction build; superseded by the corrected build) |
| Binary sha256 | `b69def3432d3072aaed1bb035b743b0df21d1bbe1bfc31c650b026492157f3b8` |
| Reproducer | `build/w27/build-caddy-patched.sh` (corrections applied: digest-pinned builder, minimal patch, release tags, untruncated govulncheck evidence, tag/commit proof, clean clone target) |

Acceptance status after the corrected rebuild: **the previously blocking reachable
HIGH/toolchain findings are cleared**, and binary reachability on the corrected artifact reports
**exactly one residual reachable item: GO-2026-5932**, which is
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
