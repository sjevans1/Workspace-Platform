# Installation and operations

## Development on a workstation

Use Node.js 24 and npm 11. `npm ci` installs the lockfile. `npm run dev` runs the web interface on port 3000, API on 4000, collaboration on 1234, and an embedded PostgreSQL-compatible development endpoint on 55432. The API and embedded database bind loopback. Keep development services on a trusted machine.

The local encryption key and setup token are generated once in `.data/dev-secrets.json` with owner-only permissions. `.data` is excluded from git. Do not erase that directory if you want to retain your development content. `DEV_DATABASE_PATH` overrides the development database directory. `TEST_DATABASE_URL` selects native PostgreSQL for development/testing; test suites create temporary databases and require CREATE DATABASE privileges.

## Docker deployment

Install a current Docker Engine with the Compose plugin. An initial budget of 4 CPU cores and 8 GB RAM is reasonable for building and evaluating this alpha; capacity and concurrency limits still require measurement for each customer workload.

```bash
node scripts/init-env.mjs
docker compose up --build -d
docker compose ps
curl --fail http://localhost:8080/ready
```

The generator refuses to overwrite an existing `.env`. It creates separate owner and runtime database passwords, a 256-bit encryption key and a random setup token. Read the setup token locally and create the first account in the browser. Keep `.env` outside git and back it up securely. Rotating the encryption key without re-encrypting webhook secrets breaks those secrets; restore with the original key.

Only Caddy is published to the host. PostgreSQL, Valkey, API and collaboration are internal Compose services. Containers run with dropped capabilities and no-new-privileges for the application image. The application runtime is the non-root `node` user. Migration and backup containers alone receive the owner database URL.

The default listener is HTTP on localhost port 8080. It has `COOKIE_SECURE=false` for local evaluation. Do not expose this configuration to the internet.

## Domain and HTTPS

Point your domain at the host, permit TCP 80 and 443, and edit `.env`:

```dotenv
APP_URL=https://workspace.example.com
CADDY_ADDRESS=workspace.example.com
BIND_ADDRESS=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
COOKIE_SECURE=true
```

Then run `docker compose up -d`. Caddy obtains and renews the certificate. Its data volume must persist. The UI uses same-origin HTTPS for the API and WSS for `/collaboration`. For a public DNS name, leave `CADDY_TLS_DIRECTIVE` empty. Caddy will use normal automatic HTTPS and ACME certificate renewal.

For a private/LAN hostname that cannot receive a public certificate, use Caddy's internal CA:

```dotenv
APP_URL=https://workspace.internal.example
CADDY_ADDRESS=workspace.internal.example
CADDY_TLS_DIRECTIVE=tls internal
BIND_ADDRESS=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
COOKIE_SECURE=true
```

Start the deployment, then export only the generated public root certificate:

```bash
docker compose up -d
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./openjm-workspace-root.crt
```

Distribute `openjm-workspace-root.crt` through the organisation's normal trusted-root/device-management process before users browse to Workspace. Do **not** export or distribute the internal CA private key. Keep the `caddy_data` volume persistent; losing it creates a new internal CA and requires clients to trust the replacement root. Validate the browser without certificate-warning bypasses. The Workspace session cookie must be Secure/HttpOnly and collaboration must use WSS.

Change `APP_URL` to the exact browser origin; it is also used for invitation links and CSRF origin validation. Caddy sends HSTS from the edge. HTTP is retained only to redirect clients to HTTPS when automatic HTTPS is active.

The application CSP allows inline scripts required by this Next.js build and inline editor styles. It does not permit embedded arbitrary HTML. A nonce-based CSP is a remaining hardening item. Avoid adding arbitrary third-party scripts to the deployment.

## Enterprise SSO

Workspace can use a deployment-level OpenID Connect provider such as Keycloak while retaining local password authentication as an optional break-glass path. Configure and validate SSO before disabling local passwords. The exact security model, environment variables, Keycloak callback and current directory-lifecycle boundaries are documented in [Identity and enterprise SSO](IDENTITY.md).

The OIDC client secret belongs in the deployment secret environment and is passed only to the API service. Production issuers should use HTTPS; do not enable `OIDC_ALLOW_INSECURE` outside isolated testing.

A successful IdP login does not grant tenant access by itself. Existing membership or a matching administrator-issued invitation is required.

### Keycloak back-channel logout

For Keycloak deployments, configure the client's Backchannel logout URL to:

```
${APP_URL}/api/v1/auth/oidc/backchannel-logout
```

Enable Keycloak's back-channel session-ID option when available so Workspace can revoke the precise OIDC-created session by `sid`. The endpoint is public by design but accepts only a provider-signed logout JWT with the expected issuer/audience and back-channel event claims. It does not use the Workspace CSRF/session cookie.

