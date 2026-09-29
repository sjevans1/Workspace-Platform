# Build checkpoint

Updated 29 September 2026. Repository: https://github.com/sjevans1/Workspace-Platform

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

## First-pass completion and future work

This first-pass build and verification are complete. The runtime is an alpha, not the full production MVP. No customer host or production Intelligence deployment has been configured. Use README.md and OPERATIONS.md to run it locally or deploy it on a selected host.

The next acceptance phase is a customer-like evaluation on a TLS-enabled host, including live permission revocation, object-store backup recovery and migration recovery. Follow the explicit remaining-work table in ACCEPTANCE.md; identity/SSO, retention, operational hardening and wider browser/accessibility coverage remain.

## Continuity and execution notes

All durable source belongs in this GitHub repository. Commit tested increments and update this checkpoint before any pause. Do not depend on temporary local files or conversational tool stores. Local Chromium cannot launch in the managed execution environment; use GitHub Actions for browser and Docker verification. Local tests use PGlite; CI uses native PostgreSQL. Run shell commands with bash and login disabled. Git fetch works, but authenticated publication uses the GitHub connector tree/commit/ref tools; preserve local edits when aligning with the published head. Never reset hard.
