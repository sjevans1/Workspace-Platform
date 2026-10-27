# Workspace Platform — OpenJM Development Team handover

**Prepared:** 2026-10-26 · **Scope:** `sjevans1/Workspace-Platform` (not the separate OpenJM Enterprise AI repository) · **Source baseline:** `main@aa89038e998b8fade973557285501ff2d5efa826` (last inspected). This handover branch must be reviewed and merged before its documentation becomes the main-branch reference.

## First-day reading order

1. [README](../README.md), [DEVELOPMENT](DEVELOPMENT.md) and [CONTRIBUTING](../CONTRIBUTING.md) — installation, tests and PR discipline.
2. [ARCHITECTURE](ARCHITECTURE.md), [IDENTITY](IDENTITY.md), [SCIM](SCIM.md) and [CONNECTED_WORK_ARCHITECTURE](CONNECTED_WORK_ARCHITECTURE.md) — code boundaries and authorization.
3. [AUTOMATION_ARCHITECTURE](AUTOMATION_ARCHITECTURE.md) and [CONNECTED_WORK_UX](CONNECTED_WORK_UX.md) — workflow model and customer journeys.
4. [OPERATIONS](OPERATIONS.md), [RELEASE_SECURITY](RELEASE_SECURITY.md), [PROVIDER_EGRESS](PROVIDER_EGRESS.md) and [RELEASE_1_0_FINAL_GATES](RELEASE_1_0_FINAL_GATES.md) — deployments, provider safety and acceptance.
5. [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62) and live PRs for **current state**. Older `BUILD_CHECKPOINT` and `ROADMAP` snapshots are historical; do not treat their old "current" claims as fresh acceptance.

## Implemented, accepted or available on main

