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

## Current boundaries

This gate does not yet provide:

- cryptographic image signing/attestation;
- provenance/SLSA attestations;
- registry admission policy;
- malware scanning of uploaded customer files;
- automatic patch deployment;
- a substitute for customer-specific vulnerability management.

Container signing and provenance should be added when the project begins publishing immutable release images to a registry.
