# Hermes Keycloak back-channel logout acceptance

This is a focused continuation of the already-passed real-Keycloak SSO acceptance. Do not repeat the full SSO provisioning exercise unless a prerequisite is missing.

## Objective

Prove end to end that a real Keycloak logout/session-termination event reaches OpenJM Workspace's OIDC Back-Channel Logout endpoint and invalidates an already-active OIDC-created Workspace session.

Runtime implementation under test:

- Back-channel logout merge: `bd6b0c4a053a93f9dd060003c44a7adaa95768b2`
- CI gate: https://github.com/sjevans1/Workspace-Platform/actions/runs/36792189577
- Native PostgreSQL tests: 35 passed
- Existing non-SSO deployed Chromium workflows: passed

Read first:

- `docs/IDENTITY.md`
- `docs/HERMES_KEYCLOAK_ACCEPTANCE.md`
- `docs/BUILD_CHECKPOINT.md`

## Existing disposable environment

The previous acceptance reported:

- Workspace Compose project: `openjm_workspace_sso`
- Workspace browser origin: `http://localhost:8082`
- Keycloak container: `openjm-keycloak-test`
- Keycloak version: 26.7.4
- Keycloak issuer: `http://keycloak.localhost:18081/realms/openjm-test`
- Realm: `openjm-test`
- Client: `openjm-workspace`
- Owner: `owner-sso@example.test`
- Member: `member-sso@example.test`

The source and recovery projects must remain untouched:

- `openjm_workspace_source`
- `openjm_workspace_recovery`

If the disposable SSO/Keycloak environment no longer exists, reconstruct only that environment according to `docs/HERMES_KEYCLOAK_ACCEPTANCE.md`. Do not reuse source/recovery volumes.

## Safety

1. Never delete or reset source/recovery volumes.
2. Do not expose passwords, client secrets, cookies, logout tokens, ID/access tokens or Keycloak admin credentials in the report.
3. Do not modify application source during acceptance.
4. Do not manufacture or manually sign a logout token for the host proof. CI already tests signed-token validation. This host test must prove **Keycloak itself** sends the logout request.
5. Do not classify simple Keycloak user disablement as equivalent to logout unless evidence shows Keycloak actually sent the back-channel event.
6. Keep any local owner/password session separate as a break-glass control.

## Phase 0 — update only the disposable SSO Workspace

In the existing SSO checkout:

```bash
export COMPOSE_PROJECT_NAME=openjm_workspace_sso
git fetch origin
git checkout main
git pull --ff-only
git rev-parse HEAD
npm ci
docker compose run --rm migrate
docker compose up --build -d
docker compose ps
curl --fail http://localhost:8082/ready
```

Acceptance:

- the tested SHA contains or follows `bd6b0c4a053a93f9dd060003c44a7adaa95768b2`;
- migration `005_oidc_backchannel.sql` is applied;
- API/collaboration/worker are healthy;
- Keycloak remains on the disposable SSO network;
- source and recovery projects are unchanged.

Do not rely on an OIDC Workspace session created before this upgrade: old sessions do not contain the newly added OIDC session metadata. Create a fresh SSO login after the upgrade.

## Phase 1 — configure the Keycloak client logout settings

Using the Keycloak Admin Console for the `openjm-workspace` client in realm `openjm-test`:

1. Keep **Front channel logout** OFF.
2. Set **Backchannel logout URL** to the URL Keycloak can reach from its container on the shared disposable Docker network:

```
http://caddy/api/v1/auth/oidc/backchannel-logout
```

3. Enable **Backchannel logout session required** so the logout token contains the OIDC session ID (`sid`).
4. Save.

Do not use `http://localhost:8082/...` as the back-channel URL inside this Docker test: from the Keycloak container, `localhost` refers to Keycloak itself. The `caddy` service name is reachable on `openjm_workspace_sso_default`.

Verify the Workspace remains ready after changing Keycloak configuration.

Acceptance:

- Front-channel logout is OFF.
- Backchannel URL is exactly the internal Workspace Caddy endpoint above.
- Backchannel logout session required is ON.

## Phase 2 — establish control sessions

Create two independent browser contexts:

### A. Local break-glass owner session

Ensure `LOCAL_AUTH_ENABLED=true` temporarily in the disposable SSO environment for this control.

Sign in locally as the existing owner `owner-sso@example.test`.

Confirm:

`GET /api/v1/me` -> HTTP 200.

Keep this local Workspace session active. Do not log it out.

### B. Fresh member OIDC session