- Core standalone Workspace: organizations/spaces/pages, collaboration, permission-filtered search, typed databases, import/export, comments, attachments, SSO/SCIM, revisions and recovery.
- Tenant RLS/authorization, audit, storage encryption and migration checksums; local or S3-compatible private object storage; configurable telemetry and separately governed Fleet operations.
- W01–W28 baseline and W27 security/release evidence remain historical acceptance evidence, not a new final-1.0 certification.
- W29-A provider-neutral connector foundation and W30 deterministic workflow foundation were accepted together in [PR #222](https://github.com/sjevans1/Workspace-Platform/pull/222); provider-specific production integrations are **not** thereby accepted.
- W29-P0/A1 and A2 groundwork have merged by the inspected baseline. A2 Fleet egress posture is Fleet-local diagnostics, **not** verified deployment-specific provider activation approval.

## Unfinished release-critical work

| Order | Item | Required disposition |
|---|---|---|
| 1 | [W29-P0/A3 PR #235](https://github.com/sjevans1/Workspace-Platform/pull/235) | Open at handover; review exact head, CI and security corrections. Do **not** count OAuth UX/token refresh as merged. |
| 2 | [W29-P0/A4](https://github.com/sjevans1/Workspace-Platform/issues/230) and [deployment egress #234](https://github.com/sjevans1/Workspace-Platform/issues/234) | Provider usage attribution, removal of out-of-scope provider metadata, integrated P0 safety and deployment-scoped egress evidence before any real-provider activation. |
| 3 | [W29 Connected Work #215](https://github.com/sjevans1/Workspace-Platform/issues/215) and [W29 real-provider tranche](https://github.com/sjevans1/Workspace-Platform/issues/225) | Customer-owned credentials/economics, safe real email/calendar providers, backend + polished Connections UI, end-to-end acceptance. Validate actual provider scope with product owner; do not assume metadata-only adapters are implemented. |
| 4 | [W30 native workflows #216](https://github.com/sjevans1/Workspace-Platform/issues/216) | Complete scheduled/event triggers, approvals, actions, run histories and integrations beyond the merged foundation. |
| 5 | [Manual NVDA #211](https://github.com/sjevans1/Workspace-Platform/issues/211) | Human keyboard/screen-reader acceptance on **final W29/W30** surface. |
| 6 | [W31 final release #217](https://github.com/sjevans1/Workspace-Platform/issues/217) | Freeze SHA, full acceptance, independent host UAT, recovery, security and supply-chain requalification, product-owner release approval and tag. |

Do not tag the older W27/W28 baseline as final 1.0.

## Open PR triage at handover (not merged by this change)

- [#235](https://github.com/sjevans1/Workspace-Platform/pull/235): W29 OAuth substrate, business functionality; review before merging.
- [#236](https://github.com/sjevans1/Workspace-Platform/pull/236): development-framework reference; draft, optional staged adoption. Keep external build tooling separate from product scope.
- [#237](https://github.com/sjevans1/Workspace-Platform/pull/237) then [#238](https://github.com/sjevans1/Workspace-Platform/pull/238): stacked docs-only/CI entrypoint proposals; review ordering, then retarget as appropriate. Not active on main.
- [#190](https://github.com/sjevans1/Workspace-Platform/pull/190): runner/action pin refresh; currently conflicts with other workflow changes, reconcile in an independent CI PR.
- **Closed as superseded (unmerged, 2026-10-26):** [#159](https://github.com/sjevans1/Workspace-Platform/pull/159) (W18 device-local recovery, replaced by merged #162); [#134](https://github.com/sjevans1/Workspace-Platform/pull/134) (retired agent bridge settings, removed in this handover); [#118](https://github.com/sjevans1/Workspace-Platform/pull/118) (older project/handoff text, replaced here); and [#220](https://github.com/sjevans1/Workspace-Platform/pull/220) (planning superseded by merged #221). Their branches may be removed once repository-level rules permit and any branch-specific deployment references are checked; do not merge these outdated proposals.

## Branch hygiene after handover

- The 27 confirmed-merged historical branches were deleted by the repository owner before this revision; a fresh repository check found 15 total branches remaining.
- Retain `main`, the unmerged handover PR branch until merged, active W29 #235, infrastructure/CI proposals #190/#237/#238, and separately review governance #236.
- Retain the closed-but-unmerged OIDC provenance branch from #42 until its session-state constraints and later migrations are reconciled by the identity owner; older branch PRs #140/#141/#207 may be archived once their changes are confirmed superseded and no ref is consumed externally.
- Git branch deletion rules remain owner-managed; never force-delete or rewrite history to bypass them.

## Non-negotiable boundaries

- Three layers remain distinct: Workspace customer runtime, optional Workspace Fleet operator plane, and separately deployed OpenJM Enterprise AI. Do not add mandatory cross-product coupling.
- Tenant claims from client input never confer authority; check real role/membership, RLS and object permissions at every privileged read/write and external action.
- Never activate real providers with merely Fleet-local networking diagnostics; ensure deployment-scoped egress [#234](https://github.com/sjevans1/Workspace-Platform/issues/234) is accepted first.
- No external provider credentials in browser bundles. Connections must clearly distinguish configured, connected, expired, revoked, disabled and approval-required states. The customer owns provider accounts/costs.
- No destructive access change from a dropdown selection alone: show the proposed change, request explicit confirmation, persist it and show the resulting state.
- FAST is feedback, STANDARD qualifies a work package, FULL is final exact-head acceptance when required. Manual review and merge authorization remain separate.

## Recommended next actions

1. Approve and merge this handover PR **only after** its own CI and diff review. It does not authorize release.
2. Establish named code owners, environment/secret ownership, deployment contacts and restore-drill custody *out of band*; never add real credentials or host IPs to this public repo.
3. Choose an accepted parent SHA for each open workstream and reconcile competing CI PRs before touching CI workflows.
4. Resume #235 review/corrections, then A4 and #234, then real provider UX/backend, full W30, final NVDA, and W31.
5. At release, create a signed-off evidence record: frozen commit, build artifacts, SBOM, dependency/image advisories, backup/restore, RLS tests, regression suites, accessible UAT, supported deployment matrix, change log and rollback plan.

See [Sanitization audit](SANITIZATION_AUDIT.md) for what this handover cleanup changes and what it cannot erase from Git history.
