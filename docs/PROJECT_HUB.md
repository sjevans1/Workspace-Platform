# Workspace Platform — Product Development Hub

**Audit date:** 2026-10-04 (Jamaica). **Status:** pre-1.0 / active development; NOT production-released.  
**Standalone repository:** https://github.com/sjevans1/Workspace-Platform  
**Authoritative delivery tracker:** https://github.com/sjevans1/Workspace-Platform/issues/62  
**Versioned 1.0 plan:** [ROADMAP_1_0.md](ROADMAP_1_0.md)  
**Open engineering review:** [W11 Issue #93](https://github.com/sjevans1/Workspace-Platform/issues/93)  
**Human-facing ChatGPT project:** *Workspace Platform — Product Development*; creation and chat migration must be done by the ChatGPT account owner in its sidebar.

> This document is a navigation and governance hub, NOT evidence that unmerged features are shipped. Confirm **live GitHub PR head, `main`, Actions completion and exact SHA** at the start of every session. Some dated notes below can become stale.

## 1. Product charter and boundaries

**What we are building:** A commercially deployable, independent, self-hosted/white-label, multi-tenant, Notion/AppFlowy-inspired workspace. It must work with no AI, external SaaS, paid editor, external object-store subscription, or separately installed OpenJM Enterprise AI service. Core journeys: workspaces/spaces/pages and internal links, collaborative rich editor, comments, databases and views, search, permissioned files, import/export, identity/SCIM/SSO, audit/operations and recoverable deployment.

**Do not cross-contaminate:** `sjevans1/OpenJM-Enterprise-AI` is a separate app and repo. Do not modify its code or use its database, secrets, sessions, services, or ports. An **optional**, off-by-default adapter to its permission-aware APIs/events is a later distinct versioned integration. No normal Workspace feature may depend on AI availability.

**Implementation baseline:** TypeScript, React/Next.js, BlockNote Core behind app-owned extension/serialization, Yjs + Hocuspocus, PostgreSQL with tenant FORCE RLS and restricted runtime role, Caddy, local encrypted file storage (optional S3-compatible object storage), worker/queue and observability. App must be runnable and tested—not mockups.

## 2. Executive status — actual acceptance, not a percentage estimate

At the last full review on 2026-10-04:
- **Accepted release packages:** W01, W05, W06, W07 = **4/28 package checkboxes** in Issue #62. The 28 packages vary substantially in size; **do not interpret 4/28 as percent of code or effort complete**.
- **Substantial implemented-but-open work packages:** W08, W09, W10, W11. Many accepted sub-PRs exist, but final package acceptance has not been earned.
- **Other release packages:** W02–W04, W12–W28 still open/ungated in the authoritative roadmap. Some foundation capabilities already exist—do not call them entirely unbuilt.
- **Main baseline:** `dd356648001befc696be83a72bcfcbe4b243de49`, resulting from accepted [PR #115](https://github.com/sjevans1/Workspace-Platform/pull/115) (canonical, revision-bound comments; native 112/112, deployed E2E, accessibility, TLS/security all passed on PR exact head).
- **Previously accepted collaboration:** [PR #113](https://github.com/sjevans1/Workspace-Platform/pull/113), merged at `15df67ddb86f834684eb0dc40f3597cc29782877`. Deterministic native structural reservation and two real-principal move/delete convergence passed its exact-head full CI.
- **Current draft PR #116 (W11b):** `a75f96b2694476ab9eaca5f811f38c5495bacabb`. UI to comment on specific BlockNote blocks, orphan labels, jumps and draft preservation; backend **and deployed CI SUCCESS** on exact head [#37223497411](https://github.com/sjevans1/Workspace-Platform/actions/runs/37223497411): 34 Chromium browser passed / 1 intentionally skipped, 4 accessibility tests, 1 trusted HTTPS/WSS, release/security tests. Both W10c4b two-editor quote placement and the new W11b anchored/orphan/draft journey passed. **Still draft/unmerged**; a green candidate run does not retroactively green the prior failed main run.
- **Current draft PR #117 (W11c):** `14b913c15b9b95dafa5b6b2e390bd44e974c70dc`. Strict same-resource, tenant-bound comment-reply FK; inherited anchor and root-only reply checks; exact-head backend [#37223825252](https://github.com/sjevans1/Workspace-Platform/actions/runs/37223825252) **113/113 passed**; full deployed CI not yet confirmed at last check. Do not confuse backend success with release acceptance.
- **Regression to investigate now:** post-merge `main` run [#37223423379](https://github.com/sjevans1/Workspace-Platform/actions/runs/37223423379) had backend PASS but deployed browser **FAIL** in W10c4b: expected `Beta baseline Beta from editor two`, saw input interleaved/split around the baseline. The observed text suggests a caret/selection timing issue or an actual editor integrity problem; **do not label it harmless flakiness without proving where canonical content landed and survives**. No further release merges if the relevant integrity scenario is not accounted for.

**Do not merge #116 or #117 on the basis of prior/partial CI.** Reconcile them against up-to-date `main` one at a time, with independent exact-head checks.

## 3. What has been delivered — historical review

### Foundation (Sept 28 – Oct 1)
- Standalone repo and build handoff created; separate local ports from OpenJM Enterprise AI and the local model, including Keycloak port `18081` (avoid `18080` used elsewhere).
- Tenant-aware PostgreSQL RLS/ACL foundations, sessions, owner/admin/member/guest scopes, deployment OIDC/Keycloak real sign-in and back-channel logout regression pass.
- SCIM Users/Groups, offboarding and role mapping; encrypted tenant-provider registry/configuration in **disabled state** (full tenant IdP login still NOT activated).
- Encrypted local/S3-compatible storage, signed events/webhooks and audit, backups/restore tests, malware-scanning/CI gates.
- Appearance themes, personal Recently Viewed, internal page links and ACL-filtered backlinks; preserved during merge/reconciliation.

### Structured product and rich authoring (Oct 1 – Oct 4)
- **W01 accepted:** trusted proxy attribution and principal-scoped rate limiting.
- **W05–W07 accepted:** relation fields; safe formula evaluation; permission-filtered rollups.
- **W08 sub-slices accepted:** permission-safe pagination, encrypted keyset, mixed ascending/descending cursors, real 10k rows/25-session native benchmarks; W08 still open pending live-reordering semantics and named-host capacity qualification ([#80](https://github.com/sjevans1/Workspace-Platform/issues/80)).
- **W09 sub-slices accepted:** CSV read-only preview and typed map, append-only existing database import, retry-safe idempotency; W09 still open pending ACL-safe dedupe/upsert, interrupted jobs, bounded streaming exports ([#87](https://github.com/sjevans1/Workspace-Platform/issues/87), [#88](https://github.com/sjevans1/Workspace-Platform/issues/88)).
- **W10 sub-slices accepted:** Core formatting, custom callout/divider; quote/code/table, safe HTML paste, stable Yjs versions/restore; two-editor synced rich edits, permission downgrade and structural actions; private image/file attachments and encrypted backup recovery; phone/tablet touch matrix. W10 remains open for robust whole-matrix acceptance, same-block undo/partition/reconnect/in-flight-revocation and media handling.
- **W11a accepted:** comment POST checks authorization, canonical block UUID, Yjs state and revision with SQL row lock; no forged foreign/stale anchor; ordinary unanchored discussions preserved. W11 remains open.

## 4. Roadmap register — W01–W28

Codes are stable **work-package identifiers**, not PR numbers. A package is **accepted** only when the release tracker checkbox is checked and exact final-head tests have passed.

| Lane | Work packages | Package status, outstanding proof |
|---|---|---|
| Identity / security | **W01** trusted proxy, principal rate isolation | **Accepted** |
| Identity / security | **W02** tenant-provider login; **W03** session provenance/logout; **W04** account recovery/invites | **Open**; T2/T3a registry/state foundation exists, live tenant SSO not enabled. Start with [Issue #38](https://github.com/sjevans1/Workspace-Platform/issues/38). |
| Data | **W05** relations; **W06** formulas; **W07** rollups | **Accepted** |
| Data | **W08** query/pagination scale; **W09** CSV lifecycle | **Partial**; live ordering vs snapshot policy, host capacity; CSV governed updates, cancellation/crash, large export |
| Authoring | **W10** full editor release matrix; **W11** anchored comments/mentions | **Partial**; W10c4b main regression and stress matrix; W11b/W11c draft acceptance and W11d two-user/revoked actor UX |
| Product | **W12** notifications; **W13** indexed backlinks; **W14** safe indexed search; **W15** templates; **W16** mobile/keyboard polish; **W17** workspace bulk portability | **Open**; existing notification, backlinks, search, theme, mobile and export foundations are not the complete scoped feature |
| Resilience | **W18** interrupted drafts; **W19** reconnect/collaboration reliability; **W20** leased event outbox; **W21** reconcile API; **W22** typed/versioned API; **W23** automated backup/upgrade; **W24** performance/sizing | **Open**; some restore/metric/reconciliation foundations exist, but operational acceptance not complete |
| Ship | **W25** WebKit/WCAG; **W26** white-label install/admin; **W27** fleet-wide security/privacy/licensing; **W28** independent-host release candidate and 1.0 tag | **Open**; note [#112](https://github.com/sjevans1/Workspace-Platform/issues/112): app+ClamAV scans do not alone prove all shipped infrastructure images covered |

### Not in 1.0 unless scope explicitly changes
Full offline-first multi-device sync; horizontally scaled multi-writer/region failover; built-in AI/LLM dependency; full Notion/AppFlowy feature parity; native mobile application; unrestricted workflow automation; every editor block extension. See roadmap's X-items.

## 5. Forward sequence / release gates

**Wave A — stabilize current changes and stop the known integrity regression (P0)**
1. Record PR #116 exact-head [CI #37223497411](https://github.com/sjevans1/Workspace-Platform/actions/runs/37223497411) **SUCCESS** and secure final outcome for PR #117 CI `37223825252`; do not infer unfinished CI completion.
2. Investigate W10c4b quote/callout split in actual server canonical persisted blocks vs DOM/selection; reproduce 2 principals, both typing orders, scoped undo/redo, reload, revocation.
3. Fix actual data-integrity defects if found; otherwise retain exact-block DOM caret tests and gather objective persisted Yjs evidence. PR #116's exact-head full CI is GREEN; keep original canonical identity/undo regression and verify on post-merge main, never mute E2E.
4. Merge **only exact-head successful** PRs with expected-SHA guard, no unresolved reviews, full real deployment/browser/accessibility/security/TLS; run post-merge `main`. Merge #116 and #117 in a conflict-reconciled sequence.

**Wave B — complete W11, finish previous subpackages**
5. W11d: visible root/reply thread hierarchy, named author, resolve/reopen, mentions suggestion, keyboard/touch, 2 real users, orphan/recreate/restore, revoked-user zero-disclosure; full acceptance.
6. W10: Core advertised block matrix and robust reconnect/undo/data-loss test plan; W08 decision on live browsing vs pinned revision; W09 safe upsert, interruption and export.
7. Close W10/W11/W08/W09 package checkboxes only when their explicit acceptance criteria, measured hardware constraints and docs are met.

**Wave C — foundational security and usable product completeness**
8. W02 → W03 → W04 tenant IdP real two-issuer/Keycloak lifecycle and recovery; preserve deployment OIDC and local break-glass.
9. W12 notification center → W13 permission-indexed backlinks → W14 safe search → W15 templates → W16 mobile/accessibility UX → W17 portable export/import.

**Wave D — production qualification and 1.0**
10. W18/W19 interrupted-edit recovery and real fault injection, W20–W22 reliable outbox + reconciliation/API contracts.
11. W23/W24 independently hosted recovery, migration/upgrades and measured capacity; W25 WebKit/WCAG; W26 white-label installer.
12. W27 complete images/third-party licensing/secrets/security/privacy review; W28 independent customer-like RC, published support matrix, no open P0 defects, signed 1.0 tag.

## 6. Engineering operating protocol

- **Repository and scope:** operate ONLY `sjevans1/Workspace-Platform`. Never mix code or databases with `OpenJM-Enterprise-AI`.
- **Read first:** this hub, [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62), the focused W issue, `docs/ROADMAP_1_0.md`, `docs/ACCEPTANCE.md` and fresh branch/PR heads. Historical conversation assertions are leads, not branch authority.
- **One active merge-target PR**; isolated non-overlapping prep branches permitted with explicit dependencies and scheduled rebase. Avoid avoidable CI churn. Break large changes into independently testable vertical slices.
- **P0 rules:** no silent data loss, no permission bypass, no secrets in public repo, no CI assertion weakening, no untested production-image changes. Backward compatibility and DB migration recovery required.
- **Definition of done:** evidence for native restricted PostgreSQL/RLS, TypeScript/build, real deployment/browser, accessibility, file security/malware, SBOM/Trivy, trusted HTTPS/WSS, exact-head green CI. Recheck reviews, PR diff, mergeability and post-merge `main`.
- **Continuity:** each session records summary, changed files, exact SHA, PR links, final CI IDs and **completed / in progress / blocked** labels. Never imply background/asynchronous progress or a passed gate before observed.
- **Statuses:** `Accepted` = merged + proven; `In review` = exact-head green, approval pending; `In flight` = code pushed/CI pending; `Blocked` = defect or prerequisite; `Planned` = no accepted implementation.

## 7. ChatGPT Project consolidation — owner action

**Recommended ChatGPT Project:** `Workspace Platform — Product Development`.
The assistant's GitHub connectors **cannot** create account-level ChatGPT Projects or move chat-history entries. Use ChatGPT sidebar **New project**, then each eligible chat `••• → Move to project` (or drag), and `Project settings` to paste [CHATGPT_PROJECT_INSTRUCTIONS.md](CHATGPT_PROJECT_INSTRUCTIONS.md). Search by both title and “Workspace”; historical chat titles may vary.

Candidate historical chats (move if primarily about this standalone Workspace):
- *Open Source Workspace Comparison*; *Create GitHub Repo* (Astra handoff/build, Sept 28).
- *Workspace Handoff Continuation*; *Continue SCIM Groups Handoff*; *SCIM Handoff Status*.
- *Move On*; *Continue Move On Work*; *Check in* (inspect context).
- *Merge PR 61 Verification*; *Workspace Build Checkin*; *Continue Workspace Build*.
- *Build Workspace Platform*; *Continue workspace platform development*.
- *Checking in* and other Oct 1–4 Workspace-specific continuation chats; move **this current conversation** too when useful.

**Mixed or ambiguous chats — review first, do not indiscriminately migrate whole conversations:**
- *Compare Local Ports* covers both Workspace and the separately scoped Enterprise AI repo; preserve the boundary/port decision in this hub, but do not assume the whole conversation belongs.
- *Resume Phase E Prompt*, *GitHub Memory Debugging*, *Open Source LLM RAG Platform*, *OpenJM Enterprise AI* coding threads primarily belong to the Enterprise AI project; only Workspace-specific decisions should be captured in summaries, not mistaken for Workspace code.

**Project memory tradeoff:** project-only memory isolates conversation context but can restrict access to ChatGPT Work; choose deliberately in Project settings. The repo isolation rule applies regardless of memory mode. For ongoing GitHub execution, a default-memory project with strict repo-specific project instructions may be more functional; avoid pulling unrelated OpenJM code or assumptions.

## 8. Weekly project operating review

At each checkpoint post: **main HEAD**, open PRs and SHA, exact-head CI, issue changes, accepted W packages, unaccepted slices, risks, next 3 deliverables, and any decisions required. Use [Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62) for authoritative completion checkboxes. This hub should be refreshed only on significant milestone/boundary changes; don't append stale chronological noise endlessly.

**Current decision log:** maintain standalone product; local encrypted storage mandatory (S3 optional); tenant RLS and permission-first visibility; no cross-contamination; data integrity before UI scope expansion; W10/W11 acceptance before claiming collaboration/comments release quality; real host acceptance before 1.0.
