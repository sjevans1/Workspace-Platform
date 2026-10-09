# Workspace 1.0 — October 6 rebaseline and bundled delivery waves

Baseline: `main` at `6b7f60f422723ec19e8a5006f3033ab082d7e8b9` after W17 PR #158.

## Accepted through this baseline

The following roadmap packages are fully accepted at this checkpoint:

- W01 trusted-proxy/rate-limit principal isolation
- W05 permissioned database Relations
- W06 safe deterministic Formula properties
- W07 permissioned Rollups
- W13 indexed links/backlinks at scale
- W14 scalable permission-safe search
- W15 productized templates and safe duplication — PR #154, merge `8af55db81b0fd7c454b95bbfa68960a96c2e19b9`
- W16 mobile/navigation/keyboard finishing pass — PR #156, merge `e8864949b04a64a8c1ae86f4cd6d29e3406f6f13`
- W17 portable bulk workspace archive import/export — PR #158, merge `6b7f60f422723ec19e8a5006f3033ab082d7e8b9`, exact-head workflow 37531024966 SUCCESS on final head `13469db32b16fa03a17fa0511f81dac1624cdc29`

W15–W17 supersede older tracker text that still showed those packages unchecked.

## Remaining work philosophy

Do not implement the remaining W-IDs as 11 isolated sequential projects when several share the same runtime, failure model and acceptance harness. Bundle work into coherent delivery waves, while preserving each W-ID's explicit acceptance boundary so one weak area cannot be hidden by a large umbrella PR.

Workspace remains a standalone product. No mandatory OpenJM Enterprise AI runtime, repository, credentials, data, model or service dependency may be introduced.

## Wave R — resilience, collaboration and capacity

Primary packages: **W18 + W19 + the W24 capacity gates that directly qualify collaboration/offline behavior**.

This is the next implementation wave.

### R1 — durable interrupted-edit recovery (W18)

- Bounded device-local recovery for unacknowledged edits.
- Explicit draft lifecycle: pending, acknowledged, conflicted, discarded, expired.
- Never represent a local draft as server-durable until server acknowledgement exists.
- Encrypt or otherwise protect local recovery material appropriate to the browser storage model; bind it to workspace/resource/principal identity.
- Fail closed on tenant switch, logout/session expiry and ACL revocation.
- Recovery UX must distinguish “restore local draft” from canonical server history/version restore.
- Shared-device retention and cleanup policy must be documented.

### R2 — collaboration fault reliability (W19)

Exercise the same draft/replay substrate under:

- network loss/reconnect storms;
- writer process restart and lease loss;
- simultaneous editors on rich blocks;
- structural move/delete versus text edits;
- already-in-flight updates when permission is downgraded/revoked;
- history restore while clients reconnect;
- duplicate/replayed collaboration messages;
- session expiry and tenant switching.

Acceptance requires deterministic convergence or an explicit user-visible conflict outcome. Silent loss, resurrection of revoked content or stale-authority writes are release blockers.

### R3 — measured capacity qualification for this wave (W24-R)

Do not wait until the end of the project to discover that the reliability design fails under realistic load.

Qualify at minimum:

- 1, 5, 10 and 25 simultaneous editing/reconnecting sessions where feasible;
- API/collaboration/worker CPU and RSS;
- PostgreSQL connection/lock pressure and statement latency;
- reconnect completion and draft replay latency;
- collaboration writer backlog/health;
- attachment/AV impact where relevant;
- no cross-tenant or revoked-principal leakage during load.

This closes the W24 portions that depend specifically on W08/W10/W18/W19. W24 remains a distinct roadmap package until the later worker/integration/backup workloads are also qualified.

### Wave R merge strategy

Prefer **one integration wave with small reviewable commits and explicit phase gates**, rather than three independent long-lived branches.

Recommended phase order:

1. R0 acceptance harness/fault injector only.
2. R1 W18 local draft state machine and UI.
3. R2 W19 reconnect/revocation/writer-restart reliability.
4. R3 W24-R load/capacity evidence and tuning.
5. Exact-head full CI and deployed browser fault acceptance.
6. Merge only when W18 and W19 acceptance are independently evidenced; record which W24 criteria are closed.

If the diff becomes too large for safe review, split into sequential PRs from the same short-lived wave, but do not allow overlapping public integration PRs.

