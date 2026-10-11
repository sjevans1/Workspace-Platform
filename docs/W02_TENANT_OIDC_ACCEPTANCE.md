# W02 tenant IdP activation — acceptance record

Wave X X4b-1. Covers tenant OIDC provider activation and exact callback binding.
This record describes the native matrix, the real two-issuer acceptance lane, and
the environment limitation encountered while building it.

## Delivered surface (W02 only)

- Explicit operator/admin activation of a registered tenant provider, with the
  previously dormant schema constraint converted into a fail-closed activation
  invariant (migration `024_tenant_provider_activation.sql`).
- Explicit `tenant` + `provider` selection at `GET /auth/oidc/start`, binding
  `tenant_id`, `provider_id`, `provider_revision`, `expected_issuer` and
  `expected_client_id` into the existing single-use login state.
- Exact callback revalidation of every bound field before any token exchange,
  with the bound membership selected as the session's tenant.
- A tenant-bound callback works with deployment-level OIDC completely unset, and
  neither path can silently borrow the other.
- No W03 (logout/revocation) behaviour was introduced. Recording session
  issuer/subject provenance that W03 will later consume is not a semantic change.

## Native acceptance

`tests/integration.test.ts`, real PostgreSQL:

- W02 adversarial matrix: provider created disabled; disabled provider cannot
  start; non-admin cannot activate; activation bumps the revision; tenant without
  provider and provider without tenant both fail; cross-tenant provider selection
  fails; all five binding fields persisted together; unknown/replayed state fails;
  provider disabled, revoked or revised after start fails at callback; issuer
  mismatch and client-ID mismatch fail; invitation tenant mismatch fails; a user
  with memberships in both tenants lands in the explicitly bound tenant; session
  provenance recorded; no IdP group/claim yields owner/admin; deployment-level OIDC
  unchanged; local break-glass unchanged.
- Permanent tenant-only regression: with deployment `oidc = null`, a tenant-bound
  start and callback succeed, land in the bound tenant and record provenance,
  while an unbound deployment-level start and an unbound callback still return the
  existing not-configured behaviour. This case is invisible to the main matrix,
  which injects a non-null deployment provider — the blind spot the real lane
  exposed.

## Real-provider acceptance lane

Environment: disposable Keycloak 26.7.4 over HTTPS, two isolated realms used as two
distinct issuers, each with its own client, client secret and subject namespace,
and one user per realm deliberately sharing the same verified email.

Trust model: a disposable self-signed CA whose certificate is supplied to the API
process through `NODE_EXTRA_CA_CERTS`, the same mechanism the CI workflow already
uses for trusted-TLS acceptance. No global TLS verification bypass is used and no
tenant-provider policy is relaxed: the issuer must still be HTTPS, must still pass
the operator issuer allowlist, and the same validation is re-checked at provider
use time. Browser TLS relaxation (`ignoreHTTPSErrors`) is confined to the
disposable acceptance browser context.

Note on the issuer hostname: the tenant issuer validator deliberately rejects
hostnames ending in `.localhost` (and `.local`, and IP literals). The lane
therefore uses a hostname that resolves to loopback without a hosts entry and does
not match those patterns. This is the policy working as intended, not a
restriction to work around by relaxing validation.

Procedure (reproducible outline):

1. Generate a disposable CA and a server certificate for the chosen issuer
   hostname; start a disposable Keycloak with that certificate on HTTPS and with
   one realm per tenant.
2. Start the API with `NODE_EXTRA_CA_CERTS` pointing at the disposable CA and
   `OIDC_TENANT_ISSUER_ORIGINS` set to the approved issuer origins.
3. Register both providers through the real API (`POST /identity/providers`) and
   confirm each starts disabled; activate each through
   `PATCH /identity/providers/:id`.
4. Invite the shared verified email into each tenant through the real invitation
   path, then drive the browser authorization-code flow per issuer
   (`/auth/oidc/start?tenant=…&provider=…&invite=…` → Keycloak login form →
   callback → session).
5. Assert the landing tenant from `/api/v1/me`, the recorded session issuer and
   subject, and the `oidc_identities` rows.

Results observed:

- issuer A flow: `/me` 200, landed in tenant A, session provenance issuer A with
  subject A;
- issuer B flow: `/me` 200, landed in tenant B, session provenance issuer B with
  subject B;
- the overlapping verified email mapped to one internal Workspace account, which
  is legitimate account linking, while the two `oidc_identities` rows remained
  distinct external identities (different issuer, different subject). The email
  did not collapse the external identity boundary, and neither identity could be
  substituted for the other;
- invitation-backed provisioning was required and worked; an unprovisioned SSO
  identity is correctly refused.

No tokens were fabricated: the flows use genuine authorization redirects, genuine
authorization codes and genuine Keycloak token exchange.

## Environment limitation (recorded accurately)

The containerised local Workspace lane could not be built in this sandbox: the
image build failed at `npm ci` twice, first with a network reset (`ECONNRESET`) on
the default bridge and then with a termination (`SIGTERM`, exit 143) under host
networking. This is an environmental limitation of the sandbox image build, not a
product defect, and no production policy was weakened to work around it. The lane
was therefore run as a direct API process (`node --import tsx apps/api/src/main.ts`)
against a disposable database, which still exercises the production provider
construction path, real HTTPS discovery, the real Keycloak authorization endpoints
and the real callback/session code. Authoritative exact-head deployment CI remains
required to close the packaged/deployment dimension.

## Safety and cleanup

Disposable credentials only. No CA private key, server certificate, realm or client
secret, password, cookie, authorization code, access token or ID token is recorded
here or committed. The disposable Keycloak instance, lane database, lane API
process and all temporary lane files are outside the repository; lane scratch
material was removed before the pull request and no accepted source or recovery
environment was touched.
