# CI-3L Verification Tiers

Workspace keeps the existing release-grade checks, but no longer runs the entire release qualification as the first feedback loop for every pull-request update.

## FAST — iteration

**Trigger:** every pull request; every push to `main`; manual dispatch with `suite=fast|standard|full`.

Runs:
- exact repository checkout;
- `npm ci`;
- TypeScript/integration-client typecheck;
- CI-orchestrator tests;
- production frontend build.

FAST is rapid deterministic feedback. It does not establish package or release acceptance.

## STANDARD — work-package qualification

**Trigger:** push to `main`, or manual dispatch with `suite=standard` or `suite=full`.

The existing `backend` job remains the STANDARD authority and retains:
- PostgreSQL + SeaweedFS services;
- full native `npm test`;
- mirrored-dependency guard;
- CI-orchestrator verification;
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

## Separate CI qualification workflows (proposed)

This proposal gives GitHub Actions an explicitly named workflow for each acceptance tier. **Nothing in this section is active on `main` until its PR is reviewed and merged.**

| Tier | GitHub Actions workflow name | Trigger |
| --- | --- | --- |
| FAST | `Workspace verification` | Automatic pull request verification |
| STANDARD | `Workspace STANDARD qualification` | Manual dispatch at the reviewed candidate ref |
| FULL | `Workspace FULL qualification` | Manual dispatch at the frozen candidate ref, after independent acceptance and required security review |
| Docs-only | `Documentation checks` | Automatic only for qualifying Markdown-only pull requests |

STANDARD and FULL reuse the existing CI workflow with GitHub `workflow_call` and must preserve the existing security, accessibility, offline, browser, deployment and recovery checks. A green FAST run never substitutes for a required STANDARD or FULL gate.

Before adopting the wrappers, verify GitHub's observed workflow names, job identities, suite inputs, dispatch refs and exact-head results. An unverified job name, missing suite identity, skipped required job or SHA mismatch blocks qualification. The original single-workflow manual dispatch remains available for troubleshooting but cannot be misrepresented as a separate qualification workflow.

Docs-only verification requires an exact-head diff containing only Markdown files (`.md` and `.mdx`). Changes to `.github/workflows/`, scripts, application code, configuration, dependencies or security policy always require the normal CI lane. The docs workflow validates UTF-8, conflict markers and whitespace. All merges still require authorized human review.

These workflows change **how acceptance evidence is identified**, not application behavior, reviewer independence, release authority or the required test coverage.
