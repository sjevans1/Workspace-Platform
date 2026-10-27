# Development guide

## Environment and commands

- CI and production build use **Node.js 24**. `package.json` currently declares `>=22`; use Node 24 locally to match the release build.
- From repository root: `npm ci`, `npm run dev` (web/API/collab/worker), `npm run typecheck`, `npm test`, `npm run build`.
- For deployed evaluation: `node scripts/init-env.mjs`, then `docker compose up --build -d`. Do **not** run restore/cleanup commands against production or shared volumes.
- Browser: `npx playwright install chromium`, `npm run test:e2e`. Separate suites: `npm run test:visual`, `npm run test:harness`, `npm run test:harness:fleet-console`.
- Development PGlite persists under `.data/`; backend native PostgreSQL requires a disposable `TEST_DATABASE_URL` with permissions to create/drop test databases. CI uses PostgreSQL and a private S3-compatible test endpoint. Never use customer databases/buckets for tests.
- Consult [OPERATIONS](OPERATIONS.md) for HTTPS/WSS, storage choice, backups, encryption keys, SSO and operational monitoring.

## How to modify the system

1. Read the issue and user journey; identify tenant boundaries, affected roles, database migrations, external-provider impacts, audit events and UI states.
2. Implement server-side authorization and RLS-compatible transactions before exposing actions. Do not rely on UI-only checks; new migrations must be append-only and checksum-safe.
3. Use existing editor, database, connector, workflow and UI components rather than a parallel subsystem. New controls need explicit apply/confirmation for security-relevant state changes.
4. Add native tests for happy path, tenancy, revoked access, concurrency, retries, unknown IDs and malformed input. Add browser tests for the actual end-to-end user journey and responsive/accessibility states.
5. Run focused tests, `npm run typecheck`, `npm test` where practical and `npm run build`. Do not accept an unchecked generated integration client; `typecheck` verifies it matches the OpenAPI source.
6. Open an issue-linked PR with tested SHA, evidence and remaining risks. Follow [CI_TIERS](CI_TIERS.md); accept only exact-head runs and explicit review. Never weaken existing release gates to meet a date.

## CI and merges

- Current `.github/workflows/ci.yml`: FAST runs on PRs; STANDARD backend and FULL deployment require the trigger conditions in the workflow. Do not assume proposals in open PRs #237/#238 have already changed this.
- PR #190 proposes an Ubuntu/action refresh; until merged, `ubuntu-latest` remains in the checked-in main workflow. Node 24 is already configured.
- Verification results belong to the commit tested, not an earlier ancestor. Merge conflicts/rebases invalidate some prior evidence; rerun the applicable gate.
- Never merge on green checks alone. Reviewer approval and release-owner signoff are separate controls.

## Architecture entrypoints

| Concern | Starting point |
|---|---|
| UI | `apps/web/components/`, `apps/web/app/` |
| HTTP/API/security | `apps/api/src/app.ts`, `apps/api/src/domain.ts` |
| Tenant identity/SCIM | `packages/auth/`, `apps/api/src/scim.ts`, `docs/IDENTITY.md` |
| Data/RLS/migrations | `packages/database/`, `infrastructure/` |
| Collaborative editor | `apps/collab/`, `packages/editor/` |
| Connected Work | `packages/connectors/`, `apps/api/src/connected-work.ts`, `docs/CONNECTED_WORK_ARCHITECTURE.md` |
| Workflows | `packages/automation/`, `apps/worker/src/connected-work.ts` |
| Storage/security | `packages/storage/`, `docs/FILE_SECURITY.md` |
| Ops and Fleet | `apps/fleet/`, `apps/fleet-web/`, `docs/OPERATIONS.md` |

Read actual module paths if these directories change. The repo contains detailed security and acceptance notes; preserve the evidence when refactoring.

## Handling secrets and evidence

Generated `.env`, `.data`, backups, real tenant exports, support bundles, tokens, raw cookies, customer screenshots and private network details do not belong in Git. Use anonymized test fixtures. Keep release evidence linked from CI or approved secured storage, with SHA and run ID. The Git history is public and may contain older development records; see [SANITIZATION_AUDIT](SANITIZATION_AUDIT.md).