## Wave I — integration delivery reliability

Primary packages: **W20 + W21 + W22**, with W12 notification closure where the same delivery primitives apply.

- W20 lease-based outbox/webhook dispatch and crash-safe claim/ack/retry.
- W21 permission-rechecked current-state reconciliation for consumers after cursor loss/disconnect.
- W22 complete API schemas, generated typed client and an optional off-by-default example consumer.
- Reuse the worker fault harness from Wave R where applicable.
- Preserve current permission rechecks and signed cursor boundaries.

These belong together because they form one external-consumer consistency contract: event delivery, missed-event recovery, then typed client consumption.

## Wave O — operations, recovery and full-system capacity

Primary packages: **W23 + remaining W24**, with closure of W08/W09 operational-scale gates where applicable.

- Scheduled encrypted backup/rotation.
- Separate-host restore drills.
- Safe upgrade/rollback and migration failure drills.
- Durable import/export cancellation/crash behavior from W09.
- Named-host whole-stack capacity and sizing matrix.
- Worker backlog, object storage, antivirus and database pressure.
- Close residual W08 concurrency/capacity and W09 process-failure gates using the same evidence instead of duplicating load frameworks.

### Wave O closure (2026-10-09)

Wave O is closed for its W09 and W23/W24 scope.

- **W09 process reliability** was accepted in PR #169.
- **W09d governed keyed imports** accepted in PR #173 (merge `8e0126918c88c0eb237740f1b019aa4e25f1f529`, exact-head run `37898878592`; post-merge main run `37901677754` SUCCESS).
- **W09e durable, bounded database export** accepted in PR #177 (merge `c940de67fff37c3c94e0e3a3dfff5ee3d6ca8889`, exact-head run `37905292425`). Reuses the accepted lease/artifact/storage machinery; see [DURABLE_EXPORT.md](DURABLE_EXPORT.md) and the W09e section of [CAPACITY_1_0.md](CAPACITY_1_0.md).
- W23 scheduled backups/restore drill and the W24 whole-stack capacity qualification remain as recorded in their own accepted slices; the W09 process-failure and large-export gates are now closed.
- Residual **W08 live-reordering/named-host capacity** remains open and is not a W09 dependency.

## Wave X — experience and commercial packaging

Primary packages: **W25 + W26**, plus residual W02–W04/W10–W12 product-completeness items that must be user-visible for release.

- WebKit/Safari.
- WCAG/manual assistive-technology review.
- Deterministic visual regression using non-sensitive fixtures.
- White-label administration, branding validation and install profiles.
- Account recovery and optional invite email.
- Final package-level closure for editor/comments/notifications where resilience waves supply the missing evidence.

Identity/security work remains separately reviewable even if release acceptance is coordinated in this wave.

## Wave G — final governance and release

Primary packages: **W27 + W28**.

- Threat model and penetration/remediation gate.
- Exact release-image/SBOM/vulnerability policy.
- Privacy, retention and key/secrets rotation review.
- License/notices/corresponding-source packaging.
- Independent customer-like host release candidate.
- Fresh install, upgrade, recovery, two-user collaboration, DB workflows, import/export and backup/restore.
- Changelog/support matrix.
- Zero unresolved release blockers before the 1.0 tag.

## Earlier packages still formally open

The following packages have substantial accepted implementation but remain formally open because their final acceptance criteria overlap later waves:

- W02–W03 tenant IdP activation/provenance/logout.
- W04 account recovery and optional invite mail.
- W08 final live-reordering/named-host capacity acceptance.
- W09 crash-safe jobs, cancellation, governed upsert/dedupe and large streaming export. **Closed**: W09d (#173) and W09e (#177) accepted; process reliability accepted in #169.
- W10 final collaboration/media/revocation reliability.
- W11 comments/mentions package-level reconnect/revocation acceptance.
- W12 notifications package-level retention/pagination/revocation acceptance.

Do not rebuild accepted slices. Close these packages by satisfying their missing gates inside the appropriate waves above.

## Execution rule

Bundling is for shared implementation and test infrastructure, not for weakening accountability.

Every W-ID retains:
- explicit acceptance criteria;
- native PostgreSQL/RLS and adversarial tests where relevant;
- deployed user-flow acceptance;
- exact-final-head CI;
- a recorded closure decision in Issue #62.

No green exact-head acceptance = no merge.
