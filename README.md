# OpenJM Workspace

A self-hosted, white-label workspace for shared knowledge, collaborative pages and structured work. Built from the OpenJM Workspace Astra handoff as an executable first pass.

**Status: working alpha, not the completed production MVP.** The backend, collaboration protocol, tenant isolation and backup round trip have automated coverage. See [acceptance status and remaining work](docs/ACCEPTANCE.md) for the exact verification boundary.

[Verified CI run](https://github.com/sjevans1/Workspace-Platform/actions/runs/36611129995): 23 native PostgreSQL tests, production build, Docker startup and the complete desktop/mobile Chromium workflow passed. [Build checkpoint](docs/BUILD_CHECKPOINT.md) records the durable handoff.

## Start locally

Use Node.js 24 and npm 11. On Windows, WSL2 is a convenient development environment.

```bash
git clone https://github.com/sjevans1/Workspace-Platform.git
cd Workspace-Platform
npm ci
npm run dev
```

Open **http://localhost:3000**. The terminal prints a first-run setup token. Create your own administrator account; there are no default passwords. Enable the starter content checkbox for a company wiki, project pages, leadership meeting and team task tracker.

Local development starts the API, collaboration server, worker and Next.js together. It uses a persistent PGlite PostgreSQL engine in `.data/dev-postgres`; it is a development convenience, not the production deployment. Keep the terminal running. Production uses native PostgreSQL and Valkey.

## Deploy with Docker Compose

```bash
node scripts/init-env.mjs
docker compose up --build -d
```

Open **http://localhost:8080** and use `SETUP_TOKEN` from the generated `.env`. This default is for a trusted local machine. Configure HTTPS and the correct `APP_URL` before allowing remote access. Full instructions: [installation and operations](docs/OPERATIONS.md).

## What is implemented

- Organisations, multiple workspaces, spaces, nested pages, favourites, search and trash.
- BlockNote Core editing, Yjs/Hocuspocus collaboration, presence, durable save acknowledgements and revision restore.
- Typed databases with table and board views, inline edits, filtering, sorting, column settings and records that open as full pages.
- Local authentication plus optional OpenID Connect/Keycloak SSO, invitation-backed SSO provisioning, roles, inherited page permissions, separate service principals and PostgreSQL tenant policies.
- Page discussions and mentions, private file attachments, Markdown/CSV imports and Markdown/CSV/JSON exports.
- Runtime branding, scoped REST API, transactional event outbox, signed webhooks with retries, and audit records.
- Local and S3-compatible storage adapters, migrations, logical backup/restore, container configuration and CI.

## Project map

| Path | Purpose |
|---|---|
| `apps/web` | Next.js workspace interface |
| `apps/api` | Fastify REST API and domain operations |
| `apps/collab` | Single-writer collaboration service |
| `apps/worker` | Outbox deliveries and import jobs |
| `packages` | Authentication, permissions, database, editor, storage, branding and contracts |
| `infrastructure` | SQL migrations and reverse proxy configuration |
| `scripts` | Development, backups and license inventory |
| `tests`, `e2e` | Backend, isolation, backup and browser acceptance checks |

## Verify

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The tests use isolated PGlite instances by default. Set `TEST_DATABASE_URL` to an administrative PostgreSQL connection to run them against native PostgreSQL; each test suite creates and drops its own temporary database. CI exercises native PostgreSQL, two browser sessions, and the Docker deployment.

- [Architecture and security boundaries](docs/ARCHITECTURE.md)
- [Identity and enterprise SSO](docs/IDENTITY.md)
- [API and Intelligence integration](docs/INTEGRATION.md)
- [Operations and restore procedure](docs/OPERATIONS.md)
- [Acceptance and known gaps](docs/ACCEPTANCE.md)
- [Third-party licenses](THIRD_PARTY_LICENSES.md) and [CycloneDX SBOM](docs/sbom.cdx.json)

No LLM, cloud account, managed database or paid editor package is required. The workspace can run independently and connect to an Intelligence module through its permissioned API.
