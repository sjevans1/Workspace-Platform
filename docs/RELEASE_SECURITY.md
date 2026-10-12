# Release image security acceptance

OpenJM Workspace release acceptance includes security evidence for the exact container images the supported release and its acceptance stack consume.

## Container SBOM

Every image in the qualification set receives a CycloneDX JSON SBOM in the release gate. The SBOMs are retained with the rest of the run's security evidence under the `w27-security-evidence` artifact, together with the raw scanner output they accompany.

The workspace container SBOM complements the repository-level npm SBOM in `docs/sbom.cdx.json`. The repository SBOM describes application dependencies; the container SBOM also captures the runtime/base-image package surface.

## Vulnerability gate

The blocking policy is:

- package types: OS and application/library packages;
- severity: HIGH and CRITICAL;
- unfixed findings: ignored for the blocking decision;
- fixable HIGH/CRITICAL findings: fail CI.

Ignoring unfixed findings in the blocking gate does **not** mean they are considered harmless. It prevents a release from being permanently blocked by a vendor/base-image issue for which no remediation exists. Unfixed findings still require normal risk review when preparing a customer release, and every image also gets a separate non-blocking report of all findings including unfixed ones for risk accounting.

Do not add a vulnerability ignore merely to make CI green. A suppression requires a documented vulnerability identifier, applicability analysis, compensating controls, owner and review/expiry date. W27 added exactly one disposition, the narrow PostgreSQL/gosu VEX described below; nothing else is suppressed, and no severity threshold was lowered.

## Exact-image rule

SBOM generation, vulnerability scanning, deployment startup and browser acceptance all use the same locally tagged image:

```
openjm-workspace:local
```

The gate collects its evidence in the same job and before the stack is deployed, so the image scanned is the image that ships. Do not replace this with a source-directory scan and claim equivalent release-image acceptance.

## Tool pinning

Third-party GitHub Actions used by the release gate are pinned to immutable commit SHAs rather than mutable version tags.

The W27 aggregate gate runs the scanners as version-pinned CLIs rather than as composite scanner actions, and verifies each download against a recorded SHA-256 before use:

- Trivy v0.75.0, archive SHA-256 `c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f`;
- syft v1.54.1, archive SHA-256 `c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47`.

The manual patched-image publication workflow still uses the pinned Anchore SBOM Action (v0.24.2) and the same pinned Trivy CLI, so its evidence and the gate's evidence come from the same scanner versions.

Historical record: PR #35 final-head run `36823852010` verified the hardened ClamAV runtime built from the official 1.5.4 Debian-slim base with Debian security updates. That exact derived image received a CycloneDX SBOM and passed the fixable HIGH/CRITICAL Trivy gate before deployed EICAR acceptance. Malware signatures remain operational data refreshed in the persistent scanner database volume.

## W27a (#112) and W27: six images, collected before decided

The release gate previously applied its blocking scan only to the Workspace application image and the derived ClamAV image. The qualification set is now exactly six images: **Workspace, ClamAV, PostgreSQL, Caddy, Valkey and SeaweedFS**. The first extension (W27a) added PostgreSQL, Caddy, Valkey and SeaweedFS with the same accepted policy. W27 refactored the qualification into two phases and closed the reachable-vulnerability gaps it surfaced.

### Phase 1: evidence collection never decides and never aborts

`scripts/ci/w27-collect-evidence.sh` collects evidence for all six images. Every step is `continue-on-error`, so a scanner failure is recorded in `w27-evidence/<image>/collection-errors.txt` and the remaining images are still collected. One broken image can no longer hide the state of the other five.

Retained per image: the exact image identity (reference, resolved image id, provenance class), a CycloneDX SBOM, the raw scanner JSON, the human-readable all-findings report, the blocking-policy result, reachability evidence where the policy requires it, and the VEX where one applies.

### Phase 2: one blocking fail-closed evaluator

`scripts/w27-security-aggregate.mjs` runs after collection completes and is the only component that decides. It is a blocking step, so a non-zero exit fails the deployment job, and its JSON report is published with the evidence. PASS requires:

- exactly six expected image records, and no unexpected ones;
- every required SBOM, present, readable and non-empty;
- valid immutable identities that match the authoritative provenance sources;
- resolver/provenance validation, re-run by the evaluator rather than trusted from a recorded copy;
- zero unadjudicated fixable HIGH/CRITICAL;
- zero reachable blocking HIGH/CRITICAL;
- the exact PostgreSQL/gosu VEX validation;
- every required reachability record.

Missing, unreadable or malformed evidence is a FAIL.

### Image references are single-sourced across four provenance classes

`scripts/w27-image-inventory.mjs` is the only place the scan targets are resolved, and it resolves all four provenance classes:

1. **CI-H1 mirror-provenanced images** from `ci/ghcr-mirror-manifest.json` (PostgreSQL, and the `node`/ClamAV build bases);
2. **Valkey**, immutable by digest in `compose.yaml` and deliberately not mirror-provenanced;
3. **patched-upstream Caddy** from `ci/w27-patched-images.json`, shipped runtime;
4. **patched-upstream SeaweedFS** from `ci/w27-patched-images.json`, acceptance only.

