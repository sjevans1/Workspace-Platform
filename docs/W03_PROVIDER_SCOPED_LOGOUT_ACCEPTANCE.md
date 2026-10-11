# W03 provider-scoped back-channel logout acceptance

Wave X / X4b-2. Frozen implementation head: `77c65bd780635602892339af270fb26ac68c97f8`
on `feature/wave-x-x4b2-w03-logout`, based on accepted `main@6634033`.

## Architecture of provider-scoped validation

A Back-Channel Logout Token's claimed issuer is untrusted input. It is used only to
SELECT candidate providers:

- `oidc_tenant_providers_by_issuer(issuer)` (migration 025) returns the tenant
  providers for that exact issuer that are activated, enabled and unrevoked, plus
  the deployment-level OIDC provider when it owns the same issuer.
- Each candidate then verifies the token with its OWN configuration (issuer,
  audience/client, signature). A candidate that cannot verify contributes nothing.
- Provider scope becomes trusted only after that provider successfully validates
  the token. The unverified JWT payload never authorizes anything.
- Exactly one validation context is required. Zero fails closed. More than one
  fails closed as ambiguous, so configuration or database ordering can never
  choose which provider is allowed to revoke sessions.
- There is no fallback between tenant and deployment paths.

Revocation is provider-scoped. Both the SID and the subject-only paths delete only
sessions where `oidc_issuer` matches the validated issuer AND
`oidc_provider_id IS NOT DISTINCT FROM` the validated provider scope, together with
the SID or subject match. Provider A therefore cannot revoke provider B's sessions,
even when both share an issuer and use different clients, and overlapping emails
cannot cause cross-provider revocation.

## oidc_provider_id semantics

Migration 026 adds `sessions.oidc_provider_id` (uuid, nullable):

- tenant-provider session: the exact tenant provider that created it;
- deployment-level OIDC session: NULL, the explicit deployment scope;
- local/password session: NULL, with no OIDC provenance at all.

`createSession` persists it (object argument, so no positional-argument ambiguity),
and the W02 callback stores the exact bound `pending.provider_id`.

## Migration 026 upgrade behavior

Pre-026 OIDC sessions cannot be attributed to a provider without guessing, and an
issuer-only backfill is ambiguous whenever an issuer is registered more than once.
The migration therefore invalidates existing OIDC sessions once and SSO users
reauthenticate:

- SQL: `DELETE FROM sessions WHERE oidc_issuer IS NOT NULL`;
- local/password sessions carry no issuer and are preserved;
- no issuer-only backfill and no guessed provider id;
- the column is nullable and there are two provider-scoped indexes;
- there is intentionally NO foreign key on `oidc_provider_id`, so provider
  revocation cannot cascade session deletion.

Determinism is at the migration-runner level: applied migrations are immutable, so
re-running the migrator is a clean no-op.

## Native acceptance

Permanent tests in `tests/integration.test.ts`, all green in both orders tested
(W02 first, then W03; and W03 first):

- issuer selects candidates, unknown issuer fails at the not-configured boundary;
- active candidate that cannot verify the token fails closed at validation;
- disabled provider is not a candidate; revoked provider is not a candidate;
- same issuer with different clients: A validates only through A, B only through B;
- SID-scoped revocation and subject-only provider-scoped revocation;
- overlapping issuer/subject/email does not weaken the boundary;
- replay is deduplicated and revokes nothing additional;
- tenant+tenant ambiguity fails closed with no session deletion, no accepted JTI
  and no audit event;
- deployment+tenant ambiguity fails closed with the same zero side effects;
- migration 026 upgrade regression (legacy OIDC invalidated, local preserved, no
  backfill, nullable column, no provider FK, indexes present);
- W02 session provenance through the real creation path: tenant-bound session
  records the exact provider id, deployment session records NULL, local session
  records no OIDC provenance.

## Real-provider acceptance

Keycloak 26.7.4 over HTTPS. The API trusted Keycloak through `NODE_EXTRA_CA_CERTS`.
No API TLS-verification bypass was introduced, and `ignoreHTTPSErrors` applied only
to the disposable browser context. Two realms (`realm-a`, `realm-b`) each held the
same verified email with distinct issuer+subject identity, so the overlapping-email
case is exercised for real.

Genuine authorization-code flows were driven through the live start route and the
Keycloak 26 login form, with invitation-backed provisioning for the SSO identity.
Genuine Keycloak-emitted signed Logout Tokens were produced by terminating the
Keycloak user session through the admin API (HTTP 204). No logout token was
manufactured by the lane.

Isolation matrix, from real signed events:

```
before         A=200  B=200  local=200
terminate A -> 204
after A logout A=401  B=200  local=200
terminate B -> 204
final          A=401  B=401  local=200
```

Database evidence:

- exactly one `auth.oidc_backchannel_logout` audit event in each affected tenant,
  and no audit event for the unaffected tenant;
- three genuine Logout Tokens processed per issuer; duplicate/replayed delivery
  produced no additional revocation;
- tenant-provider sessions were removed and local/password sessions preserved;
- `workspace_runtime` and `workspace_app` remain `rolsuper = false` and
  `rolbypassrls = false` (NOBYPASSRLS).

## Known non-blocking limitation

The optional same-realm / two-client real Keycloak topology was NOT executed. The
permanent native suite proves that exact isolation model cryptographically (two
providers on one issuer with different clients, where only the matching client
validates and neither revokes the other), and the real two-issuer lane proves the
genuine protocol integration. No real-provider proof was fabricated to remove this
note.

## Environment note

The disposable Keycloak harness clients carry the pre-existing `redirectUris: ["*"]`
from the earlier lane. That is disposable harness configuration, not a W03 product
defect. If the environment is reused, the redirect URIs should be tightened to the
exact lane callbacks as hygiene.

This record contains no client secrets, passwords, session cookies, authorization
codes, logout tokens or CA private keys.
