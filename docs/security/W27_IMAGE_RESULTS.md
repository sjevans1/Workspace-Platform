# W27 image-security results (six-image aggregate gate)

Policy: `ci/w27-security-policy.json`. Blocking decision: severity `HIGH,CRITICAL`, package types
OS and application/library, unfixed findings ignored for the blocking decision, exactly one VEX
disposition (PostgreSQL/gosu). Identical to the accepted release policy, which was not weakened.

Qualification set: exactly **Workspace, ClamAV, PostgreSQL, Caddy, Valkey, SeaweedFS**. The gate
collects evidence for all six before deciding anything; the decision comes from one blocking
fail-closed evaluator (`scripts/w27-security-aggregate.mjs`).

## Outcomes

| Image | Identity used for the gate | Fixable HIGH/CRITICAL | All findings (unfixed included) | Reachability | Result |
| --- | --- | --- | --- | --- | --- |
| Workspace | `openjm-workspace:local` (`sha256:4bb8304b…`) | **0** | 166: HIGH 43, MEDIUM 58, LOW 60, UNKNOWN 5 (all unfixed) | not required | **PASS** |
| ClamAV | `openjm-workspace-clamav:local` (`sha256:02ea0444…`) | **0** | 254: CRITICAL 1, HIGH 57, MEDIUM 87, LOW 105, UNKNOWN 4 (all unfixed) | not required | **PASS** |
| PostgreSQL | `ghcr.io/sjevans1/workspace-ci-mirror-postgres@sha256:3645570c…` | 25: CRITICAL 1, HIGH 24, every one of them in the bundled `gosu` stdlib and adjudicated by the VEX | 472 | 0 called, 57 advisories affect the build information only | **PASS** |
| Caddy | `ghcr.io/sjevans1/workspace-runtime-caddy@sha256:05754b18…` | **0** | 2: `CVE-2026-85091` (zlib 1.3.2-r0, MEDIUM, fix available) and `GO-2026-5932` (UNKNOWN, unfixed) | 1 called: `GO-2026-5932`, the approved visible non-blocking residual. Zero HIGH/CRITICAL | **PASS** |
| Valkey | `ghcr.io/valkey-io/valkey@sha256:081c2f5c…` | **0** | 1: `CVE-2026-85091` (zlib, MEDIUM) | not required | **PASS** |
| SeaweedFS | `ghcr.io/sjevans1/workspace-acceptance-seaweedfs@sha256:0f7b74e1…` | **0** | 3: `CVE-2026-58055` (nghttp2, MEDIUM), `CVE-2026-85091` (zlib, MEDIUM), `GO-2026-5932` (UNKNOWN) | 3 called: `GO-2022-0646`, `GO-2022-0635`, `GO-2026-5932`, all non-HIGH/CRITICAL. `GO-2026-6617`, `GO-2026-6613` and `GO-2026-6612` absent | **PASS** |

Every finding above is recorded and none is suppressed. There is no ignore file. The unfixed
findings in the Workspace, ClamAV, Caddy, Valkey and SeaweedFS images stay visible and unadjudicated;
they are excluded from the blocking decision because no remediation exists for them, which is the
accepted policy and not a claim that they are harmless.

## Chronology, stated plainly

1. **FULL `38250970609` genuinely failed.** The expanded six-image gate surfaced real reachable
   release blockers: Caddy's `usr/bin/caddy` carried 21 fixable HIGH findings with 4 reachable
   (`GO-2026-6629`, `GO-2026-6617`, `GO-2026-6613`, `GO-2026-6612`), and SeaweedFS's `/usr/bin/weed`
   carried 5 fixable HIGH findings with 3 reachable (`GO-2026-6617`, `GO-2026-6613`,
   `GO-2026-6612`).
2. **PostgreSQL/gosu was narrowly VEX-adjudicated.** Its whole fixable set is attributable to the
   single bundled `gosu` 1.19 setuid helper, and anonymous `govulncheck` binary-mode analysis of that
   exact binary reports 3 import-level and 54 module-level advisories and **zero called**. That
   adjudication was scoped to that component and image only.
3. **The Caddy and SeaweedFS blockers were repaired by patched upstream rebuilds, not by
   adjudication.** Neither image could inherit the gosu disposition, and neither got a VEX of its own.
