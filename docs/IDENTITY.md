# Identity and enterprise SSO

OpenJM Workspace supports local password authentication plus an optional deployment-level OpenID Connect provider such as Keycloak.

The implementation deliberately separates **authentication** from **Workspace authorization**. A successful identity-provider login proves who the user is; it does not automatically grant organisation, workspace or page access.

## Security model

The OIDC flow uses:

- OpenID Connect discovery from the configured issuer;
- authorization-code flow;
- PKCE with S256;
- random OAuth state;
- OIDC nonce validation;
- an HttpOnly, SameSite=Lax browser state cookie;
- server-side one-time login state with a ten-minute expiry;
- issuer + subject as the durable external identity key;
- signed ID-token validation through `openid-client`;
- verified email by default;
- the normal Workspace opaque application session after successful authentication.

The Workspace does not retain the IdP access token or refresh token after sign-in. The local Workspace session remains the runtime authorization credential.

OIDC callback state is single-use. Replaying a completed callback is rejected.

## Provisioning boundary

SSO does **not** create organisation membership by itself.

An OIDC user can enter Workspace when either:

1. a Workspace user with the same verified email already exists and has an active membership; or
2. an administrator-created Workspace invitation is carried through the OIDC flow and the verified IdP email exactly matches the invitation email.

The second path supports passwordless enterprise onboarding. The new Workspace user has no local password unless a later supported workflow explicitly establishes one.

Roles continue to come from Workspace membership/invitation state. IdP groups, realm roles and arbitrary token claims are not currently mapped into Workspace roles.

## Configuration

The application callback URI is:

```
${APP_URL}/api/v1/auth/oidc/callback
```

Configure the deployment:

```dotenv
APP_URL=https://workspace.example.com
COOKIE_SECURE=true

OIDC_ISSUER=https://id.example.com/realms/acme
OIDC_CLIENT_ID=openjm-workspace
OIDC_CLIENT_SECRET=<client-secret>
OIDC_LABEL=Company SSO
OIDC_SCOPES=openid profile email
OIDC_REQUIRE_VERIFIED_EMAIL=true
OIDC_ALLOW_INSECURE=false

LOCAL_AUTH_ENABLED=true
```

The issuer must normally use HTTPS. `OIDC_ALLOW_INSECURE=true` exists only for isolated development/testing.

Keep `OIDC_CLIENT_SECRET` outside source control. It is passed only to the API service in the supplied Compose deployment.

## Keycloak

Create or select the required Keycloak realm, then register an OpenID Connect client for Workspace. Keycloak publishes standard discovery metadata at:

```
https://<keycloak-host>/realms/<realm>/.well-known/openid-configuration
```

Use the realm URL itself as `OIDC_ISSUER`, for example:

```
https://id.example.com/realms/acme
```

Configure the client to allow the exact Workspace callback:

```
https://workspace.example.com/api/v1/auth/oidc/callback
```

The application performs server-side code exchange and supports a confidential client secret. Preserve the normal `openid profile email` scopes and ensure users receive the standard email/email_verified claims.

Official Keycloak OIDC documentation:
https://www.keycloak.org/securing-apps/oidc-layers

### Back-channel logout

Workspace exposes the OIDC Back-Channel Logout endpoint:

```
${APP_URL}/api/v1/auth/oidc/backchannel-logout
```

Configure this exact URL as the Keycloak client's **Backchannel logout URL**. When available, enable Keycloak's session-ID/backchannel-session option so logout tokens contain `sid` and Workspace can revoke only the matching OIDC-created Workspace session.

Workspace validates the signed logout JWT against the configured provider JWKS and requires the expected issuer/audience, temporal/JTI/event claims, and `sub` or `sid`. Logout tokens containing a nonce are rejected. Repeated delivery of the same logout `jti` is idempotent.

OIDC-created Workspace sessions retain only issuer/subject/session-ID linkage; Workspace still does not retain the IdP access or refresh token. A matching back-channel logout removes the affected Workspace session, so subsequent REST access fails and collaboration's normal session recheck disconnects/rejects continued editing. Unrelated local/password break-glass sessions are not revoked by an OIDC logout token.