It refuses a drifted reference, refuses a tag-only reference for the non-mirror image, refuses a patched artifact recorded as mirror-provenanced, refuses any module delta other than the single approved `golang.org/x/net` change, and refuses a CI SeaweedFS service that no longer consumes the qualified patched digest. The workflow contains no duplicated PostgreSQL, Caddy, Valkey or SeaweedFS digest literals, so a workflow that falls behind the inventory or the runtime fails instead of scanning an image the release does not consume.

| Image | Reference used for the gate | Purpose | Classification |
| --- | --- | --- | --- |
| Workspace application | `openjm-workspace:local` (built from the pinned `node` mirror) | customer application runtime | shipped |
| ClamAV | `openjm-workspace-clamav:local` (derived from the pinned ClamAV mirror) | outbound antivirus scanning | shipped |
| PostgreSQL | `ghcr.io/sjevans1/workspace-ci-mirror-postgres@sha256:3645570c…` | database service | shipped |
| Caddy | `ghcr.io/sjevans1/workspace-runtime-caddy@sha256:05754b18…` | TLS terminator / edge | **patched upstream rebuild, not a mirror** |
| Valkey | `ghcr.io/valkey-io/valkey@sha256:081c2f5c…` | cache service | shipped; immutable, not mirror-provenanced |
| SeaweedFS | `ghcr.io/sjevans1/workspace-acceptance-seaweedfs@sha256:0f7b74e1…` | S3-compatible object storage used by the acceptance stack | **patched upstream rebuild, acceptance only, not a mirror** |

**Artifact names carry immutable identity.** Every image's evidence directory is keyed by the logical image name and its identity record carries the immutable reference, so an artifact can be traced to the exact image digest that produced it.

### The single VEX disposition

PostgreSQL's fixable HIGH/CRITICAL set is attributable in full to the bundled `gosu` 1.19 setuid helper. `docs/security/vex-gosu-postgres-17.11-bookworm.json` is an OpenVEX `not_affected` disposition, justified `vulnerable_code_not_in_execute_path`, supported by an anonymous `govulncheck` binary-mode run that reports zero reachable vulnerabilities in that exact binary. The evaluator validates this VEX exactly: component id, version and binary SHA-256, subcomponent path, parent image digest, platform, the bounded review window, and the finding list, which must equal the fixable set the blocking scan actually reported. A VEX that does not cover exactly that set is treated as a scope change and fails the gate.

`gosu` is an anonymous setuid helper whose affected code is never executed on any reachable path. Caddy is the running TLS terminator and SeaweedFS is the running object-storage service, so neither may inherit that disposition, and the evaluator fails if either carries a VEX or claims an inherited disposition. No VEX rule was broadened, and the general fixable and reachable HIGH/CRITICAL policy was not weakened.

### Recorded findings from this work, stated honestly

- **FULL `38250970609` genuinely failed.** The expanded gate surfaced real reachable release blockers: Caddy's `usr/bin/caddy` carried 21 fixable HIGH findings with 4 reachable, and SeaweedFS's `usr/bin/weed` carried 5 fixable HIGH findings with 3 reachable.
- **The blockers were repaired by patched upstream rebuilds, not by adjudication.** Publication run `38267553760` built and published both patched images; the immutable digests are frozen in `ci/w27-patched-images.json`, the consumers use them, and the reachability analysis of the rebuilt binaries reports zero reachable HIGH/CRITICAL. See `docs/security/W27_PATCHED_REBUILD.md`.
- **Valkey is immutable by digest but is not CI-H1 mirror-provenanced.** It is consumed from its own upstream GHCR namespace and is pinned in `compose.yaml` to the immutable index digest `sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507`, resolved from the registry, so the image scanned is cryptographically the image the supported release consumes. Bringing Valkey into the mirror inventory as a reviewed follow-up would remove the last provenance asymmetry; the immutability requirement itself is met and no upgrade was made to clear a scan.
- **SeaweedFS is acceptance infrastructure.** It is a service of the acceptance stack, it is explicitly not a shipped customer image, and its patched rebuild is recorded as `acceptance-only`. Its published image is `ghcr.io/sjevans1/workspace-acceptance-seaweedfs`, a name that is not a `workspace-ci-mirror-*` package, so it cannot be mistaken for a mirror.
- **Patched artifacts are not mirrors.** The `workspace-ci-mirror-*` images remain upstream byte-for-byte mirrors with their own `digestVerifiedEqual` semantics in `ci/ghcr-mirror-manifest.json`. The two patched rebuilds carry `mirrorProvenance: false`, and the resolver fails if that is ever set to true.
- **Reachability evidence is produced against the exact binary.** Both reachability records and the VEX cite SHA-256 identities of the analysed binaries, and the evaluator refuses a reachability record whose binary hash or image reference does not match the qualified artifact.
- Any real unfixed upstream vulnerability found by these scans is reported by the non-blocking accounting step and must be recorded with its release treatment before release; major image upgrades are never performed unreviewed merely to clear a scanner finding, and stateful PostgreSQL changes in particular require reviewed migration and restore evidence.

## Current boundaries

This gate does not yet provide:

- cryptographic image signing/attestation for the patched runtime artifacts;
- provenance/SLSA attestations;
- registry admission policy;
- retained quarantine/CDR or sandbox detonation for uploaded customer files;
- automatic patch deployment;
- a substitute for customer-specific vulnerability management.

Container signing and provenance should be added when the project begins publishing immutable release images to a registry.
