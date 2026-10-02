# Workspace repository hygiene — audit 2026-10-01

**Repository:** [sjevans1/Workspace-Platform](https://github.com/sjevans1/Workspace-Platform)  
**Scope:** Branches, PR state, release tracking, and stale acceptance documentation.  
**No changes** to the independently deployed `OpenJM-Enterprise-AI` repository.

## Verified baseline

Before the maintenance branch was created, the repo had **28 remote branches**: one `main`, 25 tied to **verified merged PRs**, one active feature branch, and one closed-but-unmerged archival source branch.

| Preserve | Reason |
| --- | --- |
| `main` | Workspace production integration branch; baseline `9070518b493a3224c56041e5da190ab5bbc2d48f`, W07 accepted. |
| `feature/w08-visible-page-regression-prep` | **Active [PR #70](https://github.com/sjevans1/Workspace-Platform/pull/70)**, draft and unmerged. Preserve all ongoing work/CI. |
| `feature/oidc-tenant-state-provenance` | **Closed but unmerged [PR #42](https://github.com/sjevans1/Workspace-Platform/pull/42)**. Contains T4 OIDC provenance and backup-restore ordering changes that may not yet be incorporated. Keep until a separate verified implementation/recovery decision. |

All 25 proposed deletion candidates are individually recorded in [the immutable-head manifest](../maintenance/merged-branch-prune-2026-10-01.json) with their **merged PR number** and the exact audited **40-character branch SHA**. Historical GitHub commits and merged PRs remain accessible after the branch reference is deleted.

## Fail-closed cleanup design

The narrow maintenance workflow [`audited-merged-branch-prune.yml`](../.github/workflows/audited-merged-branch-prune.yml) performs read-only unit tests and manifest validation on its PR. **No branch deletion can run from a pull request.**

After a reviewed, green maintenance PR merges to `main`, the manifest-path-filtered `push` event runs a one-time cleanup under `contents:write`; the job does not accept arbitrary branch names or a generic query. For each candidate [`prune_merged_branches.py`](../scripts/maintenance/prune_merged_branches.py):

1. Verifies the expected Workspace repository and main-branch runner context.
2. Validates the fixed 25-record manifest and the explicitly protected branches.
3. Loads the current **open PR** inventory and refuses to delete any branch still used by an open PR.
4. Refuses deletion if the ref's current SHA differs from the manifest.
5. Fetches the exact historical PR and checks `state=closed`, a nonempty `merged_at`, matching same-repo head name and SHA, and `base.ref=main`.
6. Deletes the named `refs/heads/...` branch only after every gate passes, then verifies that the ref is absent.
7. Logs deleted, skipped and failed counts without printing credentials.

A changed branch, missing ref, unmerged PR, protected head, API error, or permission denial is a **safe skip or failure**, never a reason to force-delete or rewrite history. Cleanup runs only in the standalone Workspace repository; no force pushes, source edits, data deletion, CI rate-limit changes, or pruning of user files.

### Post-merge verification

Check **Actions → Audited Workspace merged-branch cleanup** for the push-triggered run and its `SUMMARY: deleted=..., skipped=...` log. Re-run `search_branches`/GitHub **Branches** and confirm `main`, active W08, protected OIDC #42, and the maintenance branch remain. The maintenance branch itself may be removed later after a distinct reviewed action; it is intentionally *not* included in the immutable manifest because its PR final SHA was unknown during the audit.

If GitHub organisation policy blocks the scoped Actions token from deleting refs, the job will fail closed. No permission escalation, broad PAT or emergency force push is justified; use GitHub's **Branches** UI to delete only these PR-merged, SHA-verified branches instead.

## Roadmap and document reconciliation

- [Central 1.0 tracker #62](https://github.com/sjevans1/Workspace-Platform/issues/62): W01, W05, W06 and W07 **accepted/merged**; W08 remains open and must complete separate exact-head full regression.
- [W07 PR #69](https://github.com/sjevans1/Workspace-Platform/pull/69) merged `9070518b493a3224c56041e5da190ab5bbc2d48f` after successful backend **78/78** and full deployed Actions [run 36942830305](https://github.com/sjevans1/Workspace-Platform/actions/runs/36942830305).
- There is **one open PR (#70)** according to the repository's PR search at this audit. Do not close or merge it as part of housekeeping.
- Relevant open issues: #38 (tenant SSO), #62 (roadmap) and #68 (W08). Closed #42 is a **PR**, not a completed feature. No additional duplicate issue/PR creation is needed for cleanup.

**Hold point:** Work on W08 must remain paused until branch cleanup is accounted for; cleanup must not cause a merge of any feature PR.
