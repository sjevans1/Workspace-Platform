# Hermes real-host acceptance runbook

Use this runbook only on a disposable evaluation host or isolated WSL/Linux environment. Do not point it at a customer production database, production object bucket, or an existing Workspace volume.

## Objective

Independently verify that the current OpenJM Workspace build can be installed, started, accessed, backed up and recovered on a real host outside GitHub Actions. The test should validate host-specific behavior that CI cannot prove: Docker/WSL networking, TLS/LAN access, filesystem permissions, persistent volumes, service restart behavior and a separate-host restore.

The authoritative source is:

- Repository: https://github.com/sjevans1/Workspace-Platform
- Branch: `main`
- Start from the exact current `main` SHA reported by Git before testing.
- Do not modify source while running acceptance. If a defect is found, stop the affected phase, preserve evidence and report it for correction in the main engineering workflow.

## Safety boundaries

1. Use a fresh clone and fresh Docker volumes.
2. Do not reuse production credentials, production buckets or production PostgreSQL instances.
3. Never delete or overwrite the source deployment during a recovery test.
4. The recovery target must use a separate directory and **a different Docker Compose project name** as well as separate Docker volumes. The repository's `compose.yaml` has a fixed top-level `name: openjm-workspace`; a different directory by itself does **not** isolate the volumes. If using S3-compatible storage, use a separate empty recovery bucket.
5. Do not print or paste `.env`, setup tokens, passwords, encryption keys, cookies or bearer tokens into chat/log evidence.
6. Redact public IPs, internal hostnames, usernames and local filesystem paths if evidence will be shared publicly.
7. Do not change migration files. Applied migration files are checksum-pinned.
8. If any command would destroy a volume, database, bucket or source directory, stop and report the proposed command before executing it.

## Phase 0 — host evidence

Capture:

```bash
git rev-parse HEAD
uname -a
docker version
docker compose version
node --version
npm --version
df -h
free -h || true
```

Record whether the host is native Linux or Windows + WSL2. Confirm at least roughly 4 CPU cores and 8 GB RAM are available for the evaluation.

Acceptance:
- Git SHA is recorded.
- Docker Engine and Compose work.
- Node is compatible with the repository requirement.
- Disk space is sufficient for images, PostgreSQL and test attachments.

## Phase 1 — fresh local deployment

From a fresh clone, explicitly isolate the source Compose project for **every** subsequent `docker compose` command in this terminal:

```bash
export COMPOSE_PROJECT_NAME=openjm_workspace_source
npm ci
node scripts/init-env.mjs
# Synthetic metadata origins for the disposable IdP/secret-rotation browser tests.
# Registration and rotation do not discover or contact these destinations.
sed -i 's|^OIDC_TENANT_ISSUER_ORIGINS=.*|OIDC_TENANT_ISSUER_ORIGINS=https://login.example.test|' .env
sed -i 's|^WEBHOOK_ALLOWED_ORIGINS=.*|WEBHOOK_ALLOWED_ORIGINS=https://events.example.test|' .env
docker compose config --quiet
docker compose up --build -d
docker compose ps
curl --fail http://localhost:8080/ready
```

Do not display the contents of `.env`.

Wait for `api`, `collab` and `worker` to report healthy. If they do not, capture:

```bash
docker compose ps
docker compose logs --tail=200 api collab worker migrate
```

Acceptance:
- migration service exits successfully;
- API, collaboration and worker are healthy;
- `/ready` returns HTTP 200;
- Caddy serves the application on the configured local address;
- no service is in a restart loop.

## Phase 2 — disposable browser acceptance

This phase creates test users/content. Run it only against the fresh evaluation deployment.

```bash
node scripts/test-deployment.mjs
```

Acceptance:
- all deployed Playwright workflows pass;
- two distinct users can collaborate;
- live permission downgrade/revocation/recovery passes;
- page content survives reload;
- private attachment access follows permissions;
- table/board, comments, history, export and mobile checks pass;
- no browser runtime error is reported by the suite.

Capture only the test summary and failure traces if there is a failure. Do not publish screenshots containing user/workspace labels unless specifically approved.

## Phase 3 — restart and persistence

Record one known page title and a known piece of page text created by the acceptance run. Then:

```bash
docker compose restart
docker compose ps
curl --fail http://localhost:8080/ready
```

Reopen the application in a browser and verify the known page/content still exists.

