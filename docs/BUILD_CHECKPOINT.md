# Build checkpoint

Updated 30 September 2026. Repository: https://github.com/sjevans1/Workspace-Platform

## Scope and authorization

Build the self-hosted OpenJM Workspace first pass from the Astra handoff. The user authorized implementation and GitHub commits/pushes, and requested incremental checkpoints to preserve continuity. Keep working without unnecessary confirmation. This is an executable alpha; see ACCEPTANCE.md for unfinished MVP requirements. Do not use Sites or connect a production Intelligence deployment without its configuration.

## Verified baseline and evidence

Runtime and tests: `e10d5676795f94a13a831989be3ace1e4b2c76fe`.
Successful CI: https://github.com/sjevans1/Workspace-Platform/actions/runs/36611129995

- Backend job passed: 23 native PostgreSQL tests, TypeScript and production build.
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

## Active next slice: storage recovery and two-user revocation

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

## First-pass completion and future work

This first-pass build and verification are complete. The runtime is an alpha, not the full production MVP. No customer host or production Intelligence deployment has been configured. Use README.md and OPERATIONS.md to run it locally or deploy it on a selected host.

The next acceptance phase is a customer-like evaluation on a TLS-enabled host, including live permission revocation, object-store backup recovery and host-level migration/recovery execution. Follow the explicit remaining-work table in ACCEPTANCE.md; identity/SSO, operational tenant-provisioning, external metrics/alerts and real host/TLS recovery validation, broader adversarial security coverage, and wider browser/accessibility coverage remain.

## Continuity and execution notes

All durable source belongs in this GitHub repository. Commit tested increments and update this checkpoint before any pause. Do not depend on temporary local files or conversational tool stores. Local Chromium cannot launch in the managed execution environment; use GitHub Actions for browser and Docker verification. Local tests use PGlite; CI uses native PostgreSQL. Run shell commands with bash and login disabled. Git fetch works, but authenticated publication uses the GitHub connector tree/commit/ref tools; preserve local edits when aligning with the published head. Never reset hard.
