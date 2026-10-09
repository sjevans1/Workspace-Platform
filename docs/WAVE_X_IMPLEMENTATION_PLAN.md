# Wave X implementation plan (W25 + W26 + residual release-visible closure)

Preparation and gap-audit tranche. No product or runtime code was modified to produce this document.

- Audit date: 2026-10-08
- Audit base: `main` at `2425c71c6fb170a0b734a8828e97128183b88016` (merge of PR #171, post-merge run `37824556029` SUCCESS)
- Preparation branch: `docs/wave-x-implementation-plan`
- Related: `docs/DELIVERY_WAVES_1_0.md`, `docs/ROADMAP_1_0.md`, `docs/OPERATIONS.md`, `docs/ACCEPTANCE.md`, `docs/ACCESSIBILITY_ACCEPTANCE.md`, tracker issue #62
- Merged since this audit: PR #174 (contextual examples) and PR #173 (W09d governed keyed imports, merge `8e01269`). W09e durable export then landed as PR #177 (merge `c940de6`), closing the last open W09 slice.

This plan prepares Wave X so implementation can start the moment the Wave O acceptance lane closes. It does not open an implementation PR and does not close any package.

---

## 1. Executive current-state summary

Waves R, I and (almost all of) O are landed. That moved a large amount of previously "open" tracker text into accepted fact, and the tracker has not caught up. The most important consequence for Wave X planning is that W25 and W26 are now genuinely the next implementation wave, and they are the two most expensive remaining release-visible packages: they are the first wave whose deliverable is broad cross-surface product quality (browser engines, accessibility, visual stability, packaging) rather than a single feature slice.

Verified state at this audit base:

- Playwright runs one browser by default. `playwright.config.ts` drives `e2e/workspace.spec.ts`, capacity harnesses and TLS with no `projects` block and a single viewport of `1440x1000`. A second config, `playwright.compat.config.ts`, runs only `accessibility.spec.ts` with exactly two projects, `chromium` and `firefox`.
- CI installs two engines: `npx playwright install --with-deps chromium firefox`. There is no `webkit` anywhere in the repository, the Playwright configs, or the workflows.
- There is no visual regression machinery: no `toHaveScreenshot`, no `toMatchSnapshot`, no committed snapshot directories.
- Accessibility automation is hand-written. `e2e/accessibility.spec.ts` contains no axe-core or equivalent; it is semantic browser assertion code. `docs/ACCESSIBILITY_ACCEPTANCE.md` already separates shared modal behaviour, semantic browser checks, browser engines and remaining work, which is a usable skeleton for the W25 matrix.
- Branding exists as a real module, not a stub. `packages/branding/index.ts` defines a strict schema (product name, primary accent, light and dark logo, favicon, login background, support name and URL, legal name, privacy URL, terms URL) with environment-driven defaults from `PRODUCT_NAME`, `PRIMARY_ACCENT` and friends. There is a runtime path to apply organisation branding and a Branding tab in `apps/web/components/Settings.tsx`.
- No brand assets ship. `apps/web/public/` is effectively empty and there is no app icon or favicon file, so a default install has no icon identity.
- There is no mail transport at all. No SMTP, nodemailer or equivalent exists in `apps/`, `packages/` or `scripts/`, and `.env.example` has no mail section.
- There is no account recovery. No forgot-password, reset or recovery route exists in the API.
- Environment validation does not exist as a module. There is no `validateEnv` or equivalent; startup validation is implicit.
- Operations groundwork is strong and reusable: `scripts/init-env.mjs`, `scripts/backup.ts`, `scripts/backup-schedule.sh`, `scripts/ci-restore-drill.sh`, `scripts/migrate-storage-encryption.ts`, `scripts/provision-tenant.ts`, `scripts/licenses.mjs`, `scripts/accept-production-s3.ts`, `scripts/test-deployment.mjs`, plus `/health`, `/ready` and a credential-gated `/metrics`.
- `docs/OPERATIONS.md` already documents deployment, proxy trust and rate limits, domain and HTTPS, Enterprise SSO, Keycloak back-channel logout, SCIM, monitoring, tenant provisioning, branding, storage modes with an encryption upgrade path, malware scanning, webhooks, backup, verification and retention, restore to an empty deployment, upgrades and health, and real-host acceptance.

The gap between W25/W26 as written and what exists is therefore not "missing features everywhere". It is: no third engine, no visual regression, an accessibility story that is real but automated-only and not yet mapped to WCAG closure, no shipped brand assets, no environment validation, and unfinalised org-versus-deployment branding and install-profile semantics.

---

## 2. Accepted versus outstanding matrix

Legend for "type": **impl** means implementation is genuinely missing; **acc** means implementation exists and needs acceptance evidence only; **closure** means formal closure or evidence bookkeeping only.

| Package | Already accepted (do not rebuild) | Still missing product functionality | Missing native acceptance | Missing deployed/browser acceptance | Security or reliability dependency | Likely files or subsystems | Type |
|---|---|---|---|---|---|---|---|
| W02 tenant IdP activation | Encrypted disabled tenant provider registry, Settings admin surface, T3a state and provenance columns, fail-closed issuer-bound `/auth/switch`, deployment-level OIDC | Tenant and provider selection at `/auth/oidc/start`, `/auth/oidc/callback`, `/auth/methods`; binding `tenant_id`/`provider_id`/`revision`/`issuer`/`client_id` to single-use state | Two-issuer matrix, overlapping emails, replayed or mismatched callbacks, revocation and rotation, SSRF allowlist | Real disposable Keycloak two-tenant sign-in | Identity; must fail closed; must not weaken W01 rate limiting | `apps/api/src/app.ts` auth routes, `docs/TENANT_OIDC_DESIGN.md`, tenant registry | impl |
| W03 session provenance and logout | Immutable attribution columns, per-provider signed logout groundwork, scoped revocation primitives | Deny of issuer downgrade or tenant switching through session flows; per-provider logout scope enforcement | Hostile logout JWT, replay, SCIM offboarding, local break-glass, unrelated tenants unaffected | Two-tenant logout browser journey | Identity and session isolation | auth and session modules, SCIM | impl |
| W04 account recovery and invites | Rate-limited identity baseline from W01 | Password recovery (rate limited, expiring, one time), admin-assisted recovery for air-gapped installs, optional SMTP invites | No enumeration or token leakage, hashing, revocation, audit, CSRF, multi-tenant, fail-closed mail errors | Recovery journey in browser | W01; must not create an enumeration oracle | auth routes, new mail transport, `.env.example` | impl |
| W08 final live-reordering and named-host capacity | W08a to W08d cursor, sorting, pagination, 10k row and 25 session slices | Strict concurrent reordering policy if still required | Named-host capacity evidence | Not browser-visible | RLS and capacity | query layer, capacity harnesses | acc or closure (mostly closed by W24) |
| W09 process reliability | Leases, cancellation, reclaim, retry-stable object identity, staged cleanup, audit | None (accepted by PR #169) | None | None | Worker and storage | worker, jobs | closure |
| W09d governed keyed upsert | Key model, planner, preview, hidden-collision detection, ACL and revision fencing; normalization v3 exact NFC | Acceptance only; key-type set is being narrowed in flight | Restricted-role PostgreSQL suite | Browser acceptance | RLS, no hidden-row disclosure | `packages/imports`, API, worker | accepted (PR #173) |
| W09e large and durable export | None | Export job architecture, bounded keyset batching, artifact lifecycle, cooperative cancellation, download authorization | Load and peak-RSS evidence | Export journey in browser | Worker, storage, authorization on download | jobs and `job_artifacts`, API, worker | impl |
| W10 editor coverage | W10a through W10c5d incl. rich restore, paste safety, live multi-editor, mobile and tablet touch, encrypted media backup round trip | W10c5e denial of previously shared private attachment URLs after revocation; broader media and playback if still in scope | Attachment revocation native coverage | Revocation browser acceptance; independent-host DR belongs to W23/W24 | Media authorization and revocation | media routes, editor blocks | impl (W10c5e) |
| W11 comments and mentions | Root and reply model, atomic resolve versus reply, threaded UI, drafts, anchor movement, permission-safe mentions | None identified | Reconnect and revocation coverage where not already proven | Package-level two-user reconnect and revocation browser acceptance | RLS, anchor integrity | comments modules, editor | acc |
| W12 notifications | Inbox, durable read and unread, reply alerts with dedupe, recipient-owned mention and reply preferences under FORCE RLS | Optional external mail delivery (only if mail is in 1.0 scope) | Retention, pagination and revocation edge coverage | Inbox browser acceptance for retention and revocation | RLS, recipient scoping | notifications, inbox UI | acc plus optional impl |
| W25 WebKit, accessibility, visual regression | W16 mobile and keyboard pass; `accessibility.spec.ts` in Chromium and Firefox; `docs/ACCESSIBILITY_ACCEPTANCE.md` skeleton | WebKit coverage; WCAG closure matrix with manual AT review; deterministic visual-regression harness | Engine-specific and viewport-specific acceptance | Deployed WebKit and viewport matrix in CI | Must not weaken TLS, rate limits, AV or permission rechecks to pass a new engine | `playwright.compat.config.ts`, new visual config, `e2e/accessibility.spec.ts`, `apps/web` only where a real defect is found | impl |
| W25-T curated template library and template experience | Templates surface exists and contextual examples are now part of the product | Curated 1.0 library of ~20–30 high-value page, database and space templates; richer template metadata/categories; whole-structure instantiation for selected business workflows | Deterministic template-definition/schema tests; duplicate/install semantics; no cross-tenant references | Browser acceptance for browsing, previewing and creating representative page/database/space templates | Must remain tenant-safe, deterministic and standalone; templates must contain synthetic/default content only | template catalog/definitions, create flow, Templates surface, representative e2e fixtures | impl |
| W26 white-label and packaging | Branding schema with env defaults, org branding PATCH path, Settings Branding tab, ops scripts, storage modes, backup, health endpoints | Shipped brand assets; environment validation with fail-closed errors; first-run branding capture; install and deployment profiles; profile readiness visibility; clean uninstall and redeploy expectations | Profile validation native coverage | First-install and upgrade acceptance on a supported host incl. Windows/WSL where supported | Secrets handling; customer-safe defaults; no SaaS sign-up | `packages/branding`, `apps/web` metadata and Settings, `scripts/init-env.mjs`, new validation script, `docs/OPERATIONS.md` | impl |
| W27, W28 | Not started | Governance and release | n/a | n/a | Release gates | release docs and images | out of scope for Wave X |

Read the "type" column strictly. Several rows have substantial accepted work and only need acceptance, and one row (W09) is already done and needs only bookkeeping.

---

## 3. W25 implementation and acceptance plan

### 3.1 Browser compatibility

Current facts: one default engine, one viewport, a separate accessibility config with Chromium and Firefox, and CI installing only those two engines.

Plan:

1. Add `webkit` to `playwright.compat.config.ts` as a third project, and add `webkit` to the CI `playwright install` line. Treat Linux WebKit as an engine-compatibility proxy, never as a claim of Safari on macOS or iOS. State that limitation in the acceptance record.
2. Define the viewport matrix as named projects rather than ad hoc in-test resizing: desktop `1440x1000`, tablet `820x1180`, phone `390x844`, with `deviceScaleFactor: 1` and a pinned locale and timezone for determinism.
3. Reuse existing coverage first. `e2e/workspace.spec.ts` already contains the product journeys, and `e2e/accessibility.spec.ts` already asserts keyboard behaviour. Reuse both under the new engine and viewport projects instead of writing parallel specs.
4. New WebKit-specific coverage should be limited to behaviour where engines genuinely diverge: focus handling in the editor, hover-dependent controls that need a tap fallback, native date and select controls, long-press versus drag affordances in board and calendar views, file input behaviour in the media blocks, and scroll anchoring in long pages.
5. Chromium and Firefox regression coverage is already in CI. The plan keeps both and adds WebKit alongside, rather than replacing anything.

### 3.2 Accessibility: WCAG-focused closure matrix

The honest framing: `e2e/accessibility.spec.ts` is hand-written semantic assertion code, and automated tooling cannot establish WCAG compliance. The matrix therefore separates three lanes. Add axe-core as a supplementary automated signal only where it is deterministic, and never as the compliance claim.

| Surface | Automatable in CI | Browser acceptance | Manual assistive-technology review |
|---|---|---|---|
| Keyboard-only use of core journeys | Yes, extend existing spec | Chromium, Firefox, WebKit | No |
| Focus order and focus restoration after modal close | Yes | Chromium, Firefox, WebKit | Yes, confirm sensible order |
| Modal focus trapping and escape | Yes | All three | No |
| Visible focus indication | Partly, token and outline checks | All three | Yes, confirm real visibility on dark theme |
| Semantic landmarks and headings | Yes | All three | Partly |
| Accessible names for controls | Yes | All three | No |
| Form labels and error association | Yes | All three | No |
| Tables and database views | Partly, header and ARIA structure | All three | Yes, confirm announcement quality |
| Editor toolbar and block controls | Partly | All three | Yes, this is the highest-risk surface |
| Dialogs | Yes | All three | No |
| Notifications and inbox | Partly | All three | Yes |
| Settings and admin surfaces | Partly | All three | No |
| Colour contrast | Yes, computed token contrast tests | All three | No |
| Reduced motion | Yes, media-query behaviour checks | All three | No |

Manual review scope must be declared before acceptance, for example NVDA on Windows with Chromium or Firefox. Screen-reader coverage on Safari is only meaningful if a real macOS or iOS device is in scope. Where it is not, say so plainly in the acceptance record rather than implying coverage.

### 3.3 Visual regression

Design constraints: deterministic fixtures, non-sensitive content only, light and dark, desktop and mobile, no unstable timestamps or randomness, explicit baseline update rules, and failure on meaningful drift without becoming screenshot-noise machinery.

Harness design:

- A dedicated `playwright.visual.config.ts` running only visual specs, with `animations: "disabled"`, a fixed viewport set, a pinned timezone and locale, `deviceScaleFactor: 1`, and `maxDiffPixelRatio` set tight enough to catch real layout drift but tolerant of anti-aliasing (start around `0.002` and tune once from real runs).
- A deterministic fixture seeder, `scripts/e2e-seed.ts`, creating a fixture organisation with fixed titles, fixed record values, fixed comment text and no timestamps in visible content. Fixture IDs are generated, so snapshots must not depend on raw ID text.
- Smallest representative surface set, eight surfaces: sign-in screen; workspace shell with sidebar and recently viewed; a page with the core block set rendered; the database table view; the board view; the calendar view; the settings branding panel; the manage-access dialog. Inbox is a ninth only if the fixture can make it deterministic.
- Snapshot scope: Chromium only, light and dark, desktop and phone. Firefox and WebKit rendering differences make cross-engine pixel baselines noise rather than signal; engine behaviour is covered by the compatibility lane instead. Document that reasoning.
- Baseline policy: baselines live in the repository only because fixtures are non-sensitive and synthetic. Any change requires an explicit update command, a visible diff in review, and a stated reason. CI never auto-updates. A failing snapshot is investigated, never refreshed to green.

---

## 3.4 W25-T curated template library and template experience

W25-T is part of Workspace 1.0 and is deliberately separate from W29 Connected Work. It productizes the existing Templates capability rather than introducing a new integration subsystem.

Initial release target: approximately 20–30 curated, genuinely useful templates across Projects & Delivery, Meetings, Operations, Sales/CRM, HR & People, Management, Finance, Knowledge, Risk & Compliance, and Personal Productivity.

Template levels:

1. **Page templates** — for example SOP, meeting notes, project brief, decision log and policy.
2. **Database templates** — for example task tracker, sales pipeline, risk register, vendor register and recruitment pipeline.
3. **Space/workspace structure templates** — multi-resource starter systems such as Project Management, HR Workspace or Client Delivery, creating pages/databases/views/relationships as one coherent structure.

The acceptance bar is higher than prefilled headings. A template must create useful structure: sensible properties, views, defaults, relationships where supported, example guidance, and synthetic starter content only.

Representative 1.0 multi-resource templates should include at least:

- Project Management: overview, scope, meeting notes, risks/issues, actions, decisions and milestones.
- HR Workspace: people directory, recruitment, onboarding, policies, training and reviews.
- Client Delivery: client overview, deliverables, meetings, actions, risks and decision log.
- Operations: SOP library, incident log, maintenance log, shift handover and action tracker.
- Management Review: KPI dashboard, weekly review, monthly business review, OKRs and decision log.

Scope guardrails:

- no external-provider dependency;
- no OpenJM dependency;
- no marketplace in 1.0;
- no user-authored template publishing workflow unless already trivial to expose safely;
- no private/customer data in built-in templates;
- template definitions must be versioned and deterministic;
- creation must respect current tenant permissions and normal resource limits.

Acceptance should prove one representative page template, one database template and one multi-resource structure template end to end in the deployed browser.

---

## 4. W26 implementation and acceptance plan

### 4.1 Plane model

Three planes, deliberately not three applications:

1. Provider and deployment control plane: environment files, `init-env`, compose, reverse proxy and TLS, storage mode selection, backup schedule, upgrade and rollback, health and metrics. This stays deployment configuration plus operator scripts, with no new application.
2. Customer organisation admin plane: what a signed-in owner or admin can change inside the product, namely organisation branding, members, integrations, webhooks, audit. This already exists in Settings and should absorb the org-scoped branding and recovery administration.
3. End-user operating plane: the ordinary authoring, search, database, comment and notification experience. It reads branding and never configures it.

The dividing line to settle explicitly: sign-in branding is currently described in the product as set by the deployment environment. Wave X must decide whether an organisation admin may override sign-in branding, or whether that stays a provider decision. This is a product decision, listed in section 8.

### 4.2 Remaining implementation

- Brand identity: ship a neutral default light logo, dark logo, favicon and app icon so a fresh install is not iconless, and wire Next metadata (title and icon) from the branding module rather than hardcoding.
- Organisation branding: keep the existing schema and PATCH path, add contrast validation on the accent colour and reject unusable combinations with an actionable error, and make the end-user read path strictly read-only.
- Install and deployment profiles: define and validate at least a local-files profile and an S3 profile. `.env.example` already documents both modes and the encryption upgrade path; the missing piece is validation and visibility, not the modes themselves.
- Environment validation: add a validation step, exposed both as a startup fail-closed check and as an operator script, that verifies required secrets are present and well formed without ever printing values, and that reports which profile is active.
- First-run setup: extend the existing setup flow so the first administrator can set product name and accent at creation time, keeping the current setup token requirement exactly as it is.
- Storage configuration: keep local encrypted files as the default supported mode; for S3, surface the existing acceptance script as the documented validation path.
- SMTP and email configuration: only if mail is confirmed in scope (section 8). If it is, add a mail profile with fail-closed behaviour and a disabled-by-default posture so a mail-free install remains fully functional.
- SSO configuration: reuse the existing tenant provider registry and deployment OIDC as they are. W26 contributes validation and visibility, not a new identity mechanism.
- Backup configuration: surface schedule and last-verified-restore status from the existing backup tooling; do not build a second backup path.
- Upgrade configuration: reuse the upgrade and restore drill scripts, and add a documented pre-upgrade check that validates the environment before a migration runs.
- Operational health visibility: `/health`, `/ready` and `/metrics` already exist. Add a human-readable profile and readiness summary for the admin plane that exposes no secret material.
- Clean uninstall and redeploy: document teardown including volumes, and prove a clean reinstall to an empty deployment using the existing restore path.
- Secrets handling: never log, echo or render secret values; validation reports presence and shape only; `.env` stays gitignored.
- Customer-safe defaults: local storage, antivirus required, no external SaaS account, no telemetry beyond the existing opt-in metrics endpoint.

---

## 5. Residual W02 to W04 and W10 to W12 classification

| Item | Classification | Rationale |
|---|---|---|
| W02 tenant IdP activation and callback binding | A, implementation missing | The registry and design exist, but tenant-scoped sign-in selection and state binding are not active. |
| W03 session provenance and logout isolation | A, implementation missing | Follows W02; the provenance columns exist but the enforcement paths do not. |
| W04 password recovery | A, implementation missing | No recovery route exists anywhere in the API. |
| W04 optional invite mail | A or E, decision required | No mail transport exists at all. Whether 1.0 needs it is a scope decision, not an engineering discovery. |
| W08 final live reordering and named-host capacity | B or C, acceptance or superseded | W24 whole-stack capacity qualification covers most of the named-host intent; confirm the concurrency policy clause is either satisfied or dropped explicitly. |
| W09 crash-safe jobs, cancellation, streaming export | W09 process reliability is C, superseded and accepted. W09d is B, accepted (PR #173). W09e is A, now accepted (PR #177). | Do not rebuild process reliability. |
| W10c5e attachment revocation of previously shared URLs | A, implementation missing | Genuinely absent product behaviour and security visible. |
| W10 broader media, playback, independent-host DR | D, belongs partly to W23 and W24 | Independent-host DR was landed in W23. Playback breadth is only in scope if the 1.0 promise requires it. |
| W11 reconnect and revocation acceptance | B, acceptance only, with D overlap | Implementation is largely accepted; reconnect and revocation resilience should reuse the Wave R harness rather than new work. |
| W12 retention, pagination, revocation acceptance | B, acceptance only | Inbox, read state and preferences are accepted. |
| W12 optional external mail delivery | A or E, decision required | Same scope question as W04 mail. |
| W25 and W26 | A, implementation missing | Confirmed by this audit. |
| W27 and W28 | E, belongs to a later wave | Governance and release. |

The rule this classification enforces: an open tracker checkbox is not evidence of missing implementation.

---

## 6. Proposed X0 to X5 execution sequence

The sequence below was ordered to minimise branch conflicts with the W09d and contextual-examples work; those have since merged (#173, #174), so the Wave X tranche starts from a Wave O-closed main.

### X0 acceptance harness and deterministic fixtures

- Scope: engine and viewport projects, deterministic fixture seeder, visual-regression config and baseline policy, and the CI wiring for all of it. No product behaviour change.
- Excluded: any fix to product code, any accessibility finding remediation, any W26 work.
- Files: `playwright.compat.config.ts`, new `playwright.visual.config.ts`, new `e2e/fixtures/`, `scripts/e2e-seed.ts`, `.github/workflows/ci.yml`, `package.json` scripts.
- Tests: the harness must prove its own determinism by producing identical results across three consecutive runs.
- Gates: existing Chromium and Firefox gates must remain green and unmodified; the new engine must not be allowed to fail silently.
- Dependencies: none beyond the audit base.
- Merge boundary: this is the safest first merge, since it cannot change product behaviour.
- Rollback: revert the config and CI additions; no data or schema impact.

### X1 W25 browser and accessibility compatibility

- Scope: WebKit support, the three-viewport matrix, reuse of existing specs under the new projects, WebKit-specific fixes for real defects, and the WCAG closure matrix with the automation additions it identifies.
- Excluded: visual regression (X2), W26 (X3), any weakening of TLS, rate limits, antivirus or permission rechecks.
- Files: `e2e/accessibility.spec.ts`, `playwright.compat.config.ts`, `apps/web` only where a genuine engine defect is found, `docs/ACCESSIBILITY_ACCEPTANCE.md`, CI workflow.
- Tests: full accessibility spec across three engines and three viewports; targeted WebKit cases for editor focus, tap fallbacks, native controls, long-press versus drag, file inputs and scroll anchoring.
- Gates: Chromium, Firefox and WebKit accessibility runs; trusted TLS and WSS unchanged; no assertion deleted to pass an engine.
- Dependencies: X0.
- Merge boundary: merge only when all three engines pass on the exact head.
- Rollback: an individual engine project can be quarantined only by an explicit, recorded decision with a stated reason. Removing assertions is not a rollback.

### X2 W25 visual regression

- Scope: the eight-surface snapshot set, Chromium only, light and dark, desktop and phone, with the documented baseline policy.
- Excluded: cross-engine pixel baselines, private or customer content, auto-updating baselines.
- Files: new `e2e/visual.spec.ts`, `playwright.visual.config.ts`, committed non-sensitive baselines, CI workflow.
- Tests: three consecutive identical runs at the start; then drift must be detected by an intentional fixture change (a canary that must fail).
- Gates: no private data committed to this public repository; snapshot failures block merge until explained.
- Dependencies: X0, and X1 for any surface whose layout changed under a new engine.
- Merge boundary: merge when the canary fails as designed and the real surfaces are stable.
- Rollback: revert the visuals spec and config; baselines are additive.

### X2.5 W25-T curated templates

- Scope: ship the curated 1.0 template catalog, improve the Templates browsing/selection experience, and support deterministic page, database and multi-resource structure creation.
- Excluded: marketplace, community publishing, AI-generated templates, W29 connectors and external content ingestion.
- Files: template definitions/catalog, creation flow, Templates UI, deterministic fixture tests and browser acceptance.
- Tests: validate every built-in template definition; instantiate representative page/database/space templates; verify IDs/relationships are newly generated, tenant-local and permission-safe.
- Gates: synthetic content only; no hard-coded tenant/resource IDs; repeated creation produces independent structures; templates remain usable with no external provider configured.
- Dependencies: X0 deterministic fixtures. It may run after X1 or alongside X2 if file overlap is low.
- Merge boundary: independently reviewable product tranche before W26 packaging.
- Rollback: remove catalog additions without schema or migration impact.

### X3 W26 branding and deployment packaging

- Scope: shipped default brand assets, metadata wiring, contrast validation, environment validation with fail-closed startup and an operator script, first-run branding capture, install profile validation and visibility, admin-plane readiness summary, uninstall and redeploy documentation, and secrets-safe reporting.
- Excluded: a new identity mechanism, a second backup path, any SaaS dependency, W29.
- Files: `packages/branding`, `apps/web` metadata and Settings, `apps/web/public` assets, `scripts/init-env.mjs`, a new validation script, `docs/OPERATIONS.md`, `.env.example`.
- Tests: native profile validation cases including malformed and missing configuration; first-install acceptance; upgrade acceptance using the existing drill.
- Gates: secrets never rendered; SAFE defaults preserved; local encrypted storage stays the default supported mode.
- Dependencies: W23 for backup and restore (accepted), W16 for mobile and keyboard (accepted), and W04 only for mail if mail is in scope.
- Merge boundary: split branding from packaging validation into two commits to keep review tractable.
- Rollback: branding defaults are environment-driven, so reverting config restores prior appearance.

### X4 residual closure

Split deliberately, because identity must stay separately reviewable:

- X4a: W10c5e attachment revocation, then W11 and W12 package-level acceptance reusing the Wave R fault harness. Mixed implementation and acceptance.
- X4b: W02, W03 and W04 identity work, in that order, behind the existing disabled registry, with deployment-level OIDC and local break-glass preserved throughout.
- Excluded: rebuilding W01, W09 process reliability, W13, W14, W15, W16, W17, W18, W19, W20, W21, W22, W23 or W24.
- Gates: identity work must not change reference semantics for existing sessions; attachment revocation must be proven against a previously issued URL, not just a new request.
- Dependencies: X1 for any browser-facing acceptance.
- Rollback: X4b is the only phase with genuine authentication-session risk, so it should ship behind the same fail-closed posture and be revertible per route.

### X5 exact-head release acceptance and package closeout

- Scope: full exact-head CI, the ledger update on issue #62, `ACCEPTANCE.md` and `BUILD_CHECKPOINT.md` updates, and post-merge main verification.
- Excluded: any new feature work, any checkbox marked complete without evidence.
- Gates: the full existing gate set on the exact final head SHA, with the W25 additions included.

---

## 7. Exact acceptance gates

Every Wave X implementation head must satisfy, on that exact SHA:

1. TypeScript check and Next production build.
2. Complete native PostgreSQL test suite under restricted non-BYPASSRLS runtime.
3. Existing adversarial tenant, user and guest isolation checks unchanged.
4. Encrypted storage acceptance in both local and S3 modes where the change touches storage.
5. Release image build with SBOM and Trivy, plus ClamAV image checks, with no suppressed fixable findings.
6. Deployed Chromium browser workflows.
7. Accessibility and keyboard acceptance in Chromium and Firefox as today, plus WebKit once X1 lands.
8. Trusted HTTPS and WSS acceptance.
9. Wave R and W24 fault and capacity harnesses where the change touches collaboration, worker or capacity behaviour.
10. W23 isolated restore drill where the change touches backup, restore, storage or migration paths.

Wave X adds, for W25:

11. Visual regression must run and must fail on an intentional canary change before it is trusted.
12. No private, customer or contradictory-content screenshots committed to this public repository.
13. Engine, viewport and assistive-technology coverage claims must match what actually ran.

Wave X adds, for W26:

14. Environment validation must fail closed and must report presence and shape without printing secrets.
15. A first-install and an upgrade acceptance on a supported host, with Windows/WSL included only if that is confirmed as supported.
16. A mail-free install remains fully functional if mail is in scope at all.

Universal rule carried forward unchanged: no green exact-head acceptance means no merge, and no gate may be lowered to pass an engine or a packaging assertion.

---

## 8. Known risks and conflict areas

- Single shared spec file. `e2e/workspace.spec.ts` is one very large spec that nearly every wave touches. Wave X adds to it, so X1 lands after PRs #173 and #174 (both merged) to avoid a three-way spec conflict.
- Frontend surface collisions. W11 and W12 work and Wave X both touch `apps/web` components, especially Settings and the collaboration UI. Sequence X3 after those are merged or coordinate the fixture changes first.
- Snapshot noise. Font rendering and rasterisation vary by host and engine. This is why X2 scopes baselines to Chromium and tunes the tolerance from real runs rather than guessing.
- WebKit on Linux is not Safari. Reporting must not imply macOS or iOS coverage.
- Accessibility honesty. Automated checks cannot establish WCAG compliance. The manual AT lane must be genuinely performed or explicitly declared out of scope.
- CI cost. Adding a third engine and a viewport matrix lengthens the deployment job. Budget it deliberately rather than letting it silently extend, and never buy time by dropping existing gates.
- Public repository discipline. Baselines and fixtures must contain only synthetic content, and no credentials or private screenshots may be committed.
- Identity risk in X4b. Authentication changes are the only Wave X work with genuine session-invalidation risk. Keep them behind the existing fail-closed posture and reviewer separation.
- Scope creep from optional mail. Mail is the single largest unbounded item in this plan. Decide it once, explicitly.

---

## 9. Connected Work, native automation and agentic workflow future architecture

### 9.1 W29 — Connected Work / Integration Control Plane

W29 (Connected Work and communications integration) is a future capability, is not part of Workspace 1.0, and is explicitly out of scope for Wave X. It must not be implemented here and must not appear in the 1.0 feature promise.

Architectural direction: `Workspace -> Integration Control Plane -> Provider Adapters`, with normalized concepts of `Connection`, `Channel`, `Conversation or Event`, `Message`, `Participant` and `Attachment`, and optional association from those to `Organisation`, `Space`, `Page`, `Database` and `Record`. Candidate providers include Gmail, Google Calendar, Outlook Mail and Calendar, WhatsApp Business, Telegram, Discord, and later Slack or Teams. Workspace must remain fully functional with no provider configured.

W29 provides the external event and action boundary. A message, form submission, email, calendar event or webhook is normalized into an event that Workspace can consume without making the workflow engine provider-specific.

### 9.2 W30 — Native Automation & Agent Runtime

W30 is the future Workspace-native automation and agentic workflow layer. It is separate from W29: W29 supplies provider connections and normalized events; W30 supplies triggers, conditions, schedules, steps, approvals, actions, retries, execution history and agent reasoning.

Core concepts to preserve for future implementation:

- `Trigger`, `Schedule`, `Workflow`, `WorkflowVersion`, `WorkflowRun`, `Step`, `Approval`, `Agent`, `Tool`, `Credential`, `Event`, `Action` and `ExecutionResult`.
- Deterministic automation must not require an LLM. Date triggers, forms, record changes, approvals, notifications and database writes should execute through normal workflow logic.
- Agent/LLM steps are introduced only where interpretation, extraction, summarisation or reasoning is useful.
- Workspace owns identity, permissions, workflow state, tool authorization, approvals, audit and execution. AI providers provide reasoning and proposals; they never bypass Workspace authorization.
- Human-in-the-loop approval levels must be first-class for controlled writes, external actions and high-impact operations.
- Workspace must remain standalone. OpenJM Enterprise AI is an optional advanced reasoning provider, not a mandatory dependency.

Example future workflow: a supervisor sends weekly hours through Discord, Telegram, WhatsApp or a Workspace form. The external input is normalized by W29; W30 extracts employee names and hours, validates them against tenant-visible Workspace records, requests approval when configured, writes the weekly-hours database, records provenance and notifies payroll.

Example scheduled workflow: fourteen days before an employee contract end date, W30 gathers permitted performance, attendance and HR records, creates a contract-review work item, optionally requests an AI-generated evidence summary, proposes meeting slots using connected calendars, routes approvals and records the renewal decision.

### 9.3 Native Workspace Chat

Workspace should eventually expose Chat as a first-class surface even when OpenJM Enterprise AI is not connected. A configured local or external model provider may power the native assistant. When OpenJM is connected, it can be registered through the same agent-provider contract as an advanced enterprise reasoning backend.

The native chat should be able to search permitted Workspace content, explain and summarize data, create or update Workspace resources through governed tools, and draft workflow definitions for user review. The chat interface must never become an authorization shortcut around normal Workspace permissions and approval policies.

### 9.4 Workflow template library

The template strategy should extend beyond static page/database/space templates into reusable workflow templates. This future library must span major business functions, not only HR.

Representative workflow-template families:

- **HR & People:** onboarding, probation review, contract-renewal review, leave approval, performance-review cycle, training follow-up.
- **Finance & Payroll:** weekly hours intake, overtime approval, expense approval, month-end checklist, receivables follow-up, budget-variance review.
- **Sales & CRM:** inbound lead capture, lead qualification, stale-opportunity follow-up, proposal approval, meeting follow-up, renewal reminders.
- **Operations:** shift handover, incident escalation, maintenance requests, production exception review, daily/weekly operating review.
- **Procurement & Vendors:** purchase-request approval, supplier onboarding, PO follow-up, contract renewal, vendor-performance review.
- **Customer Service:** intake and triage, SLA escalation, complaint resolution, case closure, customer follow-up.
- **Projects & PMO:** project intake, risk escalation, milestone review, change-request approval, action-item follow-up.
- **Compliance & Risk:** policy attestation, audit finding remediation, control review, risk acceptance, evidence-collection reminders.
- **IT & Security:** access request, joiner/mover/leaver workflow, incident response, vulnerability remediation, change approval.
- **Executive / Management:** weekly management review, KPI exception escalation, board-pack preparation, decision follow-up.

Workflow templates should be composable with the W25-T resource templates. For example, an HR Workspace template can create employee, contract and performance databases while also installing optional contract-renewal and onboarding workflows that reference those resources using newly generated tenant-local IDs.

No marketplace, community publishing or external-provider dependency is implied for 1.0. Future workflow templates must be versioned, deterministic, tenant-safe and explicit about required connectors, approvals and permissions.

### 9.5 Boundary rule for Wave X

Nothing decided in Wave X may make W29 or W30 harder later. Avoid provider-specific assumptions in branding, configuration, navigation, notification primitives, permission checks, database schema or template definitions. Where a provider-neutral seam naturally exists, reuse it. Do not build speculative connector or agent infrastructure during Wave X.

The governing architectural rule is:

> **Workspace owns workflow authority, permissions, state and actions. AI providers provide reasoning; they do not own authorization or execution.**

---

## 10. Recommended first implementation tranche

Start with **X0**, then **X1**, in that order, both after the Wave O lane closes (W09d #173, W09e #177) and the closeout reconciliation lands. Follow with **X2 visual regression and X2.5 W25-T curated templates** before W26 packaging.

Reasons: X0 changes no product behaviour, so it is the lowest-risk merge available and it unlocks everything else. X1 is the highest-value W25 deliverable and the item most obviously missing from the current product, since WebKit is entirely absent and the accessibility matrix is not yet mapped to WCAG closure.

Recommended composition of the first tranche:

- X0: engine and viewport projects, deterministic fixture seeder, visual config skeleton, CI wiring, determinism proof.
- X1: WebKit across the reused specs, the three-viewport matrix, WebKit-specific defect fixes, and the WCAG closure matrix with its automatable lane implemented.
- X2.5: curated 1.0 templates spanning page, database and multi-resource structures, with deterministic tenant-safe instantiation and deployed browser proof.

Stop and seek input before starting X3, because X3 depends on the unresolved branding-plane and mail-scope decisions below.

---

## Decisions requiring Shane or external review before implementation

1. Is SMTP mail in 1.0 scope at all, for W04 invites and W12 external delivery? No transport exists. Either decide it in, with a defined mail profile, or declare it out of scope and close those clauses honestly.
2. May an organisation admin override sign-in branding, or does sign-in branding stay a deployment-level provider decision? The product currently describes it as deployment-set.
3. Visual baselines: confirm they may be committed to this public repository on the basis of synthetic fixtures only, with the explicit update and review policy in section 3.3.
4. Assistive-technology scope: which exact screen reader and platform combinations count as the manual review for W25 acceptance, and who signs off?
5. WebKit scope: is Safari on macOS or iOS a supported target requiring real-device verification, or is Linux WebKit in CI the accepted proxy?
6. Is Windows/WSL a supported install target for W26 acceptance, or is that only documented as untested?
7. Does W10c5e attachment revocation belong inside Wave X or inside the W27 security gate? It is security visible either way.
8. Confirm that W29 remains outside 1.0 and that Wave X is expected only to preserve the boundary described in section 9.

## Tracker and roadmap disagreements found during this audit

Reported, not altered. Issue #62 checkboxes were left untouched as instructed.

1. Issue #62 still shows W18 through W24 as unchecked, while Wave R, Wave I and Wave O accepted W18, W19, W20, W21, W22, W23 and the bulk of W24. The tracker is materially behind accepted fact.
2. Issue #62 and issue #74 describe W10c4f as an in-flight draft (PR #113) awaiting acceptance. It has since been accepted and merged, so that text is stale.
3. `docs/ROADMAP_1_0.md` section 7 states 9 of 28 packages accepted as of 2026-10-06. Waves R, I and O have moved far beyond that figure.
4. `docs/DELIVERY_WAVES_1_0.md` is baselined before Wave R and still frames Wave R as the next wave.
5. `docs/ROADMAP_1_0.md` section 2 lists issue #50 rate limits as open and mapped into W01, while W01 is accepted. Either the issue is stale or the mapping needs restating.
6. W25 and W26 have no dedicated tracking issues, only checkboxes in #62. Given their size, they likely need their own issues with acceptance criteria before implementation starts.
7. W29 appears nowhere in the roadmap; the closest text is post-1.0 item X04 about external SaaS connectors. It needs an explicit boundary statement, which section 9 provides.
