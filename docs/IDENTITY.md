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
- back-channel/front-channel logout;
- immediate Workspace-session revocation when an IdP session is disabled;
- local password-reset/recovery;
- application-enforced MFA/ACR/AMR policy;
- email delivery of invitation links.

MFA can be required by the external IdP, but Workspace does not yet independently verify or require a particular MFA authentication-context claim.

Because Workspace creates its own 12-hour session after OIDC login and does not retain the IdP refresh token, disabling a user at the IdP does not currently invalidate an already-issued Workspace session immediately. Administrators must deactivate membership/revoke Workspace sessions until directory lifecycle/back-channel revocation is implemented.

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
- normal non-SSO Docker and Chromium workflows.

A real Keycloak deployment test remains a separate host-level acceptance step.
