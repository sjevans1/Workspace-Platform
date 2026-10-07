# OpenJM Workspace — Standalone 1.0 delivery roadmap

**Current execution baseline:** 2026-10-06, `main` after merged W17 PR #158 (`6b7f60f422723ec19e8a5006f3033ab082d7e8b9`).  
**Persistent tracker:** [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62).  
**Bundled execution plan:** [DELIVERY_WAVES_1_0.md](DELIVERY_WAVES_1_0.md).  
**Status:** Living delivery specification; accepted packages are recorded below and in Issue #62; **no unbuilt feature is claimed implemented**. `W##` identifiers below are *planned work packages*, **not assigned GitHub PR numbers**. When implemented, replace each tracker checkbox with a link to the real PR and its accepted CI run.

## 1. What "complete" means

**Scope is a commercially deployable, self-hosted/white-label Workspace 1.0**, not unlimited one-to-one Notion/AppFlowy feature parity. A customer can install, brand, administer and recover it without OpenJM Enterprise AI, any LLM, a paid editor, an external S3 provider or any SaaS account. For a single-node supported deployment, a user can compose/collaborate on pages; organize spaces, references, comments and searchable content; manage databases with table, board, calendar, relations, formula/rollup basics; import/export data; share securely; and operate/recover the installation with validated boundaries. There is a documented support/deployment matrix, pilot sign-off and 1.0 release artifact.

**Mandatory isolation:** Workspace remains its own repository, containers/processes, PostgreSQL database, storage, credentials, authorization and deployment. Do not modify `OpenJM-Enterprise-AI`; no mandatory dependencies on it. An optional, off-by-default integration may consume Workspace's versioned permission-aware APIs/events, with revocation and reconciliation, but AI outages may not affect normal Workspace use.

**Not 1.0 blockers unless a release review explicitly changes scope:** full offline-first multi-device sync, horizontally scaled multi-writer Yjs, enterprise SAML/SCIM variants beyond implemented baseline, arbitrary workflow automation, retained malware quarantine/CDR, every Notion block/view type, sophisticated per-customer customizations, a native mobile app, or an operational live OpenJM Intelligence connection. See section 8.

## 2. Verified starting point — do not rebuild