4. **Publication run `38267553760` succeeded**, producing the two immutable digests now frozen in
   `ci/w27-patched-images.json`.
5. **The resolver now governs all four provenance classes** (CI-H1 mirror, immutable non-mirror
   Valkey, patched Caddy, patched SeaweedFS), and the consumers use the exact patched digests:
   `compose.yaml` for Caddy, the CI SeaweedFS acceptance service for SeaweedFS.
6. **The six-image gate now collects before it decides**, and the results above are the outcome of
   that gate against those frozen identities.
7. **FULL `38305744176` on head `ce4084d971d9e625205aefa527ef403d24892703` genuinely failed, and it
   failed at the W27 aggregate evaluator.** FAST succeeded and backend succeeded. All six image
   evidence sets were collected, collection errors were zero, no vulnerability-policy failure
   occurred, and the PostgreSQL/gosu VEX validation remained valid. The failure was caused by the
   evaluator comparing a local Docker image id against a registry manifest digest: those are
   allowed to differ, and on the GitHub runner they do. Every deployment step after the evaluator
   was skipped and is therefore not accepted. No image was rebuilt or republished. This is a gate
   implementation defect, corrected in part 3 of the follow-up below; the earlier failure below is
   not rewritten by it.

## Reachability adjudication (binary mode, pinned govulncheck v1.9.0)

Each component was analysed separately, against the binary extracted from the exact qualified image
digest, and no evidence was reused between components.

| Component | Image | Binary SHA-256 | Called | Affected only | Outcome |
| --- | --- | --- | --- | --- | --- |
| `gosu` 1.19 | PostgreSQL | `52c8749d0142edd2…` | **0** | 57 advisories | covers the 25 fixable HIGH/CRITICAL findings exactly; `not_affected` / `vulnerable_code_not_in_execute_path` |
| `/usr/bin/caddy` | Caddy (`05754b18…`) | `90e5f85f9a206ea6…` | 1 (`GO-2026-5932`, UNKNOWN) | 0 | zero reachable HIGH/CRITICAL; the residual stays visible, non-VEXed and non-blocking |
| `/usr/bin/weed` | SeaweedFS (`0f7b74e1…`) | `ff8d09e4a8c921f3…` | 3 (`GO-2022-0646` MODERATE, `GO-2022-0635` LOW, `GO-2026-5932`) | 0 | zero reachable HIGH/CRITICAL; the three previous blockers are absent |

`go-2026-5932` is the unmaintained `golang.org/x/crypto/openpgp` advisory. It carries no
HIGH/CRITICAL severity, it is not adjudicated, and the evaluator refuses to let any image treat it as
blanket cover: an image may only keep it as a named visible residual, and the evaluator fails if a
residual is ever reported at a blocking severity.

## What the aggregate evaluator enforces

`scripts/w27-security-aggregate.mjs` exits non-zero unless all of the following hold, and its JSON
report is published with the evidence:

- exactly six expected image records and no unexpected ones;
- every required SBOM present, readable, non-empty and a real CycloneDX document with components;
- valid immutable identities that match the authoritative provenance sources, including the local
  image resolving to the exact registry reference the resolver produced;
- resolver/provenance validation, re-run by the evaluator rather than trusted from a recorded copy;
- zero unadjudicated fixable HIGH/CRITICAL;
- zero reachable blocking HIGH/CRITICAL, evaluated against the exact analysed binary identity;
- the exact PostgreSQL/gosu VEX validation, whose finding list must equal the fixable set the
  blocking scan actually reported;
- every required reachability record, and no reachability record where the policy requires none;
- an existing, readable and empty `collection-errors.txt` for every one of the six images, so any
  recorded collection, scanner or tooling failure fails the gate even when the rest of that image's
  evidence still parses.

Missing, unreadable or malformed evidence is a FAIL.

## Evidence retention

Phase 1 writes `w27-evidence/<image>/` containing the identity record, the CycloneDX SBOM, the raw
scanner JSON, the all-findings report, the blocking-policy result, the reachability record where the
policy requires one, and the VEX where one applies. The whole directory is published as the
`w27-security-evidence` artifact, and each image's record is keyed by its immutable identity, so an
artifact can be traced back to the exact digest that produced it.
