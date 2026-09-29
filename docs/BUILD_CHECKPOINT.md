# Build checkpoint

Updated 29 September 2026. Repository: https://github.com/sjevans1/Workspace-Platform

## Scope and authorization

Build the self-hosted OpenJM Workspace first pass from the Astra handoff. The user authorized implementation and GitHub commits/pushes, and requested incremental checkpoints to preserve continuity. Keep working without unnecessary confirmation. This is an executable alpha; see ACCEPTANCE.md for unfinished MVP requirements. Do not use Sites or connect a production Intelligence deployment without its configuration.

## Published baseline and evidence

Code baseline: `c311936800e97891481db08b17bfeeb6170ba91a`.
CI: https://github.com/sjevans1/Workspace-Platform/actions/runs/36574350190

- Backend job passed: 23 native PostgreSQL tests, TypeScript and production build.
- Docker image built; migrations, PostgreSQL, Valkey, API, collaboration, worker, web and Caddy started; readiness passed.
- Browser scenario passed setup, page creation, typed content persisted to the API, two independent browser sessions, shared edits, reload, comments, history, Markdown export, table editing and board movement.
- The final mobile check stopped because the desktop sidebar remained open after viewport resize and covered the header toggle. This checkpoint changes the test to close the visible sidebar using its own close button, then reopen it with the header toggle before navigating Home. Full browser acceptance is still pending the next run.

## Fixes already persisted

- BlockNote 0.55 requires `withCollaboration` from `@blocknote/core/yjs`; a plain collaboration option was silently ignored. The editor now uses the adapter. The browser test explicitly verifies API content before starting the second session.
- Collaboration shutdown tracks and disposes idle documents and failed loads, preventing abandoned awareness timers.
- Database shutdown waits for client socket end events after pool shutdown. Test databases are dropped without FORCE.
- Trash traversal skips already-deleted descendants; numeric filters use numeric comparisons; record title limits match resource limits.
- Docker excludes generated Next.js type references and defaults host bindings to loopback. HTTPS instructions include an explicit public bind address.

## Next actions

1. Inspect the CI run triggered by this commit; fix remaining browser failures if any.
2. Download browser artifacts and visually inspect home, editor, table, board and mobile screenshots.
3. Update ACCEPTANCE.md with observed results and the successful run link; save selected screenshots in the repository.
4. Commit/push the report and verify repository state. Report the usable alpha and remaining MVP boundaries honestly.

## Continuity and execution notes

All durable source belongs in this GitHub repository. Commit tested increments and update this checkpoint before any pause. Do not depend on temporary local files or conversational tool stores. Local Chromium cannot launch in the managed execution environment; use GitHub Actions for browser and Docker verification. Local tests use PGlite; CI uses native PostgreSQL. Run shell commands with bash and login disabled. Git fetch works, but authenticated publication uses the GitHub connector tree/commit/ref tools; preserve local edits when aligning with the published head. Never reset hard.