In `main`: independent local/Compose install; PostgreSQL tenant RLS, ACLs and sessions; SCIM Users/Groups; deployment OIDC and Keycloak logout; *disabled* tenant IdP registry and T3a state schema; encrypted local/S3 files and encrypted logical backup; mandatory malware inspection; durable Yjs edits and revision history; pages/spaces; per-user Recently Viewed (#59); light/dark/system appearance; table, board, **monthly calendar** and typed database basics; API/audit/webhook/event cursors and staged signing-secret rotation; monitored services; internal page links and ACL-filtered backlinks (#61); Chromium/Firefox keyboard acceptance and trusted TLS/WSS. The current code is an **alpha** and release hardening is unfinished. Inspect [ACCEPTANCE](ACCEPTANCE.md), [BUILD_CHECKPOINT](BUILD_CHECKPOINT.md), [TENANT_OIDC_DESIGN](TENANT_OIDC_DESIGN.md) for detailed evidence and limitations. Some older documents contain historical test counts/limitations; verify against exact current SHA rather than quoting an outdated count.

Existing open issues mapped into this roadmap: [#38 tenant SSO](https://github.com/sjevans1/Workspace-Platform/issues/38), [#50 rate limits](https://github.com/sjevans1/Workspace-Platform/issues/50), [#60 relations](https://github.com/sjevans1/Workspace-Platform/issues/60).

## 3. Delivery stages and proposed PR register

Read **ID / order / dependencies** as a planning sequence, not a promise of exact PR count or release date. Every PR must implement a demonstrated user/operator outcome, tests and documentation; split unusually large items if necessary while preserving the stable W-ID.

### Stage A — identity and security baseline (P0; release blockers)

| ID | Planned PR: observable outcome | Prerequisites | Minimum acceptance beyond common CI |
|---|---|---|---|
| **W01** | **Trusted proxy and rate-limit identity** (#50). Correct Caddy → Fastify client attribution and authenticated tenant/principal budgets without loosening unauthenticated sensitive routes. | None | Direct/proxied/NAT scenarios; spoofed XFF never evades policy; independent legitimate users cannot starve one another unintentionally; login/OIDC/SCIM remain tightly limited. |
| **W02** | **Tenant IdP login activation** (#38, T3b). Enable owner-approved, explicit tenant/provider sign-in using existing registry/T3a; exact state/issuer/client/revision binding and SSRF-safe allowlisted discovery. | Tenant IdP T2/T3a verified; W01 prudent but not code-required | Two issuers, overlapping emails, invite tenant isolation, mismatched/replayed callbacks and changed/revoked provider failures; legacy deployment OIDC intact. |
| **W03** | **Tenant IdP session provenance and logout** (#38, T4/T5). Persist immutable tenant/provider attribution; per-provider signed logout and scoped session revocation; deny issuer downgrade/tenant switching. | W02 | Real/disposable Keycloak two-tenant logout, hostile logout JWT/replay, SCIM offboarding, local break-glass and unrelated tenants unaffected; recovery/backup tested. |
| **W04** | **Safe account-recovery and invitations**. Rate-limited, expiring, one-time user password recovery and optional SMTP invites, plus tested admin-assisted recovery for air-gapped installs. | W01; identity constraints W03 | No enumeration/token leakage, hashing/revocation/audit, CSRF, multiple tenants and fail-closed mail errors; SMTP disabled must remain a fully functional standalone install. |

### Stage B — complete the authoring and database experience (P0/P1)

| ID | Planned PR: observable outcome | Prerequisites | Minimum acceptance beyond common CI |
|---|---|---|---|
| **W05** | **Relation property** (#60): configure target database, search allowed records, attach/detach, navigate, persist and export references. | #59/#61 already merged | Read-time/write-time ACL & tenant checks; revoked/deleted/moved target redaction from every surface; schema migration, optimistic revision and keyboard/mobile browser journey. |
| **W06** | **Safe formula fields** with typed expressions, deterministic null/error handling and explicit supported operators. | W05 optional; existing typed schema | No `eval` or arbitrary execution; cycle/time/size caps; stable recomputation, permissions for referenced fields, tests on edits/imports/restore. |
| **W07** | **Rollup fields** through same-tenant Relations with bounded aggregations and documented supported types. | W05, W06 (if formula-aware) | No related-row ACL leakage in count/aggregates; delete/revoke updates; cycle/performance controls; consistent table/board/calendar views and export. |
| **W08** | **Reliable larger-database browsing**: server-side cursor pagination, cross-view filtering/sorting, accessible record search and explicit result limits. | W05 | Thousands of records under RLS; deterministic ordering, no silent 200-row truncation, zero unauthorized data in selectors/CSV/API, performance benchmark. |
| **W09** | **CSV import mapping/validation wizard**: target schema preview, typed error report, dedupe strategy and resumable/bounded batch behavior. | W08 | Mixed-type and adversarial rows; upload/batch limit boundaries, rollback/failure recovery, import preview and large-export safe fallback. |
| **W10** | **Editor coverage**: callout/divider and clear formatting controls; complete tested BlockNote Core block matrix for paste, serialization and collaborative persistence. | None | Two-user editing and reload of all advertised blocks; accessible keyboard/touch, undo/redo, imports/exports; no paid editor feature assumptions. |
| **W11** | **Block-anchored discussions and mentions** with resilient anchor movement/deletion and visibility checks. | W10 | ACL revocation hides comments and mention suggestions; consistent anchors after Yjs edits/restore; two-user accessible browser demonstration. |
| **W12** | **In-app notification center** for mentions/replies/invites with read/unread and per-user preferences; optional external email delivery. | W11, W04 for mail | Tenant/user isolation, inaccessible-resource redaction, dedupe and mute, mail-off environment works; relevant browser acceptance. |
| **W13** | **Indexed links/backlinks** replacing the 300-candidate/40-result scan, including backfill/rebuild and access-time filtering. | #61 | Link create/remove/restore/rename in collaborative docs; no stale ACL leakage; paginated results; migration/repair and scale acceptance. |
| **W14** | **Permission-safe indexed search** over pages, records and discoverable titles/bodies with ranking/filter UX. | W13 index foundations helpful | Fresh writes, revoke/trash visibility, cross-tenant testing, pagination and benchmark; no unauthorized snippet, metadata or counts. |
| **W15** | **Productized templates and duplication**: page/database/space templates, safe duplication, guided first-use and sample content. | W05–W10 stable schemas | Clone respects tenant and ACL boundaries, remaps internal links/relations or explicitly reports limitations, pristine install demo. |
| **W16** | **Mobile, navigation and keyboard finishing pass**: responsive editor/database/calendar, discoverable interactions, empty/error/loading states. | W05–W15 UI stable | 390px phone and tablet; touch and keyboard completion of core journeys; no critical a11y failures or silent data loss. |
| **W17** | **Portable workspace bulk import/export** (bounded async archive) with attachments, content, relationships, checksums and safe re-import. | W05, W07, W13, W15 | Tenant/ACL-safe export, collision-safe import, untrusted archive handling, traversal/zip-bomb prevention; round-trip into clean target with encryption and no external storage requirement. |

### Stage C — consistency, operations and integration contracts (P0/P1)

| ID | Planned PR: observable outcome | Prerequisites | Minimum acceptance beyond common CI |
|---|---|---|---|
| **W18** | **Interrupted-edit draft recovery**: bounded recoverable device-local drafts and explicit reconnection/conflict UX for unsent edits. This is *not* full offline-first sync. | W10 | Process/network interruption, session expiry, ACL revocation, tenant switch and shared-device privacy; no claim of server durability before ack; documented local retention/security. |
| **W19** | **Multiuser collaboration reliability**: reconnect storms, simultaneous editors, history/restore, writer failure/restart, no silent data loss. Keep supported one-writer architecture if benchmarks pass. | W18 | Fault injection, deterministic convergence, permission loss during socket session, explicit limits and reproducible supported editor concurrency. |
| **W20** | **Leased outbox/webhook delivery**: avoid holding DB transactions during receiver network waits; claim/ack, retries and dead-letter consistency. | Existing worker/rotation baseline | Slow/malicious receivers, crash/restart, secret rotation concurrency, idempotent delivery, tenant fairness and zero duplicate lost-event claims. |
| **W21** | **Current-state reconciliation API** for consumers of signed cursors; bounded snapshot/resync after disconnect or permission changes. | W20; existing cursor API | Correct tenant/user scopes, revocation and stale-cursor behavior; no data leaked in snapshots, cursor/signature replay and pagination tests. |
| **W22** | **Versioned API contract coverage and generated typed client** (and **optional**, off-by-default example consumer). | W21 | Request/response parity, compatibility checks and permission rechecks; example consumer uses no AI dependency and cannot bypass ACLs. **Do not touch Enterprise AI repository.** |
| **W23** | **Automated recovery operations**: scheduled encrypted backup/rotation, alerting, storage/database migration & upgrade/rollback runbooks, restore drills. | W17 for full portability not necessarily required for host backup | Restore to separately provisioned host, encryption key provenance, bad/corrupt backup rejection, PostgreSQL/WAL disk encryption contract, real-host test. |
| **W24** | **Capacity and latency qualification** for target supported single-host deployments; collect measured SLOs and publish sizing matrix. | W08, W13, W14, W19–W23 | Recorded reproducible load suite, CPU/RAM/disk/concurrency/large-workspace results, indexing/worker backlog/AV impact; tune or reduce supported limits. |

### Stage D — ship the standalone 1.0 product (P0)

| ID | Planned PR: observable outcome | Prerequisites | Minimum acceptance beyond common CI |
|---|---|---|---|
| **W25** | **WebKit/Safari, WCAG and visual regression**: add Safari/WebKit browser acceptance, screen-reader manual audit and repeatable screenshots with redacted fixtures. | W16 | Core mobile/desktop workflows, contrast/focus/order/live regions, no public private screenshot data. |
| **W26** | **White-label customer installation and admin UX**: site identity, logo/contrast checks, admin onboarding, configuration validation and local-first install profiles. | W04, W16, W23 | First-install/upgrade test on supported Linux and Windows/WSL (where supported); no SaaS sign-up; profile for local files or explicitly validated S3. |
| **W27** | **Security/privacy/commercial distribution gates**: release threat model & penetration-test remediation, dependency/image policies, secrets/key rotation, retention compliance configuration and redistribution notices/source archives. | W02–W26 substantially complete | Red-team tenancy/API/file attack cases; confirmed supply-chain artifacts; exact ClamAV GPLv2 corresponding source and MPL source/notice obligations reviewed; legal review required. |
| **W28** | **Release candidate and 1.0 tag**: independent customer-like host, end-to-end tenant/onboarding/auth, two-user authoring, DB relations/formula/rollup, import/export, encrypted backup/restore, accessibility, performance, recovery, support docs, upgrade smoke test and acceptance sign-off. | W01–W27 | Zero open release-blocking defects, green exact release SHA plus verified `main`, real-host evidence and deployment runbooks, changelog/support matrix, signed-off release decision before version tag. |

**Priority explanation:** P0 = essential before release; P1 = critical product depth that can be built after P0 security without relaxing security gates. If a capability is deferred during release review, revise the 1.0 feature promise and acceptance criteria *first*; do not silently mark the PR done.

## 4. Dependencies and critical path

- **Identity chain:** W01 → W02 → W03 → W04; W02/W03 derive from [TENANT_OIDC_DESIGN](TENANT_OIDC_DESIGN.md). Registry, admin UI and T3a are already implemented and **must not** be rebuilt.
- **Relational database chain:** W05 → W06 → W07; W05 → W08 → W09; W05/W07/W13 → W17.
- **Authoring chain:** W10 → W11 → W12; W10 → W18 → W19.
- **Navigation/index chain:** existing #61 → W13 → W14.
- **Operations/contracts:** W20 → W21 → W22, W23 → W24.
- **Release convergence:** W16/W19/W24 → W25/W26 → W27 → W28.

## 5. Parallel engineering without cross-contamination

Work may proceed in **separate isolated worktrees/design lanes** while publishing **one active merge-target engineering PR at a time** to keep CI, conflicts and reconciliation manageable. Do not create long-lived unrebased public PRs.

| Lane | Sequence / useful parallel prep | Isolation rules |
|---|---|---|
| Security/identity | W01 → W02 → W03 → W04 | Own auth, middleware, SSO policy; never relax policy for tests. |
| Product/data | W05 → W06/W08 → W07/W09; W10 → W11/W12 | Own property schemas, editor and UI; coordinate integration test fixture changes before merge. |
| Search/experience | W13 → W14 → W15 → W16 → W17 | Keep user-visible ACL guarantees; avoid conflicting edits to `Workspace.tsx` and navigation until main refreshed. |
| Platform/release | W20 → W21/W22; W18/W19; W23/W24 → W25–W28 | No live OpenJM Enterprise AI runtime/dependency; use isolated test providers and data. |

**Next sequence (Oct 2026):** execute **Wave R** from [DELIVERY_WAVES_1_0.md](DELIVERY_WAVES_1_0.md): W18 interrupted-edit recovery → W19 reconnect/collaboration fault reliability → the W24 capacity gates that qualify those behaviors. Reuse one fault/load harness and preserve independent W-ID acceptance evidence. Then proceed through bundled integration (W20–W22), operations/recovery (W23 + remaining W24), experience/packaging (W25–W26) and governance/release (W27–W28) waves. Older W02–W04/W08–W12 packages are closed by satisfying only their genuinely missing gates; do not rebuild accepted slices.

## 6. Mandatory definition of done — every implementation PR

1. Start at up-to-date `origin/main`; one visible vertical slice and schema/migration plan; no unrelated product/repo changes. Protect #59 Recently Viewed, #61 backlinks, appearances, SCIM, established SSO and storage modes.
2. Add **unit, native PostgreSQL integration under restricted non-BYPASSRLS runtime** and adversarial tenant/user/guest/service-token checks where relevant; ensure migrations are rollback-safe, rerunnable and recoverable.
3. Cover the **actual user workflow** in deployed Playwright; don't substitute tests of unrelated code. Validate keyboard/mobile and multi-client paths when relevant.
4. On the **exact final head SHA**, run TypeScript and Next production build, complete native PostgreSQL tests, encrypted SeaweedFS S3 recovery, hardened ClamAV/live EICAR, release images + SBOM + Trivy, deployed Chromium workflows, Chromium/Firefox accessibility and trusted HTTPS/WSS; W25 adds WebKit; host changes require host acceptance.
5. Keep local encrypted-files mode fully supported; if S3 mode is deployed to a customer, validate **that provider** with the documented recovery harness before rollout.
6. Confirm no confidential credentials, browser labels/private screenshots, datasets or raw backups are committed to this **public** repository. Review dependencies and third-party licensing.
7. Re-check `mergeable`, branch diff and base ancestry after latest main. Merge **only after** accepted exact-head results. Check post-merge main; clean merged branch; update [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62), [ACCEPTANCE](ACCEPTANCE.md) and [BUILD_CHECKPOINT](BUILD_CHECKPOINT.md) as applicable.

**No green CI = no merge.** If a workflow fails, investigate root cause, repair and re-run; do not lower or skip release/security gates just to pass.

## 7. Review cadence and progress accounting

After every accepted merge, record the **W-ID, actual GitHub PR number, merge SHA, exact-head workflow run, post-merge status, user-visible acceptance evidence, and outstanding risks** in Issue #62 (one checkbox per W-ID). Update this roadmap when dependencies or scope genuinely change. `W##` numbering stays stable even if a package requires multiple real GitHub PRs. No promises based solely on unfinished tool sessions or local uncommitted work.

**Project state (2026-10-06 after W17):** **9/28 W-items accepted**: W01, W05, W06, W07, W13, W14, W15, W16 and W17. W14 merged in PR #150 (`96f3067dba5f9dc0b207e85e76daaf6b1d000ef6`); W15 in PR #154 (`8af55db81b0fd7c454b95bbfa68960a96c2e19b9`); W16 in PR #156 (`e8864949b04a64a8c1ae86f4cd6d29e3406f6f13`); W17 in PR #158 (`6b7f60f422723ec19e8a5006f3033ab082d7e8b9`) after exact-head workflow 37531024966 succeeded on final head `13469db32b16fa03a17fa0511f81dac1624cdc29`. W08a–W08c are accepted *slices*, but W08 remains open for its remaining concurrency/capacity gate. W02–W04 and W08–W12 contain substantial accepted slices but remain formally open until their missing acceptance boundaries are proven. See [DELIVERY_WAVES_1_0.md](DELIVERY_WAVES_1_0.md) for the bundled closeout strategy. The [live tracker #62](https://github.com/sjevans1/Workspace-Platform/issues/62) remains the release tracker; historical baseline PRs #59/#61 are not double-counted.

## 8. Post-1.0 optional roadmap — explicitly outside release blocker list

- **X01** Full offline-first local queue, deterministic multi-device replay and conflicts.
- **X02** Horizontally scaled multi-writer collaborative editing/region failover, only once measured workload justifies it.
- **X03** Advanced workspace automations, scheduled tasks and deeper formula functions.
- **X04** Additional imports (DOCX/PDF/HTML), WebDAV/CalDAV or external SaaS connectors **when a customer opts in**.
- **X05** Retained quarantine, content disarm/reconstruction and retroactive file rescanning for higher-compliance environments.
- **X06** Enterprise identity variants (e.g. `private_key_jwt`, deeper per-tenant MFA/conditional access), after threat model and customer demand.
- **X07** Optional OpenJM Enterprise AI adapter: **separately deployed**, separate credentials, explicit consent/ACL-aware indexing, revocation and reconciler, can be turned off without affecting Workspace. Do not make Workspace's core DB, UI or operations depend on any LLM.
- **X08** Native mobile apps, additional enterprise-scale indexing, richer views/blocks as prioritized after 1.0 feedback.

The 1.0 release must not expand indefinitely to include X-items without an explicit scope change.
