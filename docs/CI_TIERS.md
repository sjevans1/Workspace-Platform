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

## Identifiable workflow runs for the Framework controller (staged)

This repository retains its original `Workspace verification` FAST workflow and CI-3L job coverage. For **new owner-authorized work packages** under the risk-qualified Hermes controller, use these distinct workflow identities for the two higher tiers:

| Tier | GitHub Actions workflow name | Dispatch |
| --- | --- | --- |
| FAST | `Workspace verification` | Automatic PR run (or the existing FAST dispatch) |
| STANDARD | `Workspace STANDARD qualification` | Manual workflow dispatch at the reviewed candidate ref |
| FULL | `Workspace FULL qualification` | Manual workflow dispatch at the frozen candidate ref **after** independent Haiku acceptance and fresh Luna review |
| Docs-only | `Documentation checks` | Automatic for Markdown-only PRs; no package build, STANDARD or FULL |

The STANDARD and FULL entrypoints reuse the existing CI implementation via GitHub `workflow_call`; they do not duplicate or relax the application, security, build, deployment or offline jobs. The older single-workflow dispatch remains available for legacy/manual troubleshooting but **must not be claimed as an independently identified STANDARD/FULL run** by the new controller.

The controller's `ci_workflows` values must match the actual GitHub `workflowName`. Its per-tier `ci_tiers` job-name manifests must be captured from a real successful run of each wrapper because reusable job names may have a qualified prefix. An unverified job name, dispatch context, missing suite identity or mismatched SHA blocks activation.

Docs-only qualification is permitted only for an exact-head GitHub diff consisting entirely of literal Markdown files (`.md`/`.mdx`), with verified independent Haiku/Luna stages and a human merge decision. Changes to `framework.lock`, `.github/workflows/`, scripts, application code or security configuration cannot claim docs-only. The dedicated documentation workflow checks UTF-8, conflict markers and diff whitespace. Non-Markdown changes continue to run the main CI.

**Important:** These entries introduce a CI transport compatible with future controller activation; they do not activate or re-admit currently running Hermes work packages, alter a reserved correction allowance, change model routing or authorize a merge. See [framework adoption](FRAMEWORK_ADOPTION.md).