Workspace administrator membership deactivation already invalidates that user's tenant sessions. External directory disablement is different: if the identity provider does not send a logout event, use Workspace deactivation until SCIM/directory lifecycle automation is implemented.

`workspace_runtime` must remain `NOSUPERUSER NOBYPASSRLS`. Do not grant `BYPASSRLS` to make back-channel logout work. The handler supplies transaction-local tenant context for its RLS-protected audit insert; CI exercises the native application through the restricted runtime role.

## SCIM directory provisioning

SCIM Users provisioning/offboarding is available at `${APP_URL}/scim/v2`. It requires no deployment-wide SCIM environment variables. An organisation owner/admin creates a tenant-scoped connector in **Settings → Integrations → Directory provisioning (SCIM 2.0)**.

The raw bearer token is shown once and Workspace stores only its hash. Put the raw value in the directory provider's secret store. For rotation, create and validate a replacement connector before revoking the old connector.

The Caddy deployment explicitly proxies `/scim/*` to the API. Use the same trusted HTTPS Workspace origin in production; do not expose an alternate direct API port for SCIM.

A SCIM connector belongs to one organisation. `active:false` or SCIM DELETE deactivates that membership and immediately revokes that organisation's active Workspace sessions for the user. If the same global Workspace user belongs to another organisation, that other tenant is intentionally unaffected.

Connector metadata and SCIM user mappings are included in logical backups. Raw tokens are never stored; because the hash is restored, an identity provider holding the existing raw token can continue authenticating after a successful restore of the same deployment data.

SCIM Users and Groups are implemented, including explicit owner/admin-controlled Group mapping to only `member` or `guest`. Bulk, full filter grammar, ETag concurrency and password changes are not implemented. See [SCIM directory lifecycle](SCIM.md).

## Branding

Set PRODUCT_NAME, PRIMARY_ACCENT, LOGO_LIGHT, LOGO_DARK, FAVICON, LOGIN_BACKGROUND, SUPPORT_NAME, SUPPORT_URL, LEGAL_NAME, PRIVACY_URL and TERMS_URL for deployment-wide sign-in defaults. Administrators can override those fields for their signed-in organisation through Settings → Branding. Use HTTPS asset URLs or same-origin paths. The current interface uses the light logo; the dark logo is retained in configuration for a future dark theme.

## Object storage

Local storage is the default and uses the `files` volume. For an existing authenticated S3-compatible service, including SeaweedFS S3:

```dotenv
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://s3.example.internal
S3_BUCKET=workspace
S3_REGION=us-east-1
S3_ACCESS_KEY=<dedicated-service-access-key>
S3_SECRET_KEY=<dedicated-service-secret>
S3_FORCE_PATH_STYLE=true
```

Create the private bucket beforehand. Give the service principal only the required object and bucket-health access. Never publish the bucket anonymously. Storage readiness checks require access to the configured bucket. Object writes use the S3 If-None-Match condition so an existing key cannot be overwritten, matching local storage. The automated CI recovery drill passes against authenticated SeaweedFS 4.47. For the selected production provider, use [Production S3/object-store acceptance](PRODUCTION_S3_ACCEPTANCE.md), which exercises the same immutable-write and backup/recovery contract without requiring bucket-creation privileges. For disconnected environments, mirror container images and npm artifacts into internal registries before installation.

## Webhooks

Set `WEBHOOK_ALLOWED_ORIGINS` to a comma-separated list of exact HTTP(S) origins. It is empty by default. An administrator can then register endpoint paths on those origins in Settings → Webhooks. Use HTTPS outside isolated local testing. Receiver verification and event format are in [the integration guide](INTEGRATION.md).

## Back up

The included logical backup is intended for small deployments up to 1 GiB of attachment data. It captures a consistent SQL snapshot, canonical Yjs bytes, versions, audit records, credentials as stored, and all referenced private file bytes with SHA-256 checksums. It is not encrypted; protect the backup directory and encrypt archives with your normal backup system. Store a protected copy of `.env` separately. At larger scale, use PostgreSQL physical backups/WAL and coordinated object-store snapshots, with a tested recovery plan.

Stop writers so metadata and objects have a stable maintenance boundary:

```bash
mkdir -p backups
# The image's non-root node user (UID 1000) must own the host backup directory.
# Apply the appropriate ownership/ACL for your host before running the ops job.
docker compose stop api collab worker
docker compose --profile ops run --rm ops node --import tsx scripts/backup.ts backup /backups/workspace-backup.json
docker compose start api collab worker
```

The backup command refuses to replace an existing file. Choose a new dated filename for each run. The ops profile sets `WORKSPACE_MAINTENANCE=true`; it does not itself stop other services. Always perform the explicit stop first. The web/reverse proxy may remain up to show the maintenance connection failure.

## Restore to an empty deployment

Restore into a separate fresh deployment with the **same application/schema version** and original ENCRYPTION_KEY. The tool refuses to restore into any nonempty application database or overwrite existing object keys. Do not delete the old deployment as part of a recovery test.