An administrator deactivating a Workspace membership already revokes that user's Workspace sessions for the tenant. Separately, disabling an account in an external directory does not by itself guarantee that an OIDC back-channel event will be emitted; directory/SCIM offboarding remains a distinct lifecycle concern.

Do not grant `BYPASSRLS` to `workspace_runtime` to support logout. The runtime role is intentionally `NOBYPASSRLS`; the back-channel handler sets transaction-local tenant context for its tenant-scoped audit insert.

## Enabling SSO safely

1. Keep `LOCAL_AUTH_ENABLED=true`.
2. Configure the IdP and restart the API deployment.
3. Confirm the login page displays the configured SSO button.
4. Sign in as an existing owner/admin whose verified IdP email matches the Workspace account.
5. Confirm the existing account is linked, the expected organisation is available and an `auth.oidc_login` audit record appears.
6. Test an invitation-backed new SSO user and verify the intended Workspace role.
7. Only after a tested administrative SSO path exists should you consider `LOCAL_AUTH_ENABLED=false`.

Retaining a controlled local owner/admin account can provide a break-glass path if the IdP is unavailable. Treat that account as a privileged credential and manage it accordingly.

## Local-auth behavior

With `LOCAL_AUTH_ENABLED=false`:

- password sign-in is rejected;
- password-based invitation acceptance is rejected;
- password change is disabled in Settings;
- the first-run setup mechanism remains available for initial bootstrap.

Do not disable local authentication before validating an owner/admin SSO login.

## Backup and recovery

Durable `oidc_identities` rows are included in logical backups so restored accounts retain their issuer/subject links.

Short-lived OIDC login-state rows are intentionally not backed up.

A restored deployment must have compatible OIDC configuration if users are expected to sign in through the same identity provider.

## Current enterprise identity boundaries

The current slice is an OIDC/Keycloak **foundation**, not a complete enterprise directory product.

Not yet implemented:

- per-tenant identity providers in one shared deployment;
- SCIM user/group provisioning;
- IdP group/role to Workspace-role mapping;
- automatic offboarding from IdP directory changes;
- OIDC RP-initiated logout;
- OIDC RP-initiated/front-channel logout;
- automatic directory-disable/SCIM offboarding when the IdP does not emit a back-channel logout event;
- local password-reset/recovery;
- application-enforced MFA/ACR/AMR policy;
- email delivery of invitation links.

MFA can be required by the external IdP, but Workspace does not yet independently verify or require a particular MFA authentication-context claim.

Workspace now accepts standards-based signed OIDC back-channel logout tokens and revokes matching OIDC-created Workspace sessions. Workspace membership deactivation also revokes tenant sessions immediately. What remains is directory lifecycle synchronization: disabling a user in an IdP does not necessarily generate a back-channel logout event, so SCIM/directory-driven offboarding must still be implemented or the operator must terminate the IdP session / deactivate the Workspace membership.

## Verification

CI covers:

- existing-account OIDC linking;
- browser-bound state mismatch rejection;
- one-time state/replay rejection;
- invitation-backed passwordless SSO provisioning;
- invitation email mismatch rejection;
- real OIDC discovery against a disposable issuer;
- confidential client code exchange;
- PKCE S256 transmission;
- signed ID-token verification;
- nonce validation;
- verified-email enforcement;
- signed back-channel logout JWT validation, nonce rejection and replay-safe session revocation;
- preservation of an unrelated local break-glass session during OIDC session revocation;
- normal non-SSO Docker and Chromium workflows.

A real Keycloak 26.7.4 deployment test has passed on WSL2 for login/provisioning/SSO-only behavior. A focused logout exercise also proved that Keycloak emits a signed back-channel token on explicit administrator session termination. That host exercise exposed an RLS defect in the tenant audit insert and required a disposable `BYPASSRLS` workaround to complete; the workaround is not production-acceptable. PR #16 fixed the handler by setting transaction-local tenant context before each audit insert, and CI run 36797135204 now passes 36/36 native tests with the application running as `workspace_runtime` and `rolbypassrls=false`. One short no-workaround Keycloak host rerun remains before real-provider session-revocation acceptance is closed. Follow `HERMES_KEYCLOAK_LOGOUT_ACCEPTANCE.md`.
