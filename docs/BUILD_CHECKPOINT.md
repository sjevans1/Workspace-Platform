# Build checkpoint

Updated 1 October 2026. Repository: https://github.com/sjevans1/Workspace-Platform

## Scope and authorization

Build the self-hosted OpenJM Workspace first pass from the Astra handoff. The user authorized implementation and GitHub commits/pushes, and requested incremental checkpoints to preserve continuity. Keep working without unnecessary confirmation. This is an executable alpha; see ACCEPTANCE.md for unfinished MVP requirements. Do not use Sites or connect a production Intelligence deployment without its configuration.

## Verified baseline and evidence

Current verified baseline: `main` commit `0faa36338046b37d6c544f8565c735c7ff407212` (PR #51), with complete post-merge CI https://github.com/sjevans1/Workspace-Platform/actions/runs/36841516660 (run #180).

- Backend job passed: 59 native PostgreSQL tests, TypeScript, encrypted S3 acceptance and production build.
- Deployment job passed: Docker image, migrations, full Compose startup and readiness.
- Complete deployed Chromium scenario passed: setup, page creation, canonical server persistence, two independent browser sessions, shared edits, reload, comments, history, Markdown export, table editing, board movement and mobile navigation/layout.
- Desktop and mobile screenshots were inspected. Successful-run screenshots remain in the CI browser-results artifact; precise boundaries are in ACCEPTANCE.md. Automatic approval review blocked committing screenshots to the public repository because they contain workspace/user labels. Do not retry that upload without resolving the approval requirement.
- The earlier mobile test failure was corrected by closing the visible sidebar with its own button before reopening it through the header toggle.

## Fixes already persisted

- BlockNote 0.55 requires `withCollaboration` from `@blocknote/core/yjs`; a plain collaboration option was silently ignored. The editor now uses the adapter. The browser test explicitly verifies API content before starting the second session.
- Collaboration shutdown tracks and disposes idle documents and failed loads, preventing abandoned awareness timers.
- Database shutdown waits for client socket end events after pool shutdown. Test databases are dropped without FORCE.
- Trash traversal skips already-deleted descendants; numeric filters use numeric comparisons; record title limits match resource limits.
- Docker excludes generated Next.js type references and defaults host bindings to loopback. HTTPS instructions include an explicit public bind address.

## Historical verified slice: storage recovery and two-user revocation

The user authorized continuation after the verified first pass. The next increment adds an authenticated SeaweedFS 4.47 service to CI and a recovery test using separate source/recovery PostgreSQL databases and S3 buckets. It covers anonymous and bad-credential rejection, immutable object writes, canonical Yjs and retained-file recovery, checksum/key/schema checks, collision handling and upload-failure rollback. S3 PUT now uses If-None-Match to match local storage’s no-overwrite contract; storage clients are closed on shutdown.

Storage increment published: `d53d363cfa8c0d2d6f17b492bd7a7cbb022ded17`. CI https://github.com/sjevans1/Workspace-Platform/actions/runs/36613650554 passed its backend job: 24 native tests, 0 skipped, including the real SeaweedFS drill, plus TypeScript and production build. The S3 test requires TEST_DATABASE_URL and TEST_S3_ENDPOINT and is skipped locally without them.

The second increment added a distinct invited teammate to deployed-browser acceptance, covering live edits, view-only downgrade, upgrade, full revocation, private files, search, tickets, owner edits after revocation and access restoration. The review found that the server enforced read-only changes but the editor retained its initial editability flag. Collaboration now sends permission updates and the open editor applies them; the backend regression covers both directions. This increment was published at `7a7ce9e2ddbb1783556d569b2810607f0ddfca1a` after the deployed two-user browser verification passed.

## Verified hardening slice: retention and object lifecycle

PR #8 passed the complete CI gate in GitHub Actions run 36660728414 and was squash-merged to `main` at `10e8813b83d6969e7dddaa0f4664ea81a0558515`. The backend job passed native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker image build, migrations/startup/readiness and the complete deployed Chromium workflow.

The verified slice adds a configurable organisation trash-retention period (1–3650 days, or disabled), administrator-only permanent purge, deepest-first subtree removal, preservation of audit/outbox evidence, a tenant-isolated durable object-deletion queue with retry/dead states, cleanup of expired soft-deleted attachments, backup/restore coverage for cleanup state, and regression tests for explicit and automatic purge.

## Verified hardening slice: permission concurrency and audit export

PR #9 passed the complete CI gate in GitHub Actions run 36661773259 and was squash-merged to `main` at `84a7844f61597baa68b7f49fdb79b6f13912bdcc`. The backend job passed 27 native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker image build, migrations/startup/readiness and both deployed Chromium workflows, including distinct-user live permission downgrade, revocation and recovery.

The verified slice adds optimistic ACL revisions and stale-write rejection, serializes access-policy updates under the tenant tree lock, rejects duplicate, cross-tenant and inactive principals, updates the access-management UI to submit revision preconditions, and adds a bounded administrator-only CSV audit export with spreadsheet-formula neutralization. Regression coverage includes simultaneous conflicting ACL saves and requires exactly one success and one HTTP 409 conflict.

## Verified hardening slice: integration OpenAPI contracts

PR #10 passed the complete CI gate in GitHub Actions run 36662255850 and was squash-merged to `main` at `e1b2cbd8174ecb528a9c7af89d8ca0026f5aae3d`. The backend job passed 28 native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker image build, startup/readiness and both deployed Chromium workflows.

The verified slice adds explicit machine-readable OpenAPI request/query/path/response schemas for the core external integration surface: resource listing, canonical page content read/write, permission policy and end-user permission recheck, event polling, import submission and import job status. A regression test inspects the generated `/api/docs/json` contract itself. Remaining human/admin routes still require complete SDK-grade body/response schemas before the API-contract item can be considered fully closed.

## Verified hardening slice: operational service health

PR #11 passed the complete CI gate in GitHub Actions run 36663742897 and was squash-merged to `main` at `cef9cb0a075780799d507b8e4c5e32c10e0bfec6`. The backend job passed 29 native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker configuration/image build, migrations/startup, simultaneous healthy status for API/collaboration/worker, and both deployed Chromium workflows.

The verified slice adds internal health listeners for collaboration and worker processes, collaboration database-writer lease verification, worker tick completion/failure/stuck detection, Docker health checks, Caddy startup dependency on healthy collaboration, an owner/admin tenant operations endpoint for import/event/webhook/object-cleanup backlogs, and CI enforcement that the three core application services are genuinely healthy before browser acceptance starts. The internal health listeners are not routed through Caddy.

## Verified hardening slice: migration integrity and recovery

PR #13 passed the complete CI gate in GitHub Actions run 36665630835 and was squash-merged to `main` at `1cc3575056b120f7a30cd9775d756024ffbdab55`. The backend job passed 30 native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker configuration/image build, healthy service startup and both deployed Chromium workflows.

The migration runner now records SHA-256 checksums for applied migration files, adopts checksums for legacy rows on first post-upgrade run, and rejects later modification of an already-applied migration. A dedicated disposable-database regression proves that a migration which fails after partial DDL is rolled back atomically, is not recorded as applied, can be corrected and retried successfully, remains idempotent on subsequent runs, and then becomes immutable through checksum verification.

## Hermes real-host acceptance package

A bounded independent host-validation procedure is now committed at `docs/HERMES_HOST_ACCEPTANCE.md`. It is intended for Hermes on a disposable WSL/Linux host and covers fresh deployment, browser acceptance, restart persistence, TLS/LAN, migration checksum verification, backup, separate-target recovery and operational queue review. It explicitly forbids destructive testing against the source deployment, production data, unknown Docker volumes or production buckets.

## Independent WSL host acceptance — completed except TLS

Hermes reported a complete real-host acceptance against application commit `b392f4113099788816250b3ee7e3a1d9573f1d9d` on Ubuntu 24.04 / WSL2. Fresh deployment, 2/2 Playwright browser workflows, source restart persistence, idempotent/checksummed migrations, logical backup, isolated recovery and operational status all passed. The recovery target used a separate Compose project, separate volumes and host ports 8081/8444; recovered sign-in/content were verified and the source remained healthy.

The initial recovery startup failure was traced to a host-port collision with the still-running source stack, not a restore-code failure. The corrected isolated recovery completed successfully. Trusted TLS/LAN remains NOT EXECUTED because no trusted test certificate environment was available.

The anonymized outcome record is in `docs/HOST_ACCEPTANCE_EVALUATION.md`. `docs/HERMES_HOST_ACCEPTANCE.md` retains the stricter isolation and restore-order safeguards learned from the exercise.

## Verified hardening slice: OIDC / Keycloak SSO foundation

PR #14 passed the complete final-head CI gate in GitHub Actions run 36770930101 and was squash-merged to `main` at `842ee53bbc17f569d0aaba748d8a15ac517b6955`. The backend job passed 34 native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker configuration/image build, healthy startup and both existing deployed Chromium workflows.

The identity slice adds deployment-level OpenID Connect/Keycloak sign-in using authorization code + PKCE S256, random state, OIDC nonce, browser-bound and server-side single-use login state, signed ID-token validation through `openid-client`, verified-email enforcement, durable issuer/subject identity links, and optional local-password disable. Existing accounts may link by verified email; passwordless new users require an administrator-issued invitation whose email exactly matches the verified IdP email. SSO never invents organisation membership or roles. Durable identity links are backed up; transient login state is not.

CI includes a disposable real OIDC issuer that exercises discovery, confidential-client code exchange, PKCE transmission, signed ID-token verification, nonce validation and verified-email rejection, in addition to application-level tests for account linking, invitation provisioning, browser-state mismatch and replay rejection. Real Keycloak host/browser acceptance has now passed using the bounded WSL procedure in `docs/HERMES_KEYCLOAK_ACCEPTANCE.md`. The remaining identity gap is immediate Workspace-session revocation/offboarding lifecycle after IdP disablement or membership deactivation.

## Verified hardening slice: OIDC back-channel session revocation

PR #15 passed the complete final-head CI gate in GitHub Actions run 36792189577 and was squash-merged to `main` at `bd6b0c4a053a93f9dd060003c44a7adaa95768b2`. The backend job passed 35 native PostgreSQL tests, TypeScript and the production build. The deployment job passed Docker configuration/image build, healthy startup and both deployed Chromium workflows.

The slice adds standards-based OIDC Back-Channel Logout. OIDC-created Workspace sessions now retain issuer/subject/session-ID metadata. The public back-channel endpoint validates signed logout JWTs against the configured provider JWKS, enforces issuer/audience/iat/exp/jti/events plus `sub` or `sid`, rejects `nonce`, returns HTTP 400 for invalid tokens, and makes repeated logout-JTI delivery idempotent. A `sid` logout revokes only the matching OIDC-created Workspace session; a subject-only logout revokes OIDC sessions for that issuer/subject. Unrelated local/password break-glass sessions are preserved.

Workspace administrator membership deactivation already revokes that tenant's active sessions, so the remaining enterprise lifecycle gap is directory-originated offboarding when the external IdP does not emit a back-channel logout event. The next acceptance step is a focused real-Keycloak host exercise configuring the client's Backchannel logout URL and proving an already-active Workspace SSO session is invalidated. The bounded continuation is committed at `docs/HERMES_KEYCLOAK_LOGOUT_ACCEPTANCE.md`.

## Verified defect fix: OIDC logout audit under tenant RLS

The first real-Keycloak back-channel logout host exercise proved that Keycloak 26.7.4 emitted a signed logout token to Workspace, but it also exposed a production-role defect. The original handler revoked the OIDC session and inserted the tenant audit event inside one `systemTransaction()`; under the deployed `workspace_runtime` role, the FORCE-RLS `audit_events` insert failed because `app.tenant_id` was unset. PostgreSQL rolled the transaction back, undoing the session deletion and returning HTTP 500.

Hermes temporarily granted `BYPASSRLS` only in the disposable test database to finish protocol observation. That workaround demonstrated expected Keycloak emission, old-session rejection, break-glass preservation and fresh-login recovery, but it is not accepted as production evidence and must not be used in a customer deployment.

PR #16 fixes the handler without weakening RLS. Before each affected tenant's audit insert, the existing system transaction now sets transaction-local `app.tenant_id`; session revocation and audit insertion remain atomic. Native integration was also hardened so the application runs as the same `workspace_runtime` role used in Docker, and explicitly proves `rolbypassrls=false`.

PR #16 passed final-head GitHub Actions run 36797135204 and was squash-merged to `main` at `8965a7dfab6dce3c39d66332cd71aee2f8ad993a`. The backend passed 36/36 native PostgreSQL tests, TypeScript and production build. Docker startup/health and the deployed Chromium workflow also passed.

The no-workaround regression retest has now passed on Workspace `9894b95686c6229a956b93c0a2263e4434aae184` with Keycloak 26.7.4. `workspace_runtime` was `rolsuper=false, rolbypassrls=false` before and after the test. Keycloak admin session termination returned HTTP 204 and emitted two fresh back-channel logout tokens for the two active member sessions; Workspace created two fresh `auth.oidc_backchannel_logout` audit events, recorded the logout JTIs, deleted all matching OIDC sessions, rejected the old Workspace session with HTTP 401, preserved the independent local break-glass owner session at HTTP 200, and allowed a fresh SSO login while the old session remained invalid. No HTTP 500, RLS violation, audit insertion error or service restart loop occurred. Real-Keycloak back-channel logout acceptance is therefore closed.

## Independent Keycloak host acceptance — passed

Hermes reported complete real-provider acceptance against Workspace `1702779fa5d31a8de159ee6d476e451d90e316f3` using `quay.io/keycloak/keycloak:26.7.4` on the isolated WSL2 `openjm_workspace_sso` project. OIDC discovery used `http://keycloak.localhost:18081/realms/openjm-test` because local port 18080 was occupied.

The host exercise passed existing-owner SSO linking without duplicate accounts, repeat issuer/subject login, administrator-invited passwordless member provisioning, mismatched-invitation rejection, SSO-only mode with local password login disabled, disabled-Keycloak-user rejection for new authentication, and operational health/log review. All Workspace services remained healthy with no restart loops or OIDC errors.

The earlier Keycloak exercise confirmed that disabling a user prevents new IdP login but does not itself terminate the existing IdP session or emit back-channel logout. The final no-workaround regression retest on `9894b95686c6229a956b93c0a2263e4434aae184` proved explicit Keycloak session termination propagates correctly while `workspace_runtime` remains `NOBYPASSRLS`; the RLS defect is closed. Directory disable/offboarding without a logout event remains a separate SCIM/lifecycle concern.

## Verified hardening slice: SCIM 2.0 Users lifecycle and automated offboarding

PR #17 passed the complete final-head CI gate in GitHub Actions run 36801538725 and was squash-merged to `main` at `ad8f6ed2e954b78959c1941cb0efb4535a6efb26`. The backend passed 37/37 native PostgreSQL tests under restricted `workspace_runtime`/`NOBYPASSRLS`, TypeScript and the production build. The deployment job passed image/configuration/startup and all three Chromium workflows, including the new Settings-driven SCIM connector issuance/revocation test.

The slice adds tenant-scoped SCIM 2.0 Users lifecycle: connector discovery/authentication, ServiceProviderConfig/ResourceTypes/Schemas, Users list/get/create/PUT/PATCH/delete, `userName eq` and `externalId eq` filters, inactive-by-default provisioning, tenant-scoped SCIM profile metadata, audit events and logical-backup preservation. SCIM connectors can provision only `member` or `guest`; manually managed existing memberships are not silently adopted into SCIM.

The security-critical offboarding rule is verified: `active:false` or SCIM DELETE deactivates the connector tenant membership and immediately deletes that tenant's Workspace sessions. A regression creates the same global user in a second tenant and proves that second membership/session remains active.

Two issues were found and fixed before merge. First, SCIM handlers initially called Fastify `reply.send()` inside the tenant transaction, allowing the response to race ahead of COMMIT; SCIM now returns payloads only after the tenant transaction resolves. Second, the deployed Caddy configuration initially did not route `/scim/*` to the API; the new Chromium connector test caught this and the reverse-proxy route is now explicit.

Administrators can manage connectors in Settings → Integrations → Directory provisioning (SCIM 2.0), choose a default member/guest role, copy the one-time token/base URL and revoke the connector. The deployed browser test proves a newly issued token can call SCIM discovery through Caddy and returns HTTP 401 after UI revocation.

The next enterprise identity slice is SCIM Groups and an explicit group-to-Workspace-role mapping policy. Owner/admin provisioning remains deliberately outside SCIM connector authority in the current slice.

## Verified hardening slice: SCIM Groups and explicit role mapping

PR #18 extends the verified SCIM Users lifecycle with SCIM 2.0 Groups, same-tenant SCIM User membership synchronization and an explicit Workspace-admin mapping layer. Directory Groups do not grant access merely by existing. Owners/admins may map a synchronized Group only to `member` or `guest`; SCIM still cannot create `owner` or `admin` authority, and manual Workspace memberships cannot be inserted into SCIM Groups.

Role resolution is deterministic: any mapped `member` Group wins over mapped `guest`; otherwise a mapped `guest` applies; with no mapped Group the User returns to the connector-provisioned base role. Group membership changes never activate/deactivate the membership. User `active:false` / DELETE remains the separate offboarding control.

During review, two defects in the interrupted branch were corrected before acceptance: Group list filters/pagination were missing PostgreSQL parameter markers, and the first role reconciler could not let an explicit guest mapping override a member base role. Regression coverage now exercises Group discovery/CRUD/filtering, rejection of manual users as Group members, guest/member precedence, restoration of the provisioned base role, preserved active state, logical backup/recovery of Groups/members/mappings, and the Settings role-mapping control through deployed Chromium.

PR #18 passed final-head GitHub Actions run 36807221040 and was squash-merged to `main` at `ab5abd5be176a4658bc40cc7fce561cc689cc637`. The backend passed 37/37 native PostgreSQL tests under restricted `workspace_runtime`/`NOBYPASSRLS`, TypeScript and the production build. The deployment job passed configuration/image build, startup/health and deployed Chromium, including the Settings-driven Group role-mapping workflow.

## Verified hardening slice: trusted TLS / customer-like edge deployment

The next production-hardening slice is running the existing Docker/Caddy deployment on a real HTTPS origin rather than introducing a parallel test proxy. Public-domain deployments continue to use Caddy automatic HTTPS. Private/LAN deployments can set `CADDY_TLS_DIRECTIVE=tls internal`, persist Caddy state and distribute only the generated root certificate through normal device trust.

CI now re-runs the deployed stack on `https://workspace.test` with Caddy's internal CA, installs that CA into the runner/browser trust stores without disabling certificate verification, and verifies HTTPS readiness, HTTP→HTTPS redirect, HSTS, a Secure/HttpOnly SameSite=Lax Workspace session cookie, no browser HTTP requests and WSS collaboration. PR #19 passed final-head GitHub Actions run 36809176797 and was squash-merged to `main` at `b3a258164a516c1a2cbc849002300a4b95da2431`. Native PostgreSQL, TypeScript/build, ordinary Docker/Chromium acceptance and the trusted-HTTPS browser gate all passed.

## Verified tooling slice: production S3/object-store provider acceptance

Trusted TLS is closed. The next production gate is validating Workspace against the actual S3-compatible provider selected for deployment.

The new `scripts/accept-production-s3.ts` harness uses two pre-created dedicated buckets and disposable PostgreSQL databases. It never creates or deletes buckets, writes only randomized Workspace-format keys, requires an explicit write-confirmation flag, verifies conditional immutable PUT, backup, collision-safe restore refusal, canonical Yjs recovery, active/deleted attachment recovery and source preservation, then cleans only generated keys. CI runs the same harness against disposable SeaweedFS buckets so the harness itself is continuously verified.

PR #21 passed final-head GitHub Actions run 36809767605 and was squash-merged to `main` at `c4b86d8c326fea9aee7d087af88faab076bb46a5`. The harness itself is verified in CI. The **selected production provider is not yet accepted**; that operational gate remains open until `docs/PRODUCTION_S3_ACCEPTANCE.md` passes against two dedicated buckets on that provider.

## Storage deployment policy clarification

Workspace supports two production storage classes rather than requiring cloud object storage. The default local filesystem adapter is a valid self-contained/on-prem deployment mode; its attachment data remains on the Workspace host or attached storage and therefore has no external-provider S3 acceptance requirement. S3-compatible storage is an optional deployment mode for private object stores or cloud providers. When S3 is selected, the existing provider-safe recovery harness remains a mandatory provider-specific acceptance gate.

This clarification changes the release checklist, not the storage implementation. The next cross-deployment hardening priority is operational tenant provisioning rather than waiting on a particular cloud-storage account.

## Verified hardening slice: operational tenant provisioning

Production tenant onboarding is being moved away from ad-hoc database work and universal self-service. The new operator command atomically creates an organisation, owner membership, root workspace and `tenant.provisioned` audit event. New owners may use a local password supplied only through the process environment or a passwordless SSO mode for verified-email OIDC deployments. Existing global users are refused unless the operator explicitly chooses `--allow-existing-user`; their existing credentials are preserved.

Signed-in owner/admin self-service organisation creation is now deployment-controlled and defaults off through `ALLOW_SELF_SERVICE_ORGANISATIONS=false`. The API rejects creation with HTTP 403 and the UI hides the control unless the deployment explicitly enables it. Regression coverage includes the default-off API boundary plus atomic provisioning, duplicate rejection, conservative user reuse and passwordless ownership. PR #25 passed final-head GitHub Actions run 36811758844 and was squash-merged to `main` at `4a6aa6fc2623561029a21e910d9d2895dc224c52`. The backend passed 39/39 native PostgreSQL tests, including the operator provisioning lifecycle regression, plus TypeScript and production build. The deployment job passed Docker startup, the deployed Chromium workflow and trusted HTTPS/secure-cookie/WSS acceptance.

## Verified hardening slice: external monitoring and alerts

Workspace now has an authenticated Prometheus-compatible `/metrics` endpoint backed by the existing API readiness, worker-health and collaboration-writer signals rather than a parallel health system. The endpoint returns HTTP 404 when no metrics credential is configured and HTTP 401 for a missing/incorrect bearer token. Docker deployments generate a strong `METRICS_BEARER_TOKEN`; the API reaches worker/collaboration health only over the private Compose network.

Telemetry is intentionally low-cardinality and content-free: dependency/service health, bounded HTTP method + status-class counters, worker failure/staleness indicators, and collaboration connection/document counts. Tenant IDs, user IDs, resource/document IDs, route paths and customer content are not metrics labels. Reference Prometheus scrape configuration and alert rules cover target outage, dependency outage, internal service health, worker failures/staleness and sustained 5xx rate.

Regression coverage exercises metrics rendering and live bearer authentication. CI deployment acceptance now scrapes through Caddy, confirms healthy dependency/service gauges and rejects identifier leakage. PR #26 passed final-head GitHub Actions run 36812647394 and was squash-merged to `main` at `121a37703bf265b94949b310158a97419a46e814`. The backend passed 41/41 native PostgreSQL tests, including metrics authentication and low-cardinality output regressions, plus TypeScript/build and the S3 harness. The deployment job passed authenticated `/metrics` scraping through Caddy, the normal Chromium workflow and trusted HTTPS/secure-cookie/WSS acceptance.

## Verified hardening slice: adversarial security coverage

The current security slice targets residual cross-boundary attack paths rather than reworking controls already proven by RLS/SSO/SCIM/TLS acceptance. Invitation URLs are captured into in-memory UI state and immediately scrubbed from the address bar; the edge now uses `Referrer-Policy: no-referrer` plus same-origin opener/resource policies and `form-action 'self'` in CSP. Invitation tokens are deliberately not persisted in browser storage.

Attachment adversarial tests now reject active/unsupported extensions, invalid image/PDF signatures and MIME confusion, while private download tests verify nosniff, sandbox CSP and attachment disposition. The webhook regression now proves an allowlisted endpoint returning HTTP 302 cannot redirect delivery to an unallowlisted second target.

PR #27 passed final-head GitHub Actions run 36813254755 and was squash-merged to `main` at `bf3b8184a4454f048223dc6131d20c57e8ba3741`. Backend passed 42/42 native PostgreSQL tests, including webhook redirect and malicious-attachment regressions. Deployment passed the invitation URL scrub in the full Chromium workflow and the hardened TLS/security-header gate. Malware scanning/CDR, nonce/hash CSP, release-image vulnerability scanning and customer-specific penetration testing remain separate production-hardening work.

## Verified hardening slice: browser and accessibility coverage

Workspace's shared `Modal` primitive now manages keyboard focus centrally: initial focus moves into the dialog, Tab/Shift+Tab are trapped, Escape closes, and focus returns to the trigger on unmount. This applies to all application dialogs because there is only one dialog implementation in the web application.

A focused browser acceptance checks visible controls for accessible names, images for alt attributes, duplicate IDs and modal semantics, then proves focus trapping/restoration through real keyboard interaction. The existing full Chromium workflow remains unchanged; the new focused compatibility matrix runs the deployed application in both Chromium and Firefox.

PR #29 passed final-head GitHub Actions run 36814890004 and was squash-merged to `main` at `d4f58ea07202bbc32c929c3d208a81a5809eec91`. Backend passed 42/42 native PostgreSQL tests, TypeScript/build and the S3 harness. Deployment passed the full Chromium workflow, the focused Chromium + Firefox keyboard/semantic accessibility matrix, and trusted HTTPS/secure-cookie/WSS. WebKit/Safari coverage, full WCAG/screen-reader review and deterministic visual regression remain separate follow-on work. WebKit/Safari coverage, full WCAG/screen-reader review and deterministic visual regression remain separate follow-on work.

## Verified hardening slice: release image security and container SBOM

The exact `openjm-workspace:local` image built by the deployment job now receives a CycloneDX container SBOM and a vulnerability gate before the stack is started. The SBOM uses Anchore's action pinned to the immutable commit for v0.24.2. The vulnerability gate uses Trivy Action v0.36.0 pinned to its immutable commit and fails on fixable HIGH/CRITICAL OS or library findings; unfixed findings do not block CI but remain subject to release risk review.

This design deliberately scans the same image later exercised by Docker/Chromium rather than scanning only source files or a separately rebuilt artifact. The first final-head run will determine whether the current runtime image needs dependency/base-image remediation or development-dependency pruning. Do not add blanket vulnerability suppressions to make the gate pass.

PR #30 passed final-head GitHub Actions run 36815628321 and was squash-merged to `main` at `f3ac59164f82d7736f391e18f2e924c91fda4603`. The final image is explicitly verified to exclude npm/npx, Playwright and the TypeScript compiler; a CycloneDX container SBOM is generated; Trivy reports no blocking fixable HIGH/CRITICAL OS/library findings; and all backend, deployment, Chromium, Chromium+Firefox accessibility and trusted-TLS gates remain green.

## Verified hardening slice: encryption at rest

Workspace now encrypts attachment/object bytes before they reach either local filesystem storage or an S3-compatible provider. The envelope uses AES-256-GCM with a random nonce, a storage-specific HKDF-derived key and the immutable object key as authenticated additional data. New generated deployments use `STORAGE_ENCRYPTION_MODE=required`; existing deployments without the setting enter a bounded `legacy-read` upgrade state where new writes are encrypted while old plaintext objects remain readable only until migration.

The maintenance migration writes encrypted replacements under new immutable keys, atomically repoints file metadata and queues the old plaintext keys for durable deletion using the existing object-deletion mechanism. It is resumable and idempotent. Logical backup files are now written as AES-256-GCM encrypted envelopes derived from the deployment key; legacy plaintext backup archives require an explicit one-time restore opt-in.

Regression coverage includes authenticated object encryption/key binding, real local-filesystem ciphertext verification, wrong-key failure, backup-envelope secrecy/wrong-key rejection, full plaintext-object migration lifecycle/idempotence, S3 recovery with required encryption, and raw-provider ciphertext assertions. PostgreSQL/WAL encryption remains a host/provider deployment control because whole-database field encryption would break RLS/search/query semantics.

PR #32 passed final-head GitHub Actions run `36819278521` and was squash-merged to `main` at `ab9d9fd8cdfded1c558aadc5360bb97ce9081063`. Backend passed 45/45 native PostgreSQL tests plus encrypted S3 acceptance and production build. Deployment passed the production-only runtime check, container SBOM, Trivy HIGH/CRITICAL gate, live Chromium workflow, raw local-volume ciphertext verification, Chromium + Firefox keyboard/semantic acceptance, and trusted HTTPS/secure-cookie/WSS. Legacy plaintext backup restore requires explicit one-time opt-in. This slice is closed.


## Verified maintenance slice: repository rebaseline and dependency hygiene

PR #33 passed final-head GitHub Actions run `36820782634` and was squash-merged to `main` at `fc67e3bcbff08cfcab65ba0b288a3bb9386418e7`. The full backend and deployment acceptance remained green, including 45 native PostgreSQL tests, encrypted S3 acceptance, production-only runtime verification, container SBOM, Trivy, live Chromium workflow, raw local-volume ciphertext, Chromium + Firefox accessibility and trusted TLS.

Acceptance/checkpoint documentation now reflects the verified encryption-at-rest baseline. Routine Dependabot version updates are monthly and grouped by ecosystem for minor/patch releases; major upgrades remain deliberate engineering slices, while security updates remain independent. Repository workflow is one active engineering branch/PR at a time: merge after final-head acceptance, update the checkpoint, delete the merged branch, then create the next branch.

## Verified hardening slice: file malware scanning and reject-before-publish

The file upload path now performs structural/MIME validation and then streams bytes to a required ClamAV daemon before encrypted storage or database publication. The custom client uses bounded NUL-framed `PING`/`INSTREAM` commands. CLEAN files continue normally. Infected files return HTTP 422, create no object/file row, and commit a `file.malware_blocked` audit/outbox event. Scanner unavailability, timeout or malformed responses fail closed with HTTP 503 and no stored object.

Docker builds a hardened ClamAV runtime from the official 1.5.4 Debian slim image, applying Debian security package upgrades. The runtime has a persistent and refreshable signature database volume, no host-published scanner port, and API startup/readiness depends on scanner health. Local development explicitly disables antivirus; the production runtime refuses disabled mode. CI adds protocol regressions, infected/unavailable upload regressions, live clean/EICAR scanning, antivirus readiness metrics, the existing real browser clean-upload path, and scanner-image CycloneDX SBOM plus Trivy HIGH/CRITICAL gating.

This slice deliberately implements reject-before-publish rather than a retained quarantine vault. Sandbox detonation, CDR, retroactive rescanning and false-positive release workflows remain separate future controls. PR #35 passed final-head GitHub Actions run `36823852010` and was squash-merged at `1994cc1f1f749a905bd87d07fe067996cc4b3543`: 49/49 backend tests, S3 acceptance, image/SBOM/Trivy gates for Workspace and hardened ClamAV, live EICAR/clean scanning, application EICAR rejection and metrics, clean browser upload, raw attachment ciphertext, Chromium + Firefox accessibility, and trusted HTTPS/WSS. This slice is closed.

## Verified engineering slice: OIDC provider interoperability

From the verified PR #35 / Actions run `36823852010` malware-scanning baseline, branch `hardening/oidc-provider-compatibility` adds explicit token endpoint authentication method configuration: `client_secret_basic` (backward-compatible confidential default), `client_secret_post` (confidential alternate) and `none` (public PKCE). Configuration rejects client-secret/method mismatches and disallowed methods; advertised provider metadata must support the configured choice. The disposable OIDC issuer tests the actual authorization-code exchange, PKCE, nonce, verified email and methods, including rejection paths. Deployment environment/Compose and IDENTITY documentation are updated. PR #36 passed final-head Actions run `36827473659`: 49/49 native PostgreSQL tests, real OIDC provider-method exchanges, encrypted S3 acceptance, production build, application and hardened ClamAV SBOM/Trivy, live deployment/EICAR, full Chromium browser, local ciphertext, Chromium + Firefox accessibility and trusted HTTPS/WSS. It was squash-merged at `12ab73d333243a1ac3068bac6f1560d632b8afd3`. Per-tenant issuer configuration and managed IdP secrets remain a separate follow-on engineering gate.

## Move On continuation — verified merged features

The post-merge `main` run #180 passed backend (59 native PostgreSQL tests, 0 skipped), encrypted S3 recovery, production build, Docker startup, Workspace/ClamAV SBOM and Trivy gates, EICAR scanning, deployed Chromium workflows, raw attachment ciphertext, Chromium/Firefox keyboard accessibility, and trusted HTTPS/secure cookies/WSS.

- Tenant identity-provider factory, encrypted disabled-only registry and administrative Settings UI are merged (#37, #39, #46). T3a binds prospective login states to an exact tenant/provider/revision/issuer/client (#41). Deployment-issuer sessions cannot downgrade to local sessions through organisation switching (#40). Provider-ID session provenance and active tenant login/logout remain gated in TENANT_OIDC_DESIGN.md.
- Permission-filtered, tenant/principal-bound resumable event cursors are merged (#43), preserving PostgreSQL microsecond order. Current-state reconciliation remains an integration follow-on.
- Monthly saved calendar views and persistent date changes are merged (#44), with date-property validation and server-side month boundaries.
- Keyboard search with ARIA combobox semantics, focus handling and Chromium/Firefox coverage is merged (#45).
- Tenant-safe audited dead-delivery replay API and Settings UI are merged (#48, #51).
- Transient authenticated startup failures preserve sessions and offer a bounded Retry-After recovery path (#49). Shared-IP browser acceptance now waits for the real rate-limit budget; production rate limits remain enabled. Both #49 and #51 passed post-merge `main` acceptance.

The user requested independent sections progress in parallel. Keep isolated local work separate, publish one active integration PR, and require the exact final head's full CI before merge. Continue frequent user updates. Do not publish private browser screenshots into this public repository.

## Verified engineering slice: staged webhook signing-secret rotation

PR #52 staged signing-secret rotation is **merged** to `main` at `3a47401054a7808a2a5b112a8b9edee50d77696d`, after final-head GitHub Actions run `36844169470` passed both backend and deployment jobs. An administrator can prepare an encrypted one-time secret without changing active signatures, then explicitly activate or discard it. Revision preconditions reject stale/concurrent changes. The worker holds a subscription read lock through send/commit so activation cannot interleave with an in-flight delivery. Acceptance covers authorization/tenant boundaries, CSRF, service-token rejection, old/new signing and replay, audit, encrypted backup recovery, deployed Settings UI and native PostgreSQL concurrency. This slice is closed.

## Move On continuity gate — October 1, 2026

- PRs #49 (startup/session recovery) and #51 (webhook delivery replay UI) were merged with native PostgreSQL and deployed browser acceptance; PR #52 rotation followed with the same backend/deployment gate.
- Monthly dependency maintenance PR #53 changes only `package.json`/`package-lock.json`, updating `y-protocols` 1.0.6 → 1.0.7 and `prettier` 3.6.2 → 3.9.9, plus npm lockfile reordering. Its exact head `28843484d8f9e848448fcbd99911e93db2d5e218` passed both CI jobs (GitHub Actions run `36858049083`) and was squash-merged at `1fe47687957b83c9325d71725a5985ecd7f86563`.
- **Verification boundary:** PR-head CI acceptance is verified for #53; this checkpoint does not claim its post-merge `main` push run was inspected. Confirm a completed successful `main` run before reopening feature development. Do not relax production rate limits just to make tests pass; use real browser acceptance and inspect recurring 429s separately from application regressions.
- Keep new functional features paused until the verified `main` baseline is stable. Use one active integration PR, require final-head full CI before merge, and delete merged engineering branches after validation. Do not expose private screenshots or secrets in this public repo.

## First-pass completion and future work

This first-pass build and verification are complete. The runtime is an alpha, not the full production MVP. No customer host or production Intelligence deployment has been configured. Use README.md and OPERATIONS.md to run it locally or deploy it on a selected host.

SCIM Groups/group-role mapping, trusted TLS, operational tenant provisioning, external monitoring, adversarial security coverage, Chromium + Firefox accessibility, release-image security and encryption at rest are closed and verified. For deployments selecting S3-compatible storage, provider acceptance remains a deployment-specific host gate; local-filesystem deployments do not depend on it. File malware scanning/reject-before-publish is closed and verified. Broader identity/provider compatibility is the next engineering program. Follow ACCEPTANCE.md for the remaining identity/provider, offline/scale, product-depth, integration and release-candidate work.

## Continuity and execution notes

All durable source belongs in this GitHub repository. Commit tested increments and update this checkpoint before any pause. Keep one active engineering branch/PR at a time: merge only after final-head acceptance, update the checkpoint on `main`, delete the merged branch, then create the next branch. Routine Dependabot version maintenance is grouped monthly by ecosystem; major upgrades remain deliberate engineering slices. Do not depend on temporary local files or conversational tool stores. Local Chromium cannot launch in the managed execution environment; use GitHub Actions for browser and Docker verification. Local tests use PGlite; CI uses native PostgreSQL. Run shell commands with bash and login disabled. Git fetch works, but authenticated publication uses the GitHub connector tree/commit/ref tools; preserve local edits when aligning with the published head. Never reset hard.

## Standalone 1.0 progress — W01, W05, W06, W07 accepted; W08 under development

- W01 rate-limit identity and trusted Caddy hop: PR #64 merged `e99a89e56eb0b05324ae42fe57be28fc4ab58853`, after Actions run `36937020870` passed. IPv6 /64 normalization and authenticated principal isolation retain sensitive per-IP route caps.
- W05 permission-safe one-way Relations: PR #65 merged `c124aae8dfb5059c7f090b7816ab094ac0093f35`, after Actions run `36938392243` passed backend and deployment. The current implementation permits up to 20 unique linked records; permission filtering applies to lists, read/export, and candidate pickers. A more scalable indexed implementation remains W08.
- W06 safe numeric Formula properties: PR #66 merged `925d891771ae09eff9d4aa345c9b4ff632dff591` after exact-head Actions run `36941994555` passed 75/75 native backend tests and full deployment/browser/HTTPS gates. Formula expressions remain strictly same-record arithmetic, without arbitrary execution or relation traversal.
- W07 permission-safe Relation Rollups: PR #69 merged `9070518b493a3224c56041e5da190ab5bbc2d48f` after exact-head Actions run `36942830305` passed 78/78 native backend tests and full deployment, browser, accessibility and HTTPS checks. [Rollup semantics](ROLLUPS.md) remain bounded by 20 readable links and access rechecking.
- W08 accessible-first database pagination: **draft PR #70, not yet accepted or merged**; preserve `feature/w08-visible-page-regression-prep` through repo cleanup. Track [Issue #68](https://github.com/sjevans1/Workspace-Platform/issues/68) and [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62).
- [W06 formula contract](FORMULAS.md) documents grammar and limitations. No required OpenJM Enterprise AI integration or changes.