In a separate clean browser context, use Keycloak SSO as:

`member-sso@example.test`

This must be a **new SSO login after migration 005**.

Confirm:

- Workspace login succeeds;
- `GET /api/v1/me` with that browser's Workspace session -> HTTP 200;
- the member can open an allowed page.

Keep that member browser open on an editable page if permissions permit.

Acceptance:

- local owner control session is active;
- fresh OIDC member Workspace session is active;
- they are separate browser/session contexts.

## Phase 3 — observe user disablement separately

In Keycloak Admin Console, disable `member-sso@example.test` **without deliberately logging out/terminating its existing user session yet**.

Immediately observe, rather than assume:

- whether Keycloak sends any back-channel request;
- whether the current Workspace member session remains valid;
- whether a new Keycloak authentication is blocked.

Record what actually happens.

This phase distinguishes directory-account disablement from OIDC session logout. If the existing Workspace session remains active, that is the documented reason SCIM/directory offboarding is still separate work. If Keycloak automatically terminates the session and sends a back-channel token, capture that as observed behavior instead.

Re-enable the disposable member if required to proceed with a fresh active session for the next phase.

## Phase 4 — trigger a real Keycloak session logout

Ensure the member has a current active Keycloak + Workspace SSO session.

From a separate Keycloak administrator context, terminate/log out that member's **active Keycloak user session** using the Keycloak Admin Console's user-session controls (or the official Admin REST equivalent).

Do not manually POST to Workspace's back-channel endpoint.

Keycloak should send a form POST containing its signed `logout_token` to:

`http://caddy/api/v1/auth/oidc/backchannel-logout`

Acceptance:

- Keycloak logout/session termination succeeds;
- Workspace API logs show the back-channel request was accepted without leaking the token;
- an `auth.oidc_backchannel_logout` Workspace audit event appears for the affected tenant;
- the old member Workspace session is no longer usable.

## Phase 5 — prove immediate Workspace revocation

Using the **same member browser/cookie that was active before Phase 4**, not a new login:

- call or navigate through an authenticated Workspace endpoint;
- verify `GET /api/v1/me` returns HTTP 401 or equivalent signed-out behavior;
- verify private API/resource access fails;
- if the editor was left open, attempt a new edit and observe that collaboration resets/disconnects or rejects continued persistence after its normal session recheck.

Do not treat a browser cookie merely remaining in storage as a failure; the acceptance criterion is that the server no longer accepts it.

Also verify the local owner break-glass session from Phase 2A still returns HTTP 200.

Acceptance:

- old OIDC member session rejected;
- active collaboration no longer permits continued authenticated editing/persistence;
- unrelated local owner session remains valid.

## Phase 6 — login after logout

If the Keycloak member is enabled, perform a fresh SSO login again.

Acceptance:

- a new legitimate Keycloak authentication can create a new Workspace session;
- the old pre-logout Workspace session remains invalid;
- normal access resumes only through the new session.

If the member remains disabled, mark this subtest NOT EXECUTED rather than weakening identity policy.

## Phase 7 — operational/security evidence

Check nonsecret evidence:

```bash
export COMPOSE_PROJECT_NAME=openjm_workspace_sso
docker compose ps
docker compose logs --tail=250 api collab worker
docker logs --tail=250 openjm-keycloak-test
```

Redact any token or secret if it appears unexpectedly.

Confirm:

- API/collaboration/worker healthy;
- no service restart loops;
- no repeated back-channel validation errors;
- no logout token/client secret/access token/ID token recorded in the report;
- no source/recovery deployment changes.

## Required final report

Return:

1. exact Workspace Git SHA;
2. Keycloak version;
3. PASS / FAIL / NOT EXECUTED for phases 0–7;
4. configured Keycloak back-channel URL;
5. whether Keycloak included session-specific logout behavior;
6. what happened on **disable only** before explicit session termination;
7. evidence that Keycloak itself emitted the logout request;
8. old OIDC Workspace session result after logout;
9. live collaboration result after logout;
10. local break-glass session result;
11. fresh post-logout SSO result if executed;
12. Workspace service-health result;
13. reproducible defects, if any.

Do not include secrets, passwords, cookies, authorization codes, logout-token JWT contents, access/ID tokens, client secret or admin credentials.

## Expected boundary after this test

Passing this test establishes IdP-session logout propagation, not full enterprise directory lifecycle. SCIM/group provisioning, automatic membership deactivation from directory state and policy for IdP account disablement remain separate work unless explicitly implemented and tested.
