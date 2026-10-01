# Hermes Keycloak / OIDC host acceptance

Use this only for a disposable identity test environment on the existing WSL2 host. Do not modify or destroy the previously accepted `openjm_workspace_source` or `openjm_workspace_recovery` projects.

## Objective

Independently validate the OpenJM Workspace OIDC implementation against a real Keycloak server and a real browser redirect flow.

This original runbook validated the SSO foundation. Back-channel logout was implemented afterwards. For current session-revocation acceptance, continue with `docs/HERMES_KEYCLOAK_LOGOUT_ACCEPTANCE.md` rather than treating the old Phase 8 boundary below as current runtime behavior.

The application code under test was introduced at merge commit:

`842ee53bbc17f569d0aaba748d8a15ac517b6955`

Documentation-only commits after that merge do not change runtime behavior.

Read first:

- `docs/IDENTITY.md`
- `docs/OPERATIONS.md`
- `docs/ACCEPTANCE.md`

## Isolation and safety

Use these isolated names/ports unless already occupied:

- Workspace Compose project: `openjm_workspace_sso`
- Workspace HTTP: `127.0.0.1:8082`
- Workspace HTTPS placeholder: `127.0.0.1:8445`
- Keycloak container: `openjm-keycloak-test`
- Keycloak HTTP: `127.0.0.1:18081`

Port `18080` is reserved for the OpenJM Enterprise AI local OpenAI-compatible model runtime and must not be used by Workspace test infrastructure.
- Realm: `openjm-test`
- Client ID: `openjm-workspace`

Do not use `docker compose down -v` against any project other than the explicitly disposable `openjm_workspace_sso` test project, and only after verifying its name and volumes.

Do not reuse production or personal identity-provider credentials.

Do not put test passwords, Keycloak bootstrap credentials, client secrets or Workspace setup tokens in the final report.

Keycloak `start-dev` and `OIDC_ALLOW_INSECURE=true` are acceptable only because this is an isolated localhost test. They are prohibited for production validation.

## Phase 0 — preflight

From a fresh clone of `main`:

```bash
git rev-parse HEAD
git log -1 --oneline
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Confirm the existing source/recovery projects are left untouched and ports 8082, 8445 and 18081 are available.

Set:

```bash
export COMPOSE_PROJECT_NAME=openjm_workspace_sso
```

Generate a fresh Workspace test environment:

```bash
node scripts/init-env.mjs
```

Update only the disposable SSO checkout's `.env`:

```dotenv
APP_URL=http://localhost:8082
BIND_ADDRESS=127.0.0.1
HTTP_PORT=8082
HTTPS_PORT=8445
COOKIE_SECURE=false

OIDC_ISSUER=http://keycloak.localhost:18081/realms/openjm-test
OIDC_CLIENT_ID=openjm-workspace
OIDC_CLIENT_SECRET=<random-test-secret>
OIDC_LABEL=OpenJM Test SSO
OIDC_SCOPES=openid profile email
OIDC_REQUIRE_VERIFIED_EMAIL=true
OIDC_ALLOW_INSECURE=true
LOCAL_AUTH_ENABLED=true
```

Use cryptographically random test-only values for the Keycloak admin password and OIDC client secret. Keep them private.

## Phase 1 — create the disposable Workspace network

Create only the base Workspace services so the isolated Compose network exists:

```bash
docker compose up -d postgres valkey
docker compose ps
```

Confirm the network belongs to `openjm_workspace_sso`.

## Phase 2 — start disposable Keycloak

Use Keycloak 26.7.4 for this acceptance run. It is a current September 2026 security-maintained release; this runbook intentionally pins the tested version instead of using `latest`.

Create a realm import file under a private temporary/test-data directory. It must define:

- realm `openjm-test`, enabled;
- confidential OIDC client `openjm-workspace`;
- standard authorization-code flow enabled;
- direct-access/password grant disabled;
- exact redirect URI:
  `http://localhost:8082/api/v1/auth/oidc/callback`;
- exact web origin `http://localhost:8082`;
- client secret matching the Workspace test `.env`;
- user `owner-sso@example.test`, enabled, email verified, with a private test password;
- user `member-sso@example.test`, enabled, email verified, with a different private test password.

Do not commit the realm import or secrets.

Start Keycloak on the Workspace test project's Docker network with the network alias `keycloak.localhost`, with its internal HTTP port also set to 18081 so the issuer URL is identical from the browser and Workspace API container:

```bash
docker run -d \
  --name openjm-keycloak-test \
  --network openjm_workspace_sso_default \
  --network-alias keycloak.localhost \
  -p 127.0.0.1:18081:18081 \
  -m 1g \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=<private-test-admin> \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=<private-test-password> \
  -v <private-realm-json>:/opt/keycloak/data/import/openjm-test.json:ro \
  quay.io/keycloak/keycloak:26.7.4 \
  start-dev --http-port=18081 --import-realm
```

If Docker generated a different network name, determine the exact disposable `openjm_workspace_sso` default network rather than guessing. Do not attach Keycloak to the source/recovery network.

Wait until:

```bash
curl --fail http://keycloak.localhost:18081/realms/openjm-test/.well-known/openid-configuration
```

