# Contributing to OpenJM Workspace

Start with [Team Handover](docs/TEAM_HANDOVER.md) and [Development](docs/DEVELOPMENT.md). The product owner or designated maintainer sets scope; the implementation team preserves existing acceptance contracts.

1. Create a short-lived branch from an approved current base. Link the parent issue and state scope, customer-visible behavior, authorization changes, data migration effects, rollback and tests.
2. Keep the product usable without optional connectors or AI services. Treat cross-tenant data access, current-permission rechecks, secrets and irreversible external actions as high-risk surfaces.
3. Implement the user journey and automated regressions together. Validate role-specific states, confirmation before destructive changes, empty/error/loading states, responsive and accessible interaction.
4. Run `npm run typecheck`, focused native tests and `npm run build`; require the proper GitHub Actions FAST/STANDARD/FULL tier for the change. Do not relax tests or silently skip failing acceptance.
5. Submit a PR with exact commit SHA, verification run links, migration/deployment notes, residual risks and a review checklist. A green workflow does not itself authorize merge.
6. Require human owner or delegated reviewer approval before merging. Release requires the additional gates in [Release 1.0](docs/RELEASE_1_0_FINAL_GATES.md).

Never include real customer records, personal tokens, passwords, connection secrets, credential dumps, unredacted support bundles or workstation-local paths in repository files, examples, logs or PR descriptions. Use fixtures and explicit placeholders. Update the applicable technical docs, not just the code.
