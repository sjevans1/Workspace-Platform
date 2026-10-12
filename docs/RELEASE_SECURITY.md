# Release image security acceptance

OpenJM Workspace release acceptance includes security evidence for the exact application container image that is deployed and browser-tested in CI.

## Container SBOM

After `docker compose build api`, CI generates a CycloneDX JSON SBOM for:

```
openjm-workspace:local
```

The SBOM is produced with the pinned Anchore SBOM Action and uploaded as the CI artifact:

```
openjm-workspace-container-sbom
```

This container SBOM complements the repository-level npm SBOM in `docs/sbom.cdx.json`. The repository SBOM describes application dependencies; the container SBOM also captures the runtime/base-image package surface.

## Vulnerability gate

The same built image is scanned with pinned Trivy before the deployment starts.

The blocking policy is:

- package types: OS and application/library packages;
- severity: HIGH and CRITICAL;
- unfixed findings: ignored for the blocking decision;
- fixable HIGH/CRITICAL findings: fail CI.

Ignoring unfixed findings in the blocking gate does **not** mean they are considered harmless. It prevents a release from being permanently blocked by a vendor/base-image issue for which no remediation exists. Unfixed findings still require normal risk review when preparing a customer release.

Do not add a vulnerability ignore merely to make CI green. A suppression requires a documented vulnerability identifier, applicability analysis, compensating controls, owner and review/expiry date.

## Exact-image rule

SBOM generation, vulnerability scanning, deployment startup and browser acceptance all use the same locally tagged image:

```
openjm-workspace:local
```

Do not replace this with a source-directory scan and claim equivalent release-image acceptance.

## Action pinning

Third-party GitHub Actions used by this gate are pinned to immutable commit SHAs rather than mutable version tags.

Current accepted tool releases:

- Anchore SBOM Action v0.24.2;
- Aqua Security Trivy Action v0.36.0.

The corresponding commit pins are recorded directly in `.github/workflows/ci.yml`.

PR #35 final-head run `36823852010` verified the hardened ClamAV runtime built from the official 1.5.4 Debian-slim base with Debian security updates: that exact derived image received a CycloneDX SBOM and passed the fixable HIGH/CRITICAL Trivy gate before deployed EICAR acceptance. Malware signatures remain operational data refreshed in the persistent scanner database volume.

## W27a (#112): full shipped-image coverage

The release gate previously generated an SBOM and applied its blocking scan to the Workspace
application image and the derived ClamAV image. It now covers every other image the supported
production and acceptance stacks actually consume, using the same accepted policy: a
CycloneDX SBOM, a blocking scan for fixable HIGH/CRITICAL vulnerabilities, a separate
non-blocking report of all findings including unfixed ones for risk accounting, and exact
image binding. Nothing is waived: there is no ignore file, and unfixed upstream findings are
reported rather than suppressed.

**Image references are single-sourced.** `scripts/w27-image-inventory.mjs` is the only place
the scan targets are resolved. It reads `ci/ghcr-mirror-manifest.json` and `compose.yaml`,
verifies that every manifest-owned image the runtime consumes corresponds to the authoritative
inventory, refuses a tag-only reference for the non-mirror image, refuses a drifted reference,
and emits the exact scan references together with digest-derived artifact slugs, which the
workflow consumes through the environment. The workflow contains no duplicated PostgreSQL,
Caddy or SeaweedFS digest literals, so a workflow that falls behind the inventory or the
runtime fails instead of scanning an image the release does not consume.

**Artifact names carry immutable identity.** Every SBOM and scan artifact is named with a
digest-derived identifier, not a tag or version alone, so an artifact can be traced to the
exact image digest that produced it.

| Image | Reference used for the gate | Purpose | Classification |
| --- | --- | --- | --- |
| Workspace application | `openjm-workspace:local` (built from the pinned `node` mirror) | customer application runtime | shipped |
| ClamAV | `openjm-workspace-clamav:local` (derived from the pinned ClamAV mirror) | outbound antivirus scanning | shipped |
| PostgreSQL | `ghcr.io/sjevans1/workspace-ci-mirror-postgres@sha256:3645570c…` | database service | shipped |
| Caddy | `ghcr.io/sjevans1/workspace-ci-mirror-caddy@sha256:6aeddd44…` | TLS terminator / edge | shipped |
| Valkey | `ghcr.io/valkey-io/valkey@sha256:081c2f5c…` | cache service | shipped |
| SeaweedFS | `ghcr.io/sjevans1/workspace-ci-mirror-seaweedfs@sha256:ce9e796f…` | S3-compatible object storage used by the acceptance stack | **acceptance/test dependency, not a shipped customer image** |

Recorded findings from this extension, stated honestly:

- **Valkey is immutable by digest but is not CI-H1 mirror-provenanced.** It is consumed from
  its own upstream GHCR namespace and is pinned in `compose.yaml` to the immutable index digest
  `sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507`, resolved from the
  registry, so the image scanned is cryptographically the image the supported release consumes.
  It is deliberately not described as part of the Docker Hub CI-H1 mirror set. Bringing Valkey
  into that mirror inventory as a reviewed follow-up would remove the last provenance
  asymmetry; the immutability requirement itself is met and no upgrade was made to clear a
  scan.
- **SeaweedFS is acceptance infrastructure.** It appears in the CI-H1 manifest with CI as its
  consumer and is not a service in the production Compose stack, so it is scanned for
  acceptance coverage and explicitly not labelled a shipped customer image.
- Any real unfixed upstream vulnerability discovered by these scans is reported by the
  non-blocking accounting step and must be recorded with its release treatment before release;
  major image upgrades are never performed unreviewed merely to clear a scanner finding, and
  stateful PostgreSQL changes in particular require reviewed migration and restore evidence.

## Current boundaries

This gate does not yet provide:

- cryptographic image signing/attestation;
- provenance/SLSA attestations;
- registry admission policy;
- retained quarantine/CDR or sandbox detonation for uploaded customer files;
- automatic patch deployment;
- a substitute for customer-specific vulnerability management.

Container signing and provenance should be added when the project begins publishing immutable release images to a registry.