Then reboot WSL/Linux or fully restart Docker Engine if practical for the evaluation host. Start the stack again:

```bash
docker compose up -d
docker compose ps
curl --fail http://localhost:8080/ready
```

Acceptance:
- PostgreSQL and file volumes survive service restart;
- content survives Docker/host restart;
- API/collaboration/worker return to healthy without manual database repair.

## Phase 4 — TLS/LAN acceptance

Do not expose the default localhost HTTP configuration to the internet.

For a real DNS name, configure `.env` according to `docs/OPERATIONS.md`:

```dotenv
APP_URL=https://workspace.example.com
CADDY_ADDRESS=workspace.example.com
BIND_ADDRESS=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
COOKIE_SECURE=true
```

For an isolated LAN without public DNS, use the organisation's trusted certificate approach or Caddy internal PKI and install the root certificate on the test client.

After changing configuration:

```bash
docker compose up -d
docker compose ps
curl --fail https://workspace.example.com/ready
```

Acceptance:
- browser shows a trusted HTTPS connection;
- sign-in/session cookies work with `COOKIE_SECURE=true`;
- API calls and collaboration websocket work over the same origin;
- invitation links use the configured HTTPS origin;
- CSRF origin checks do not reject legitimate same-origin writes;
- no application database or internal service port is directly published.

If a trusted TLS setup is not available, mark this phase **not executed** rather than weakening TLS validation.

## Phase 5 — migration integrity on the host

Without editing migration files:

```bash
docker compose run --rm migrate
docker compose run --rm migrate
```

Both runs should succeed; the second should be idempotent.

Inspect only migration metadata, not secrets:

```bash
docker compose exec -T postgres \
  psql -U postgres -d workspace \
  -c "SELECT version, checksum IS NOT NULL AS checksum_recorded, applied_at FROM schema_migrations ORDER BY version;"
```

Acceptance:
- every applied migration has a recorded checksum;
- repeated migration execution makes no schema changes and exits successfully;
- there are no partially applied migrations.

Do not modify a historical migration merely to prove checksum failure on the real host; that destructive behavior is already covered by native PostgreSQL CI.

## Phase 6 — backup

Create a new backup directory/file and stop writers:

```bash
mkdir -p backups
docker compose stop api collab worker
docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts backup /backups/host-acceptance.json
docker compose start api collab worker
docker compose ps
```

Acceptance:
- backup command exits successfully;
- source deployment returns healthy after writers restart;
- backup file exists and is non-empty;
- source content remains accessible.

Do not paste backup contents into chat. The archive contains sensitive application data and is not encrypted by the application.

## Phase 7 — separate recovery target

Create a second directory, for example `Workspace-Platform-Recovery`. **Before running any recovery Compose command**, set `export COMPOSE_PROJECT_NAME=openjm_workspace_recovery` in the recovery terminal and verify it differs from `openjm_workspace_source`. Explicitly use a unique Compose project name because `compose.yaml` otherwise has a fixed top-level name. The recovery instance must have separate Docker volumes, a separate S3 bucket if applicable, and unused host ports. Never use `down -v` against the source project.

Copy the backup file into the recovery checkout's `backups/` directory. Prefer running `node scripts/init-env.mjs` in the fresh recovery checkout to generate **new** recovery database passwords and setup token; then securely replace only its `ENCRYPTION_KEY` with the original source encryption key required by the backup (and separately configure any isolated S3 recovery bucket). Do not indiscriminately reuse the source `.env` and do not share any values in evidence.

In the recovery directory, configure fresh PostgreSQL/file volumes and **different host ports and APP_URL**. Copy the original ENCRYPTION_KEY privately and preserve the same application/migration version. Do not copy the source `.env` without adjusting the recovery configuration. Set these shell overrides in the **recovery terminal**, which take precedence over `.env`; use different ports if 8081/8444 are already occupied:

```bash
export COMPOSE_PROJECT_NAME=openjm_workspace_recovery
export HTTP_PORT=8081 HTTPS_PORT=8444
export APP_URL=http://localhost:8081
export BIND_ADDRESS=127.0.0.1 CADDY_ADDRESS=:80 COOKIE_SECURE=false
test "$COMPOSE_PROJECT_NAME" != "openjm_workspace_source"
docker compose config --quiet
# Show only nonsecret project/port evidence, NOT the full interpolated config.
docker compose ps
```