works from the host.

Also verify discovery from a disposable container on the Workspace SSO network, without exposing secrets. The issuer reported by discovery must exactly match:

`http://keycloak.localhost:18081/realms/openjm-test`

## Phase 3 — start Workspace and bootstrap locally

Run:

```bash
docker compose run --rm migrate
docker compose up -d
docker compose ps
curl --fail http://localhost:8082/ready
```

Wait for API, collaboration and worker health.

Use the Workspace first-run setup page to create the owner with email:

`owner-sso@example.test`

Use a private disposable local password. This intentionally creates the existing Workspace owner before the first SSO account link.

Verify ordinary local sign-in still works.

## Phase 4 — existing-owner SSO linking

Sign out of Workspace.

Use the visible **Continue with OpenJM Test SSO** button.

Authenticate at Keycloak as `owner-sso@example.test`.

Acceptance:

- browser is redirected to Keycloak and back to Workspace;
- Workspace signs in successfully;
- the account remains the existing Workspace owner rather than creating a duplicate;
- the expected organisation/workspace remains accessible;
- Settings/Audit contains an `auth.oidc_login` record;
- no secret/token is displayed in application URLs after the callback is complete.

Sign out and repeat SSO login once to prove the durable issuer+subject link works on subsequent login.

## Phase 5 — invitation-backed passwordless SSO provisioning

As the owner, create a Workspace invitation for:

`member-sso@example.test`

with role `member`.

Open that invitation in a fresh browser context/incognito session.

Choose **Continue with OpenJM Test SSO** and authenticate to Keycloak as `member-sso@example.test`.

Acceptance:

- SSO returns successfully;
- the invitation is consumed;
- the new Workspace account has role `member`;
- the user did not need to establish a local Workspace password;
- the user sees only the access allowed by the normal Workspace permission model.

Log out and verify the same Keycloak identity can sign in again without another invitation.

## Phase 6 — negative provisioning boundary

Create another Workspace invitation for an email different from the Keycloak identity being used.

Attempt to complete that invitation through SSO with a mismatched verified Keycloak email.

Acceptance:

- Workspace rejects the callback/provisioning;
- the incorrect user receives no membership;
- the invitation remains usable by the intended identity;
- no duplicate/partial Workspace account or membership is created.

Do not weaken verified-email requirements to make this test pass.

## Phase 7 — SSO-only mode

First prove the owner SSO login works.

Then set in the disposable Workspace SSO environment:

```dotenv
LOCAL_AUTH_ENABLED=false
```

Recreate/restart the API as required by Compose.

In a fresh browser context verify:

- local password login form is not offered;
- SSO remains available;
- owner SSO login succeeds;
- member SSO login succeeds;
- password-based invitation acceptance is unavailable;
- account Settings does not offer local password change.

Do not apply this setting to the established source/recovery deployments.

After testing, returning `LOCAL_AUTH_ENABLED=true` in the disposable environment is optional.

## Phase 8 — session/offboarding boundary

Document, but do not classify as a defect, the current known lifecycle boundary:

Workspace creates its own local session after OIDC authentication. Disabling the user in Keycloak is not expected to immediately revoke an already-issued Workspace session in this release.

Confirm only that a **new** Keycloak authentication cannot succeed for a disabled Keycloak user.

Do not attempt to work around the documented lack of back-channel logout/session revocation.

## Phase 9 — operational/security evidence

Check:

```bash
docker compose ps
docker compose logs --tail=200 api
docker logs --tail=200 openjm-keycloak-test
```

Redact secrets before reporting.

Confirm:

- no repeated OIDC discovery/token failures;
- no application restart loop;
- no OIDC client secret in routine logs;
- no ID/access token retained in report evidence;
- application health remains green.

## Required report

Return:

1. exact Workspace Git SHA;
2. Keycloak image/version;
3. PASS/FAIL/NOT EXECUTED for phases 0–9;
4. discovery issuer observed;
5. existing-owner SSO-link result;
6. repeat-login result;
7. invitation-backed passwordless provisioning result;
8. mismatched-invitation rejection result;
9. SSO-only result;
10. disabled-IdP-user/new-login behavior;
11. Workspace service health;
12. any reproducible application defects.

Do not include secrets, passwords, cookies, authorization codes, access/ID tokens, client secret, setup token or realm export contents.

## Cleanup

Cleanup is optional immediately after the report if evidence inspection is still required.

When cleanup is authorized, verify names first. Only remove:

- the disposable `openjm-keycloak-test` container;
- the disposable `openjm_workspace_sso` Compose project and its test-only volumes;
- private temporary realm import/test data.

Never remove volumes belonging to `openjm_workspace_source` or `openjm_workspace_recovery`.


## Follow-up: back-channel logout

The SSO foundation described above has passed. OIDC back-channel logout was added later at runtime merge `bd6b0c4a053a93f9dd060003c44a7adaa95768b2` and passed CI run 36792189577. Use [the focused Keycloak logout acceptance](HERMES_KEYCLOAK_LOGOUT_ACCEPTANCE.md) to validate active-session revocation against the real disposable Keycloak environment.
