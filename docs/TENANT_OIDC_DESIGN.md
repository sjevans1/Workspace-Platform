# Tenant-scoped OIDC: implementation gate

Status: **design and factory groundwork only**. Deployment-level OIDC is still the only active sign-in path. The explicit `oidcFromConfig` factory is inert until a separately reviewed tenant-aware flow is implemented, tested, and deployed. Do not claim tenant SSO is available yet.

## Existing security contracts to preserve

- Users are global; memberships and authorization are tenant-scoped. Identity `(issuer, subject)` must never create membership by itself.
- The existing authorization-code + PKCE S256 + state + nonce + signed JWT + verified-email boundaries remain mandatory.
- Real Keycloak logout and SCIM offboarding must continue to revoke the correct tenant sessions without changing `workspace_runtime` `NOBYPASSRLS`.
- Deployment-level `OIDC_*` settings remain backwards-compatible for current installations.
- No direct IdP group/claim-to-admin mappings. SCIM Groups map only to `member` or `guest`, after explicit Workspace owner/admin action.

## Next implementation, split into independently verified PRs

### Gate T1: explicit provider construction [this PR]

Extract immutable settings into `oidcFromConfig(settings)`, retain `oidcFromEnv()` as a backwards-compatible adapter, and exercise independent instances and fail-closed configurations. **No tenant selection endpoints or persistence in this step.**

### Gate T2: provider registration and isolation

Create a tenant-owned provider registry with a stable opaque provider identifier, enabled/revoked state, revision, issuer, client ID, authentication method, scopes, verified-email policy and **encrypted server-only secret**. Use runtime-enforced tenant RLS, explicit owner/admin management with CSRF, no secret read-back, audit, and backup/recovery coverage. Never let an untrusted request set `allowInsecure`. Restrict discovery and JWKS URLs against SSRF (HTTPS, safe destination policy including redirects and DNS/IP validation); prevent broad or private-network endpoint probes except explicitly operator-approved private IdP hosts.

An operator may configure a provider, but that alone never creates users, memberships or roles. Existing deployment-level OIDC cannot be silently displaced by tenant data.

**Administrative UI (separate slice):** Settings → Integrations includes a disabled-only identity-provider registry. Owners and admins can register HTTPS issuer, client ID, token-endpoint authentication method and optional encrypted secret, view non-secret metadata and revoke an entry. The operator's explicit `OIDC_TENANT_ISSUER_ORIGINS` allowlist still governs acceptance. No secret is returned after creation, and neither an IdP registration nor this UI enables sign-in; no network discovery occurs. The disposable CI browser uses only the synthetic allowlisted `https://login.example.test` issuer to exercise the workflow; this is not production configuration.

### Gate T3: login binding and authentication

**T3a (schema-only foundation, separate PR):** add nullable tenant, provider ID, provider revision, expected issuer and client ID to one-time authorization states. An all-or-none database constraint and composite foreign key reject incomplete or cross-tenant bindings. The nullable legacy form keeps existing deployment-level sign-in operational. **This does not select or activate tenant IdPs and does not validate IdP discovery endpoints.** T3b must enforce exact registration/revision matching and network egress safety before any provider-specific start or callback is enabled.

Require a tenant and provider selected through a trusted, deterministic route. Persist tenant ID, provider ID, revision, expected issuer/client ID, PKCE verifier, nonce, invite hash and return path against a single-use, time-limited state. A callback must load that original exact tenant/provider, reject revoked/changed registrations or mismatched issuer, and never derive provider from query parameters, email domain, ID-token claims, cookies from another flow, or a generic first active membership.

Invitation-backed provisioning must verify that the invitation belongs to the state-bound tenant. An existing global user may gain a session only for the state-bound tenant if that membership is already active. Explicitly reject a cross-tenant provider attempting to authenticate a different tenant by selecting an already-linked global email.

### Gate T4: session transition and logout

**Early isolation hardening (separate PR):** issuer-bound deployment OIDC sessions are refused by `/auth/switch` instead of being silently reissued as local sessions. A separate, independently authenticated local session may still switch among memberships. This addresses the existing downgrade path but **does not** complete provider-ID provenance, provider-scoped logout, or T4 acceptance.

Persist provider-ID and tenant provenance on the OIDC-created session. Existing `/auth/switch` currently issues a fresh session without that OIDC provenance; restrict it so provider-bound identities cannot cross into another tenant without authenticating under the destination tenant's approved provider, or an independently verified qualifying local session. Do not silently drop the binding.

For back-channel logout, validate signed logout JWTs with the original provider keys, issuer and audience; restrict revocation by provider ID + tenant (including replay-JTI scope). Stable per-provider back-channel routing must not trust user-supplied issuer/header to choose verification keys. Document disabling a provider and revoking relevant sessions. Preserve unrelated tenants and independent local break-glass sessions.

### Gate T5: acceptance before merge

Exercise two tenants with separate real/disposable issuers, overlapping email addresses, distinct subject values, different client authentication methods, malicious callback mixing, expired/replayed state, invitation tenant mismatch, disabled provider, rotated secret, same-tenant logout, cross-tenant logout isolation, group-role boundary, local-account preservation, RLS, backup/restore and migration checks. Keep the existing native PostgreSQL and release gates: encrypted storage recovery, Docker startup/health, SBOM/Trivy, deployed Chromium/Firefox and trusted TLS/WSS.

**Hold point:** Do not expose new tenant-IdP UI to customers or merge a tenant-aware login implementation until all T2–T5 gates pass.
