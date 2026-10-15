# OpenJM Development Framework v1.8.3 — Workspace adoption

**Status (2026-10-15): reference pinned; controller activation NOT YET AUTHORIZED.**  
**Repository:** `sjevans1/Workspace-Platform`  
**Approved framework:** [v1.8.3 merged on main](https://github.com/sjevans1/OpenJM-Development-Framework/commit/b9cc14d708311417d6945e074799f4cb3d46cf8b); immutable `framework.lock` at this repository root.  
**Adoption branch baseline:** `main@aa89038e998b8fade973557285501ff2d5efa826`.

This is a controlled **documentation/reference adoption**, not a replacement for an active work package or a product runtime change. It does not deploy software, activate Hermes controller state, change CI definitions, alter package counters, or authorize any product merge.

## Authority and technical boundaries

- Human + Astra (manual) approve direction; GPT-6 Luna frames authorized bounded packages; DeepSeek V4.1 Flash implements and handles bounded CI corrections; Claude Haiku 5.5 independently accepts; a ledger-verified **fresh Luna session** reviews; the human retains the final merge decision.
- **MAX reasoning effort** remains the configured preference. Haiku must use its scoped Anthropic Messages route, no fallback providers, and no GLM/Sol dispatch in the governed workflow.
- The hard limit is **two meaningful correction cycles total per package** across CI, acceptance and review. A third fails closed; escalation does not create another budget. Never reset existing repair or approval state as a side effect of adoption.
- The product stays a **standalone, independently deployable Workspace** without mandatory OpenJM Enterprise AI, an LLM, external credentials, hosted model or optional connector. The engineering assistant/workflow is *not* a runtime dependency and must not change the app's security, architecture or offline functionality.
- Scope and acceptance are governed by [Workspace 1.0 release gates](RELEASE_1_0_FINAL_GATES.md), [CI tiers](CI_TIERS.md), [acceptance](ACCEPTANCE.md) and the [standalone roadmap](ROADMAP_1_0.md); historical W27 and earlier passes stay bound to their recorded commit and evidence. This reference lock cannot mark W29/W30/W31 accepted.

## Preserve active development

- Do not alter, merge, rebase or reframe **W29-P0/A3 PR #235** or any ongoing W29/W30/W31 work. This adoption is branched from main and contains only framework metadata and guidance.
- Prior acceptance records, versioned migration/tenant controls, permission and token lifecycle, CI history, leases, correction reservations and owner approvals remain untouched. Before activating any controller, reconcile **live** GitHub and Hermes state and adopt only at an explicitly approved, safe **new-package** boundary.
- Keep FAST/ STANDARD/ FULL run costs and approved scope intact. Do not trigger a release-grade FULL merely to validate these documentation additions; this change is not a release candidate.

## Compatibility gap before controller activation

The current `.github/workflows/ci.yml` runs FAST/STANDARD/FULL in a **single** workflow, `Workspace verification`, with `workflow_dispatch.inputs.suite` controlling the tier and `backend`/`deployment` used for larger gates. Framework v1.8.3's controller currently compares a tier against its predeclared `ci_workflows` workflow identity. Identical identities alone cannot distinguish FAST/STANDARD/FULL.

**Controller activation is blocked** until the actual tier is proven from authoritative GitHub evidence, rather than caller labels or equivalent job names. Resolve this via a separately reviewed CI/workflow-identity adjustment or verified-suite-attestation extension, retaining all current backend/deployment, access-control, restore, vulnerability, accessibility, visual and browser tests. Add negative tests for STANDARD-as-FULL, wrong tier/workflow, premature FULL, missing jobs, stale head, and invalidated proof. No silent skips, duplicate expensive CI or downgrade.

## Separate safe cutover plan

1. Finish or safely checkpoint the active W29-P0/A3 package, preserving its live CI and review evidence, correction-budget reservations and human merge boundary.
2. Reconcile the release-plan state including W29 → W30 → final NVDA → W31 qualification; do not rewrite historical acceptance to match the newer framework.
3. Build and review the CI tier-identity compatibility change independently, with exact-head negative gates and no regression in full release jobs.
4. Select and authorize the first **new** package under the 1.8.3 controller; pin its approved plan revision, `ci_tiers`, trusted `ci_workflows`, model/session provenance, explicit human approvers, and exact-head FULL acceptance for release/frozen work.
5. Verify the Hermes profile/ledger and end-to-end workflow in an isolated test project, then activate explicitly. A blocked proof stays blocked rather than falling back.
6. Require separate human approval to merge each product PR or deploy.

## Evidence and ownership

- The intended diff here is limited to `framework.lock`, this document and a README pointer. The reference change is documentation-only; link/YAML checks and appropriately scoped FAST checks qualify this PR. It is **not** evidence of completed controller activation or Workspace 1.0 FULL.
- The human owner retains framework-adoption activation and every product merge decision.
