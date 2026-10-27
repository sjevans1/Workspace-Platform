# Repository handover sanitization record

**Scope:** proposed handover change prepared 2026-10-26 against `main@aa89038e998b8fade973557285501ff2d5efa826`. This is a reviewable PR, not history rewriting.

## Included in this PR

- Replace obsolete README onboarding text and stale alpha "latest CI" claim with current team entrypoints and a measured release-status boundary.
- Replace obsolete chronological build handoff with a neutral acceptance/evidence index; update old acceptance claims that otherwise masquerade as the latest state.
- Rename host/SSO validation runbooks as neutral engineering procedures and remove obsolete maintainer-execution instructions, including the production object-store acceptance footer.
- Remove the retired event-driven CI orchestration utility and its dedicated tests/templates; remove its CI test calls and npm script. Production product workers, connectors, workflows, queues and webhook handling are **not** removed.
- Remove the tracked developer-local `.next` symlink (absolute host path) and ignore both file/symlink and directory forms.
- Retain third-party licenses, SBOM, RLS/security/operations runbooks and original technical evidence references.
- Preserve product runtime, issues, deployment configuration and release-approval gates. The separate draft PR #236 was closed without merge, and the proposed CI documentation in #238 and descriptions for #237/#238 were made tool-neutral; no CI changes from those PRs are on `main`.

## Additional scrub review

- Completed a follow-up scan of the 79 tracked Markdown documents, the repository CI/build/maintenance scripts and 186 application/package/test source files. Corrected the old acceptance-runbook link in `docs/OPERATIONS.md` and removed unnecessary coding-assistant attribution from the W27 image evidence metadata; retained publication run, image digests and upstream source details.
- Old PR comments, Git commit history, archived action logs and previously published branch contents are not removed by this working-tree cleanup. Internal-process draft #236 is closed but its obsolete branch should be deleted by the repository owner when safe. The independent review must validate the final exact-head changes before merging.

## Verification required on PR

- Diff: check deleted files are exclusively retired tooling and renamed historical runbooks, not product services.
- Static: `npm run typecheck`, `npm test`, `npm run build`, current FAST CI; verify no code imports the retired bridge.
- Repository: `git ls-files .next tools/ci-orchestrator docs/CI_EVENT_ORCHESTRATION.md` should return no tracked files after this PR; `git check-ignore .next node_modules` should match both.
- Docs: ensure README/runbook relative links resolve and the new handover/README contain no user-specific credentials, private URLs or obsolete internal workflow instructions.
- Future real-provider activation still requires deployment-scoped egress #234 and the correct release qualification.

## Limitations and explicit exclusions

Removing content from the current branch does **not** erase old commits, closed PR descriptions, Actions logs, external hosts or cached clones in this public GitHub repository. If the product owner needs provenance or sensitive historical information purged, assess that separately with repository administrators; rewrite history only under a coordinated security procedure with rotation of any exposed secrets. This PR is not a certified full-secret scan of every commit, artifact or external environment. No production credential rotation is claimed.
