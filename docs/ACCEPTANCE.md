# First-pass acceptance status

This is an executable alpha built from the OpenJM Workspace Astra handoff, not a claim that the complete MVP definition of done has been met.

## Verified through 30 September 2026

The latest production-hardening gate passed in [GitHub Actions run 36809767605](https://github.com/sjevans1/Workspace-Platform/actions/runs/36809767605), testing production-S3-harness branch head `54c565ac30556353ca88d7cc71b382d36e219ec3`, which was squash-merged as `c4b86d8c326fea9aee7d087af88faab076bb46a5`. The native application integration suite still runs as the same restricted `workspace_runtime` role used by Docker, with `NOBYPASSRLS`.

| Check | Result |
|---|---|
| Dependency install from lockfile | Pass |
| Backend and frontend TypeScript | Pass |
| Next.js production build | Pass |
| Unit, API, collaboration, identity and backup tests | 37 passed, 0 failed in latest native PostgreSQL gate |
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
| Native PostgreSQL 17 test suite | 37 passed under `workspace_runtime` with `rolbypassrls=false`; clean process shutdown |
| Migration rollback/retry and historical checksum integrity | Pass; failed partial DDL rolls back, corrected retry succeeds, reruns are idempotent, applied-file drift is rejected |
| Docker image, migrations and full Compose startup | Pass; API, collaboration and worker all report healthy before browser acceptance |
| Deployed Chromium workflow through Caddy | Pass; setup, shared editing, server persistence, reload, comments, history, Markdown export, table and board |
| Trusted HTTPS edge | PASS in run 36809176797: Caddy internal-CA deployment trusted by the runner/browser without certificate bypass, HTTP→HTTPS redirect, HSTS, Secure/HttpOnly SameSite=Lax Workspace session cookie, no insecure browser requests, and WSS collaboration |
| Production S3 acceptance harness | PASS in run 36809767605 against two pre-created disposable SeaweedFS buckets: no bucket-admin operations, explicit write confirmation, conditional immutable PUT, source backup, collision-safe restore refusal, separate recovery database/bucket, canonical Yjs + retained-file recovery, source preservation and bounded cleanup. This gate is conditional: deployments using local filesystem storage do not require an external S3-provider acceptance run; deployments selecting S3-compatible storage must pass the same harness against that provider. |
| Mobile viewport, 390 × 844 | Pass; sidebar navigation and no document-width overflow |
| Browser runtime errors | None in the primary session during the tested workflow |
| OIDC / Keycloak authentication foundation | Pass in CI run 36770930101: state/nonce/PKCE, signed ID-token validation, verified email, existing-user linking, invitation provisioning and replay rejection |
| OIDC back-channel session revocation | PASS. CI run 36797135204 passed under restricted `workspace_runtime` with `rolbypassrls=false`. A no-workaround WSL2 regression retest on Workspace `9894b95686c6229a956b93c0a2263e4434aae184` with Keycloak 26.7.4 proved Keycloak-emitted back-channel logout, tenant-RLS audit insertion, old-session rejection (401), local break-glass preservation, fresh-login recovery, and final `workspace_runtime` `rolsuper=false` / `rolbypassrls=false`. |
| Real Keycloak host/browser acceptance | Hermes-reported PASS on `1702779fa5d31a8de159ee6d476e451d90e316f3` with Keycloak 26.7.4: discovery, owner linking, repeat login, passwordless invited member, mismatch rejection, SSO-only mode and disabled-user new-login rejection all passed |
| SCIM 2.0 Users lifecycle | PASS under restricted `workspace_runtime`: tenant-scoped connector auth, Users create/list/filter/PATCH/PUT/delete, inactive-by-default provisioning, audit events, immediate same-tenant session revocation on `active:false`/DELETE, and preservation of the same global user's other-tenant session |
| SCIM 2.0 Groups + role mapping | PASS in run 36807221040: Group discovery/CRUD/filtering, same-tenant SCIM User membership, rejection of manual users as Group members, explicit `guest`/`member` mappings, `member` precedence over `guest`, base-role restoration when mappings are removed, tenant-safe foreign keys, and backup/recovery of Groups/members/mappings |
| Deployed SCIM administration | PASS in Chromium: Settings creates/revokes a one-time SCIM credential and maps a synchronized Group through the UI; bearer discovery works through Caddy and the revoked token returns 401 |
| Independent WSL2 host deployment and recovery | Hermes-reported PASS on `b392f4113`: fresh install, 2/2 browser tests, restart persistence, idempotent migrations, backup, isolated restore, recovered sign-in/content and operational status; trusted TLS not executed |

Local backend tests run against PGlite's PostgreSQL engine, with serialized test transactions because its socket bridge multiplexes one backend. Production uses normal native PostgreSQL transactions. Native PostgreSQL is a separate required CI gate, not assumed equivalent solely from PGlite results.

SCIM transaction boundary note: an early browser/integration run exposed that returning `reply.send()` from inside the tenant transaction could release the HTTP response before COMMIT completed. The SCIM response path now returns its payload only after `db.tenant(...)` resolves, so a successful offboarding response represents committed membership/session state.

Host live-collaboration note: the final Keycloak regression proved server-side OIDC session deletion and HTTP rejection of the old session. The report did not include a directly observed post-logout WebSocket edit/persistence attempt, so that narrow host observation is not claimed beyond the collaboration server's existing session-recheck behavior and automated coverage.

Browser acceptance ran against the full Docker deployment, using the restricted runtime database account and the Caddy reverse proxy. Two independent signed-in browser contexts exchanged edits; the test also queried canonical API content before opening the second context and checked content after reload. This is one Chromium acceptance scenario, not a complete browser or accessibility audit. Local Chromium could not launch in the managed build environment, so CI supplied the browser evidence.

The successful CI run contains a browser-results artifact with home, editor, table, board and mobile screenshots. Desktop layouts and the mobile screenshot were visually inspected. Automatic approval review blocked adding those images to the public source repository because they contain workspace/user labels; they are not included in this documentation commit.

## Implemented features

The repository contains a connected interface, API, collaboration server, import/webhook worker, migrations, demo content, runtime branding, scoped integration surface, local/S3 storage abstraction, logical backups, container deployment and license inventory. The README and integration guide document the usable routes and startup commands.

## Remaining before a production MVP release

| Area | Remaining work or current boundary |
|---|---|
| Identity | Deployment-level OIDC/Keycloak SSO, standards-based back-channel logout, and tenant-scoped SCIM 2.0 Users/Groups lifecycle are implemented. SCIM `active:false`/DELETE deactivates only the connector tenant membership and immediately revokes that tenant's Workspace sessions while preserving the same global user's other-tenant access. Groups synchronize only SCIM-managed users; Workspace owners/admins may explicitly map Groups to `member` or `guest`, never `owner`/`admin`. Remaining: per-tenant IdPs, broader provider compatibility, RP/front-channel logout, application-enforced MFA context, local password recovery, invitation email delivery, and any future group-to-page/ACL policy. |
| Editor coverage | Default BlockNote Core blocks, slash menu, formatting, links, images/files and tables are integrated. Custom callout/divider/wiki-link/backlink behaviour, a complete block-type acceptance matrix and block-anchored comment UI remain. The API accepts optional comment block IDs. |
| Offline and scale | Offline edits are memory-only until acknowledged; no durable local offline queue. Single collaboration writer, no horizontal coordination. Load/concurrency and reconnect fault-injection benchmarks remain. |
| Databases | No formulas, relations, rollups, advanced cross-database queries or import mapping wizard. Property schema changes validate existing data; destructive schema transformations need explicit migration support. Board keyboard updates use selectors. |
| Permissions and tenancy | API/WS/job/file/search policy checks and forced tenant RLS exist. ACL writes use optimistic revisions plus tenant tree locking; duplicate, cross-tenant and inactive-principal grants are rejected, and concurrent stale writes are covered in CI. Administrator CSV audit export is implemented. Broader adversarial testing and operational tenant-provisioning tooling remain before customer rollout. |
| Retention | Permanent administrator purge, configurable 1–3650 day trash retention (or disabled), automatic expired resource/file cleanup, durable retry/dead object deletion, and backup coverage are implemented and passed CI run 36660728414. Search and trash listings remain bounded; customer-specific legal/retention policy validation remains deployment work. |
| Files | Local filesystem storage and S3-compatible object storage are both supported deployment modes. Local storage keeps attachment bytes on the Workspace host/attached storage and has no external-provider gate. If S3-compatible storage is selected, that provider must pass the production S3 acceptance harness before rollout. No antivirus, quarantine, content disarm or resumable upload. Maximum upload 25 MiB. |
| Import/export | Markdown/CSV imports capped at 2 MiB; CSV at 2,000 rows/100 columns. Synchronous exports cap at 10,000 records. No bulk zipped workspace export or large streamed job output. |
| Integrations | No actual OpenJM Intelligence deployment connected. Stable event cursor, reconciliation API, receiver secret rotation and dead-letter replay UI remain. The example documents mandatory permission recheck. |
| API contracts | Versioned routes and interactive OpenAPI inventory exist. Core external integration routes now publish tested machine-readable request/query/path/response schemas. Complete SDK-grade schemas for the remaining human/admin routes and a generated client SDK are not finished. |
| Operations | API readiness plus Docker health for API/collaboration/worker are enforced in CI; worker health detects repeated failures and stuck ticks, collaboration verifies its writer lease, and admins can inspect tenant queue backlogs. Independent WSL2 installation, restart persistence, logical backup/recovery and operational status have been exercised successfully. Trusted HTTPS is now CI-verified through the same Caddy deployment path for a managed private CA; a real customer-LAN certificate/device rollout remains an environment exercise. Storage is deployment-selectable: local filesystem requires no external provider acceptance, while any selected S3-compatible provider must pass the provider-safe recovery harness. External metrics/alerts, encryption-at-rest integration and release image scanning remain rollout requirements. Migration files are checksum-pinned and rollback/retry behavior is covered in native PostgreSQL CI. |
| Browser/accessibility | The Chromium workflow and screenshots pass in CI. Accessibility audit, keyboard/focus testing of all dialogs, visual regression and multiple browser engines remain. |
| Branding | Runtime and sign-in configuration exist. Light theme is implemented; dark-logo config is retained but a full dark theme is not implemented. |
| Licensing | Unmodified dependency notices and npm SBOM are included. Mirror the exact MPL source archives and generate container/base-OS SBOMs for each commercial release. Final product/legal packaging still needs review. |

## Suggested next acceptance slice

With native PostgreSQL/container/browser gates, independent WSL2 deployment/recovery, real Keycloak login/logout acceptance, and SCIM Users/Groups lifecycle now passing under `workspace_runtime`/`NOBYPASSRLS`, the next identity work should focus on broader provider compatibility and per-tenant IdP/enterprise policy needs rather than expanding directory authority into privileged roles. Trusted TLS is now CI-verified. For deployments choosing S3-compatible object storage, provider acceptance is a deployment-specific host gate; local-filesystem deployments do not depend on it. The next cross-deployment product hardening priority is operational tenant provisioning, followed by external monitoring/alerts and broader security/accessibility coverage.