1. Copy the source `.env` securely to the recovery directory and choose unused host ports. Preserve the original ENCRYPTION_KEY, but configure fresh PostgreSQL/file volumes and, for S3, a separate empty recovery bucket. Do not point the recovery deployment at the source database or bucket.
2. Start the fresh PostgreSQL and Valkey services, then run the migration service.
3. Make the archive readable by the non-root ops user and ensure the new object destination is empty.
4. Run restore before starting API, collaboration or worker:

```bash
docker compose up -d postgres valkey
docker compose run --rm migrate
docker compose --profile ops run --rm ops node --import tsx scripts/backup.ts restore /backups/workspace-backup.json
docker compose up -d
```

Verify sign-in, page content, restored history, files, a table/board record, and collaboration from two browsers. The automated tests verify metadata, raw Yjs equality and attachment bytes. The SeaweedFS drill uses separate source/recovery databases and buckets, retains soft-deleted attachments, rejects anonymous reads and bad credentials, and checks checksum/key/schema validation, existing-object collisions, concurrent overwrite protection and upload-failure rollback. It also rejects a nonempty restore and confirms that source objects remain intact. It does not substitute for a periodic host-level restore drill.

## Upgrades and health

Back up before each upgrade. Review release notes, build the new image, stop writers, run migrations once, and start the new services. Migrations are transactional and tracked in `schema_migrations`; the migration runner uses an advisory lock. Downgrade is not automatic: recover the matching backup into a separate deployment if needed.

- `/health`: API process alive.
- `/ready`: API database, rate-limit store when configured, and object storage accessible.
- `docker compose ps`: API, collaboration and worker should each report `healthy`. Collaboration health verifies its database writer lease; worker health verifies database access, recent tick completion, repeated failures and a maximum in-flight tick duration.
- `GET /api/v1/operations/status` as an owner/admin human session: tenant queue counts for imports, event dispatch, webhook deliveries and object deletion, including dead/failed work requiring attention.
- `docker compose logs api collab worker`: structured request/worker errors; HTTP logs redact cookies, bearer credentials, CSRF and setup tokens.
- Settings → Webhooks: recent deliveries, retry/dead status and last error.
- Settings → Audit: recent append-only application audit records.

The collaboration and worker health listeners bind only inside their own containers and are not routed through Caddy. `WORKER_HEALTH_MAX_TICK_MS` defaults to 60 seconds and `WORKER_HEALTH_GRACE_MS` to 10 seconds; raise the maximum only after measuring a legitimate long-running tick. Repeated tick failures or a stuck tick make the worker unhealthy and allow Docker/monitoring to surface the condition.

Keep PostgreSQL and the object volume on reliable storage, monitor capacity and backup success, and terminate TLS at Caddy. Host-level encryption, secret-manager integration, external metrics/alerts, disaster recovery automation and antivirus remain deployment work described in the acceptance checklist. OIDC/Keycloak SSO, real-provider back-channel logout and SCIM Users/Groups lifecycle are implemented. Trusted-TLS acceptance is now CI-verified. Production object-store validation, broader provider compatibility and the other release-hardening items remain.

## Real-host acceptance

For a bounded disposable-host validation outside CI, including WSL/Linux restart persistence, TLS/LAN behavior, migration checksum verification, backup and recovery into a separate target, follow [the Hermes real-host acceptance runbook](HERMES_HOST_ACCEPTANCE.md). The runbook explicitly prohibits destructive testing against the source deployment or production data.

## Repeat the S3 recovery check

CI starts `chrislusf/seaweedfs:4.47` with its default `weed mini` entrypoint, synthetic test credentials and `S3_BUCKET=workspace-ci`. Only the S3 port is exposed. This service is disposable test infrastructure; see [SeaweedFS mini documentation](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini) for its configuration.

To run the same check locally, start an isolated service:

```bash
docker run --rm --name workspace-s3-check \
  -p 127.0.0.1:8333:8333 \
  -e AWS_ACCESS_KEY_ID=workspace-ci \
  -e AWS_SECRET_ACCESS_KEY=workspace-ci-secret \
  -e S3_BUCKET=workspace-ci chrislusf/seaweedfs:4.47
```

In another terminal, set TEST_DATABASE_URL to a disposable native PostgreSQL service whose test account can create databases, then run:

```bash
TEST_S3_ENDPOINT=http://127.0.0.1:8333 \
TEST_S3_ACCESS_KEY=workspace-ci \
TEST_S3_SECRET_KEY=workspace-ci-secret \
node --import tsx --test tests/s3.test.ts
```

The test creates uniquely named databases/buckets and removes them afterwards. Without both TEST_DATABASE_URL and TEST_S3_ENDPOINT it is explicitly skipped. Never use production credentials for this check.
