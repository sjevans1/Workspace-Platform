# First-pass acceptance status

This is an executable alpha built from the OpenJM Workspace Astra handoff, not a claim that the complete MVP definition of done has been met.

## Verified through 30 September 2026

The latest identity/RLS hardening gate passed in [GitHub Actions run 36797135204](https://github.com/sjevans1/Workspace-Platform/actions/runs/36797135204), testing final branch head `a1fe48f2e6259f302d18597d970e78d5112114d7`, which was squash-merged as `8965a7dfab6dce3c39d66332cd71aee2f8ad993a`. The native application integration suite now runs as the same restricted `workspace_runtime` role used by the Docker deployment, with `NOBYPASSRLS`.

| Check | Result |
|---|---|
| Dependency install from lockfile | Pass |
| Backend and frontend TypeScript | Pass |
| Next.js production build | Pass |
| Unit, API, collaboration, identity and backup tests | 36 passed, 0 failed in latest native PostgreSQL gate |
| Two live Yjs clients and reconnect | Pass in backend integration test |
| Tenant policy, known-ID isolation, ancestor ACL revocation | Pass |
| Concurrent ACL replacement and stale-write rejection | Pass; simultaneous conflicting saves resolve as one success and one 409 |
| Service-token scope and guest-default isolation | Pass |
| Private files and revoked parent access | Pass |
| Canonical content, search, history and stale-revision rejection | Pass |
| Typed records, saved filters, full record page body | Pass |
| Signed webhook dispatch and failed-delivery retry | Pass |
| Markdown/CSV imports and permission recheck | Pass |
| Trash cascade and restore | Pass |
| Permanent purge, retention and object cleanup | Pass; explicit purge and automatic expiry regression covered |
| Backup metadata, Yjs bytes and attachment round trip | Pass; corrupt/nonempty restore rejected |
| Native PostgreSQL 17 test suite | 36 passed under `workspace_runtime` with `rolbypassrls=false`; clean process shutdown |
| Migration rollback/retry and historical checksum integrity | Pass; failed partial DDL rolls back, corrected retry succeeds, reruns are idempotent, applied-file drift is rejected |
| Docker image, migrations and full Compose startup | Pass; API, collaboration and worker all report healthy before browser acceptance |
| Deployed Chromium workflow through Caddy | Pass; setup, shared editing, server persistence, reload, comments, history, Markdown export, table and board |
| Mobile viewport, 390 × 844 | Pass; sidebar navigation and no document-width overflow |
| Browser runtime errors | None in the primary session during the tested workflow |
| OIDC / Keycloak authentication foundation | Pass in CI run 36770930101: state/nonce/PKCE, signed ID-token validation, verified email, existing-user linking, invitation provisioning and replay rejection |
| OIDC back-channel session revocation | CI PASS in run 36797135204 under restricted `workspace_runtime`: signed logout JWT validation, replay safety, tenant-RLS audit insertion, session revocation and local break-glass preservation. Real Keycloak emission was confirmed on WSL2, but that host run required a temporary `BYPASSRLS` workaround before the defect was fixed; one no-workaround host rerun remains before production-role acceptance is closed. |
| Real Keycloak host/browser acceptance | Hermes-reported PASS on `1702779fa5d31a8de159ee6d476e451d90e316f3` with Keycloak 26.7.4: discovery, owner linking, repeat login, passwordless invited member, mismatch rejection, SSO-only mode and disabled-user new-login rejection all passed |
| Independent WSL2 host deployment and recovery | Hermes-reported PASS on `b392f4113`: fresh install, 2/2 browser tests, restart persistence, idempotent migrations, backup, isolated restore, recovered sign-in/content and operational status; trusted TLS not executed |

Local backend tests run against PGlite's PostgreSQL engine, with serialized test transactions because its socket bridge multiplexes one backend. Production uses normal native PostgreSQL transactions. Native PostgreSQL is a separate required CI gate, not assumed equivalent solely from PGlite results.

Browser acceptance ran against the full Docker deployment, using the restricted runtime database account and the Caddy reverse proxy. Two independent signed-in browser contexts exchanged edits; the test also queried canonical API content before opening the second context and checked content after reload. This is one Chromium acceptance scenario, not a complete browser or accessibility audit. Local Chromium could not launch in the managed build environment, so CI supplied the browser evidence.

The successful CI run contains a browser-results artifact with home, editor, table, board and mobile screenshots. Desktop layouts and the mobile screenshot were visually inspected. Automatic approval review blocked adding those images to the public source repository because they contain workspace/user labels; they are not included in this documentation commit.

## Implemented features

The repository contains a connected interface, API, collaboration server, import/webhook worker, migrations, demo content, runtime branding, scoped integration surface, local/S3 storage abstraction, logical backups, container deployment and license inventory. The README and integration guide document the usable routes and startup commands.

## Remaining before a production MVP release

| Area | Remaining work or current boundary |
|---|---|
| Identity | Deployment-level OIDC/Keycloak SSO and standards-based OIDC back-channel session revocation are implemented. Real Keycloak login/provisioning/SSO-only acceptance has passed. Keycloak itself was observed emitting the real logout token and the expected revocation behavior was proven only after a disposable `BYPASSRLS` workaround exposed an audit/RLS defect; PR #16 fixed that defect without weakening RLS, and CI now passes as `workspace_runtime`/`NOBYPASSRLS`. A short no-workaround real-Keycloak retest remains. Workspace membership deactivation already revokes tenant sessions. Remaining: directory/SCIM offboarding, per-tenant IdPs, group/role mapping, RP/front-channel logout, application-enforced MFA context, local password recovery and invitation email delivery. |
| Editor coverage | Default BlockNote Core blocks, slash menu, formatting, links, images/files and tables are integrated. Custom callout/divider/wiki-link/backlink behaviour, a complete block-type acceptance matrix and block-anchored comment UI remain. The API accepts optional comment block IDs. |
| Offline and scale | Offline edits are memory-only until acknowledged; no durable local offline queue. Single collaboration writer, no horizontal coordination. Load/concurrency and reconnect fault-injection benchmarks remain. |
| Databases | No formulas, relations, rollups, advanced cross-database queries or import mapping wizard. Property schema changes validate existing data; destructive schema transformations need explicit migration support. Board keyboard updates use selectors. |
| Permissions and tenancy | API/WS/job/file/search policy checks and forced tenant RLS exist. ACL writes use optimistic revisions plus tenant tree locking; duplicate, cross-tenant and inactive-principal grants are rejected, and concurrent stale writes are covered in CI. Administrator CSV audit export is implemented. Broader adversarial testing and operational tenant-provisioning tooling remain before customer rollout. |
| Retention | Permanent administrator purge, configurable 1–3650 day trash retention (or disabled), automatic expired resource/file cleanup, durable retry/dead object deletion, and backup coverage are implemented and passed CI run 36660728414. Search and trash listings remain bounded; customer-specific legal/retention policy validation remains deployment work. |
| Files | No antivirus, quarantine, content disarm or resumable upload. Maximum upload 25 MiB. Authenticated SeaweedFS 4.47 interoperability and recovery are exercised in CI; production-provider validation, antivirus, quarantine, content disarm and resumable upload remain. |
| Import/export | Markdown/CSV imports capped at 2 MiB; CSV at 2,000 rows/100 columns. Synchronous exports cap at 10,000 records. No bulk zipped workspace export or large streamed job output. |
| Integrations | No actual OpenJM Intelligence deployment connected. Stable event cursor, reconciliation API, receiver secret rotation and dead-letter replay UI remain. The example documents mandatory permission recheck. |
| API contracts | Versioned routes and interactive OpenAPI inventory exist. Core external integration routes now publish tested machine-readable request/query/path/response schemas. Complete SDK-grade schemas for the remaining human/admin routes and a generated client SDK are not finished. |
| Operations | API readiness plus Docker health for API/collaboration/worker are enforced in CI; worker health detects repeated failures and stuck ticks, collaboration verifies its writer lease, and admins can inspect tenant queue backlogs. Independent WSL2 installation, restart persistence, logical backup/recovery and operational status have been exercised successfully. Trusted HTTPS/LAN installation, production-provider S3 drill, external metrics/alerts, encryption-at-rest integration and release image scanning remain rollout requirements. Migration files are checksum-pinned and rollback/retry behavior is covered in native PostgreSQL CI. |
| Browser/accessibility | The Chromium workflow and screenshots pass in CI. Accessibility audit, keyboard/focus testing of all dialogs, visual regression and multiple browser engines remain. |
| Branding | Runtime and sign-in configuration exist. Light theme is implemented; dark-logo config is retained but a full dark theme is not implemented. |
| Licensing | Unmodified dependency notices and npm SBOM are included. Mirror the exact MPL source archives and generate container/base-OS SBOMs for each commercial release. Final product/legal packaging still needs review. |

## Suggested next acceptance slice

With native PostgreSQL/container/browser gates, independent WSL2 deployment/recovery, real Keycloak login acceptance, real Keycloak logout-token emission evidence, and the RLS defect fixed in CI under `workspace_runtime`/`NOBYPASSRLS`, the next identity acceptance is a short no-workaround Keycloak logout rerun. After that, identity work moves to directory/SCIM offboarding design. Trusted TLS and the selected production S3/object-store recovery drill remain separate host-level gates. Directory lifecycle, operational hardening and the remaining security/accessibility items must still be resolved before calling the product production ready.
