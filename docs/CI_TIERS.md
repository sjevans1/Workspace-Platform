# CI-3L Verification Tiers

Workspace keeps the existing release-grade checks, but no longer runs the entire release qualification as the first feedback loop for every pull-request update.

## FAST — iteration

**Trigger:** every pull request; every push to `main`; manual dispatch with `suite=fast|standard|full`.

Runs:
- exact repository checkout;
- `npm ci`;
- TypeScript/integration-client typecheck;
- production frontend build.

FAST is rapid deterministic feedback. It does not establish package or release acceptance.

## STANDARD — work-package qualification

**Trigger:** push to `main`, or manual dispatch with `suite=standard` or `suite=full`.

The existing `backend` job remains the STANDARD authority and retains:
- PostgreSQL + SeaweedFS services;
- full native `npm test`;
- mirrored-dependency guard;
- production S3 acceptance;
- production build.

Use STANDARD when a coherent work package is materially complete and before freezing an acceptance candidate.

## FULL — frozen-candidate acceptance

**Trigger:** manual dispatch only with `suite=full`.

The existing `deployment` job remains the FULL authority and is not weakened. It retains the release/deployment qualification including container builds, SBOM/vulnerability scanning, deployed health/monitoring/malware/storage checks, visual regression, browser workflows, fault injection, capacity, restore, accessibility/engine matrices and trusted TLS/WSS.

A merge-ready candidate must still satisfy the project’s exact-head FULL acceptance contract where that contract requires `backend` + `deployment`.

## Post-merge

A normal push to `main` runs FAST + STANDARD. Do not automatically repeat FULL merely because the accepted candidate was merged. Re-run FULL when the accepted evidence is invalidated by merge resolution, base/workflow/configuration/build-input change, or when the release contract explicitly requires main-branch FULL acceptance.

## Parallel progress

While FULL is running, one explicitly authorized independent next package may proceed in a separate worktree/branch from the correct accepted base. Dependent work waits for the merge. Never mutate the frozen acceptance branch.

No security, resilience, capacity, accessibility, deployment or recovery gate has been removed; CI-3L changes **when** the expensive tier runs, not what FULL proves.