Confirm independently that the source and recovery Compose projects have separate volumes and that the chosen host ports are free. Check that `backups/host-acceptance.json` is actually present in the recovery checkout and readable by the nonroot ops container user (UID 1000), without printing its contents.

**Required restore order:** start only PostgreSQL and Valkey, run migrations, restore the archive **before** starting API/collaboration/worker/web/Caddy, and only then start the whole application. Do not run `docker compose up -d` before the restore command. Merely starting the full recovery stack is not a completed recovery test.

```bash
docker compose up -d postgres valkey
docker compose run --rm migrate
# If an earlier failed attempt started the recovery application, first inspect
# whether the recovery database and object destination remain EMPTY.
# The restore deliberately refuses to overwrite any existing application data.
docker compose --profile ops run --rm ops \
  node --import tsx scripts/backup.ts restore /backups/host-acceptance.json
docker compose up -d
docker compose ps
curl --fail http://localhost:8081/ready
```

If a prior premature startup left data in the recovery database or objects in the recovery volume, **do not force the restore**. Stop and report the exact state. Only rebuild a recovery target after independently verifying that every affected volume/bucket is disposable and belongs exclusively to `openjm_workspace_recovery`; never reset the source project. A port-bind error is a configuration failure, not evidence of failed data restoration.

Acceptance:
- restore refuses to overwrite a nonempty target;
- restore succeeds into the fresh target;
- source deployment remains untouched and usable;
- recovered deployment reaches healthy state;
- sign-in works;
- page content/history are present;
- attachments open;
- database/table records are present;
- collaboration works from two browser sessions;
- source deployment still reaches `/ready` and retained source content remains readable after recovery.

Do **not** rerun the first-run Playwright setup workflow against the restored database: it expects a fresh instance and may produce a misleading failure. Test recovery by signing in with the already-restored disposable source test account and directly verifying data and collaboration. If testing S3-compatible storage, the recovery target must use a separate empty bucket.

## Phase 8 — operational status

As an owner/admin in the UI/API, inspect the operational status endpoint:

`GET /api/v1/operations/status`

Verify the deployment does not contain unexplained:
- failed import jobs;
- dead webhook deliveries;
- stuck event dispatch;
- dead object-deletion jobs.

Also inspect:

```bash
docker compose ps
docker compose logs --tail=200 api collab worker
```

Acceptance:
- no unexplained repeated worker failures;
- no service restart loop;
- no dead queue items created by the acceptance exercise;
- worker health remains healthy after backup/restore/restart operations.

## Evidence package to return

Return a concise report with:

1. exact tested Git SHA;
2. host type and OS;
3. Docker/Compose/Node versions;
4. each phase marked PASS / FAIL / NOT EXECUTED;
5. command exit status and relevant nonsecret output for any failure;
6. service health summary;
7. Playwright test summary;
8. migration metadata showing checksum presence only;
9. backup success and approximate archive size;
10. recovery target health and functional verification;
11. TLS result and certificate trust status;
12. any defect with exact reproduction steps.

Do not include passwords, tokens, cookies, encryption keys, private URLs, internal IPs or backup contents. Include both nonsecret Compose project names and confirm that source and recovery volumes do not overlap.

## Stop conditions

Stop the affected phase and report immediately if:
- a migration checksum mismatch appears unexpectedly;
- migration leaves the deployment unable to start;
- backup or restore attempts to overwrite existing data;
- source data disappears during recovery testing;
- API/collaboration/worker cannot return healthy after a restart;
- TLS requires disabling certificate validation;
- a command would delete an unknown volume, bucket or database.

## Hermes handoff prompt

Use the following instruction when handing this to Hermes:

> Execute `docs/HERMES_HOST_ACCEPTANCE.md` against a fresh disposable clone of the OpenJM Workspace repository. Use `COMPOSE_PROJECT_NAME=openjm_workspace_source` for the source and `COMPOSE_PROJECT_NAME=openjm_workspace_recovery` for the separate recovery target; merely using separate directories is insufficient because compose.yaml has a fixed top-level project name. Follow the safety boundaries exactly. Work autonomously through non-destructive steps, but do not delete or overwrite unknown databases, Docker volumes, buckets or source data. Do not expose any secrets in your report. Use a separate recovery directory and separate recovery volumes/bucket. Record PASS / FAIL / NOT EXECUTED for every phase and return exact nonsecret evidence for failures. Do not modify application source while testing; report defects back to the main engineering workflow instead.
