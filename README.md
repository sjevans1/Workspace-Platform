# OpenJM Workspace

Self-hosted, white-label workspace for shared knowledge, collaborative documents, structured databases, governed connections and deterministic work. Workspace is a standalone product: OpenJM Enterprise AI, LLMs, external SaaS accounts and cloud object storage are **not** required for core operation.

**Maintainer starting point:** [OpenJM Development Team Handover](docs/TEAM_HANDOVER.md) · [Development guide](docs/DEVELOPMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Operations](docs/OPERATIONS.md) · [Release gates](docs/RELEASE_1_0_FINAL_GATES.md).

**Release status (26 October 2026):** Working application, **not yet approved or tagged as Workspace 1.0**. W01–W28 provide accepted baseline evidence; W29 Connected Work and W30 deterministic workflows were promoted into 1.0. The provider-neutral connector and workflow foundations are merged, but real-provider production readiness, end-to-end feature completion, final NVDA testing and W31 release requalification remain gated. Read the live [roadmap issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62) and [handover snapshot](docs/TEAM_HANDOVER.md) before acting on historical implementation notes.

## Local development

Use **Node.js 24** and npm with the committed lockfile (CI also uses Node 24); Docker with Compose is needed for deployed validation. On Windows, WSL2 is supported for development.

```bash
git clone https://github.com/sjevans1/Workspace-Platform.git
cd Workspace-Platform
npm ci
npm run dev
```

Visit http://localhost:3000. First-run setup creates a unique local setup token; create an administrator through the setup flow. Development persists PGlite data under `.data/`. Do not use development configuration for customer production.

## Local Docker evaluation

```bash
node scripts/init-env.mjs
docker compose up --build -d
```

Visit http://localhost:8080 on the trusted local machine. Use the generated setup token from `.env`. Before remote access, set a correct `APP_URL`, TLS and cookie security as detailed in [operations](docs/OPERATIONS.md). Never commit `.env`, secrets, backups or customer records.

## Project layout

| Directory | Responsibility |
|---|---|
| `apps/web` | Next.js user-facing workspace |
| `apps/api` | Fastify API and authorization |
| `apps/collab` | Yjs / Hocuspocus live collaboration |
| `apps/worker` | Background work and deterministic execution |
| `apps/fleet`, `apps/fleet-web` | Optional, separately governed operator fleet service and console |
| `packages/` | Domain contracts, database, authorization, editor, storage, connectors, automation |
| `infrastructure/` | SQL migrations, proxy and runtime infrastructure |
| `tests/`, `e2e*/` | Native, browser and deployment acceptance |
| `docs/` | Design contracts, operations, security evidence and acceptance |

## Verify a change

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Native and browser tests require the environment documented in [Development](docs/DEVELOPMENT.md). GitHub Actions is the acceptance authority for release-class verification. The [FAST / STANDARD / FULL](docs/CI_TIERS.md) tiers have different purposes; a green FAST build alone is not release acceptance.

## Operating principles

- Tenant identity and permissions are authoritative on the server and checked at use time. Never bypass row-level security or rely on UI-only restrictions.
- External connections are optional and off by default. The customer owns provider credentials and usage charges; no unrestricted provider access.
- Workflow execution is deterministic, auditable, idempotent and subject to current authority, approvals and retry limits; an LLM is not required.
- Backups, restores, migration checksums, HTTPS/WSS, scanner readiness, storage modes and release-image security remain non-negotiable acceptance gates.
- Changes go through reviewed PRs with exact-head CI evidence and explicit merge/release authorization. Do not merge open feature PRs as part of documentation housekeeping.

See [contribution policy](CONTRIBUTING.md), [team handover](docs/TEAM_HANDOVER.md), [connected work architecture](docs/CONNECTED_WORK_ARCHITECTURE.md), [automation architecture](docs/AUTOMATION_ARCHITECTURE.md), [identity](docs/IDENTITY.md), [accessibility](docs/ACCESSIBILITY_ACCEPTANCE.md) and [license inventory](THIRD_PARTY_LICENSES.md).
