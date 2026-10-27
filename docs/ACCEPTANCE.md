# Workspace acceptance status and evidence boundaries

**Handover snapshot (2026-10-26):** The latest inspected baseline is `main@aa89038e998b8fade973557285501ff2d5efa826`. This document separates *accepted historical scope*, *current functional foundations* and *remaining release qualification*. For live state read [TEAM_HANDOVER](TEAM_HANDOVER.md) and the [release tracker](https://github.com/sjevans1/Workspace-Platform/issues/62).

## Evidence carried forward

| Scope | Evidence boundary |
|---|---|
| W01–W28 core workspace, release hardening and standalone runtime | Accepted prior-wave baseline; see [roadmap](ROADMAP_1_0.md), [issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62), acceptance PRs and exact-head CI artifacts |
| W27 image, privacy, dependency, storage and distribution gates | See [W27 acceptance](W27_SECURITY_PRIVACY_DISTRIBUTION_ACCEPTANCE.md) and [release security](RELEASE_SECURITY.md); requalify final changed release image |
| SSO/OIDC/SCIM and tenant RLS | Tested provider-host and CI evidence; see [identity](IDENTITY.md), [SCIM](SCIM.md), [Keycloak host runbooks](KEYCLOAK_OIDC_HOST_ACCEPTANCE.md) and [logout runbook](KEYCLOAK_LOGOUT_HOST_ACCEPTANCE.md) |
| Independent disposable WSL2 host install/restore | Operator-reported PASS for tested historical SHA, trusted TLS/LAN was NOT executed in that host run; see [host report](HOST_ACCEPTANCE_EVALUATION.md). Separate trusted HTTPS CI evidence exists. |
| W29-A governed connector and W30 workflow foundations | Accepted and merged [PR #222](https://github.com/sjevans1/Workspace-Platform/pull/222). Provider-neutral acceptance does not certify real email/calendar adapters. |
| W29-P0/A1+A2 groundwork | Merged by inspected main; A2 has Fleet-local egress diagnostics only; deployment-scoped verification #234 remains required before real-provider activation. |

## Still open before Workspace 1.0

- [W29/P0 OAuth #235](https://github.com/sjevans1/Workspace-Platform/pull/235) is **open**, not merged at this snapshot.
- W29 real-provider adapters, provider ownership/cost attribution, approved network egress, full Connections UX and external action approval must be implemented and independently accepted.
- W30 workflows must complete their native UI, schedule, approval and external/provider action journeys beyond the merged foundation.
- [Manual NVDA #211](https://github.com/sjevans1/Workspace-Platform/issues/211) must be performed against final W29/W30.
- [W31 release #217](https://github.com/sjevans1/Workspace-Platform/issues/217) requires the frozen exact-head FULL gate, independent UAT, recovery, security, provider opt-in, supply chain, compatibility and product-owner signoff **before tag**.

A green FAST run or an earlier W27/W28 acceptance run is **not** a Workspace 1.0 release claim. Check [final release gates](RELEASE_1_0_FINAL_GATES.md) and the SHA under review.
