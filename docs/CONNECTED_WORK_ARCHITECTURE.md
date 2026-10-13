# Connected Work architecture (W29-A)

W29-A is the provider-neutral connector plane for Workspace: a governed control
plane that lets an operator register an external provider, hold its credential,
sync from it, receive its events and invoke its declared actions, without any
provider-specific behaviour leaking into Workspace domain code. The plane is the
first half of the promoted W29/W30 scope and supplies the external event and
action boundary that the deterministic workflow engine in
[Automation architecture](AUTOMATION_ARCHITECTURE.md) consumes.

The connector plane is implemented in `packages/connectors` and is exposed at
`/api/v1/connectors/*` by `apps/api/src/connected-work.ts`, registered from
`apps/api/src/app.ts`. The worker phases that claim syncs and dispatch connector
events live in `apps/worker/src/connected-work.ts` and run inside the existing
worker tick in `apps/worker/src/worker.ts`.

## Boundaries

- **Optional and off by default.** No connector is required for Workspace to
  install, start, serve or pass acceptance. Nothing in the connector plane runs
  unless an operator creates a connection.
- **A Workspace with zero connected providers is fully functional.** Every core
  capability (pages, databases, search, files, comments, events, webhooks,
  workflows) works with `connector_connections` empty.
- **No external account is contacted in this tranche.** The only registered
  provider is the deterministic synthetic adapter `SYNTHETIC_HOOKS` in
  `packages/connectors/adapter.ts`, which performs no network I/O.
- **No provider integration is implemented in this tranche.** Gmail, Microsoft
  Graph, IMAP/SMTP, Google Calendar, Microsoft Calendar, CalDAV, Telegram,
  Discord and WhatsApp are declared as metadata only. See
  *Deferred to the next tranche*.
- **A connector holds external authority, never Workspace authority.** An adapter
  cannot read or widen a Workspace permission. Authorization, tenant isolation,
  idempotency, run recording and audit belong to the connector runtime and the
  workflow engine, not to the adapter.

## Status in this tranche

Implemented and present in the tree:

| Item | Location |
|---|---|
| Provider registry, capability vocabulary and catalog | `packages/connectors/registry.ts` |
| Provider adapter contract and the synthetic adapter | `packages/connectors/adapter.ts` |
| Credential envelope, metadata allowlist, ingress token digest | `packages/connectors/credentials.ts` |
| Failure classification, retry policy and backoff | `packages/connectors/failure.ts` |
| Connection, sync, event and ingress runtime | `packages/connectors/runtime.ts` |
| Synthetic adapter registration on import | `packages/connectors/index.ts` |
| Storage and definer helpers | `infrastructure/migrations/029_connected_work.sql` |
| HTTP surface for connections, credentials, events and ingress | `apps/api/src/connected-work.ts` |
| Bounded sync and automation worker phases | `apps/worker/src/connected-work.ts` |
| Connection management component (front end) | `apps/web/components/Connections.tsx` |

Deferred and NOT implemented here: every real provider adapter, every OAuth
endpoint, every provider-backed action (send mail, create or cancel a calendar
event, post to a messaging channel), the Connections browser interface, real
provider acceptance evidence and the operator runbook for provider onboarding.
Declared-but-unimplemented providers are reported honestly in the catalog as
`implemented: false`.

## Provider, connection and capability hierarchy

| Level | Authority | Identity |
|---|---|---|
| Provider | `ProviderDefinition` in `packages/connectors/registry.ts` | `ProviderDefinition.key`, for example `synthetic-test` |
| Connection | `connector_connections` | `id` uuid, `UNIQUE(tenant_id,id)` |
| Credential | `connector_credentials` | `(connection_id, kind)`, one active row per kind |
| Sync checkpoint | `connector_sync_state` | primary key `(tenant_id,connection_id)` |
| Event | `connector_events` | `UNIQUE(tenant_id,connection_id,dedupe_key)` |
| Action | `ProviderDefinition.actions` plus `AdapterHooks.action` | action key, for example `synthetic.record` |

A provider is a versioned definition (`adapter_version`, semantic). A connection
is a tenant-scoped instance of exactly one provider. Capabilities are a versioned
vocabulary held per connection in `capabilities_requested` and
`capabilities_granted`. Resources are opaque references carried on an event
(`normalized_resource_refs`, at most 16 entries per event). Events are normalized
provider deliveries. Actions are the declared operations a connection may invoke.

## The provider adapter contract

`packages/connectors/adapter.ts` defines `AdapterHooks`. An adapter authenticates
its own inbound requests, normalizes them, reports bounded health, performs a
bounded incremental sync and executes its own declared actions. Every hook and its
boundary:

| Hook | Input | Output | Boundary |
|---|---|---|---|
| `capabilities` | none | `Capability[]` | Must contain every capability the provider declares. `registerAdapter` asserts this at load time. |
| `verifyInbound` | `InboundRequest` (`headers`, parsed `body`, decrypted `secret`) | `{verified, reason?}` | Runs BEFORE normalization. The generic runtime never reads provider headers itself. |
| `normalizeInbound` | `InboundRequest` | `NormalizedEvent \| null` | Only ever called on a request that verified. `null` means nothing to record. |
| `health` | `{config}` | `{ok, category?, detail?}` | Read-only probe. Never granted authority; the runtime applies the resulting status. |
| `sync` | `{cursor, limit, config}` | `{events, next_cursor}` | Bounded incremental read. The cursor is opaque to the caller and only the owning adapter may interpret it. |
| `action` | `{action, capability, config, payload}` | `Record<string, unknown>` | The adapter's own declared action only. The caller has already checked Workspace authority and the connection's granted capability. |

`InboundRequest.secret` is the decrypted verification material for that
connection. It is documented as never logged, and the runtime passes an empty
string when it calls `normalizeInbound`, so a normalizer cannot retain the secret.
`headerOf()` handles array-valued and case-normalized headers.

Hooks never touch Workspace authorization, tenant isolation, run recording,
idempotency or audit. `AdapterHooks.action` receives no tenant, no role and no
Workspace session; the capability check happens before it is called.

`SYNTHETIC_HOOKS` is the only registered implementation. It compares
`x-connector-token` against the decrypted secret by equal length plus
`Buffer.equals`, requires `event_type` (up to 120 characters) and
`provider_event_id` (up to 256 characters), defaults `dedupe_key` to
`provider_event_id`, caps `resource_refs` at 16 entries, accepts only a bounded
`summary` (400 characters) and `priority` (40 characters) as event metadata,
generates up to 50 `synthetic.tick` events from a numeric cursor bounded to
`0..1000000`, and executes exactly one action, `synthetic.record`.

## Provider registry and the declared provider keys

`packages/connectors/registry.ts` is the whole provider vocabulary. Registration
validates rather than trusts: `validateProviderRegistration` asserts a key
matching `^[a-z][a-z0-9-]{1,63}$`, a non-empty display name, a semantic
`adapter_version`, at least one known auth mode, at least one valid ownership
kind, at least one registered capability, action keys matching
`^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,3}$` with no duplicates, every action's
`requires_capability` declared by that same provider, at least one known
credential kind, `webhook_secret` whenever `webhook` is true, a poll interval in
`60..86400` whenever `polling` is true, and an event metadata bound in
`256..8192`. A malformed definition fails at module load, so an invalid provider
is never reachable at runtime.

`PROVIDER_REGISTRY` holds only validated definitions. `providerDefinition(key)`
throws 400 for an unknown key, `providerKeys()` lists the registered keys,
`providerCatalog()` is the catalog an administrator may request a connection
against, and `declaredProviders()` returns the future keys as
`{key, implemented: false}`.

`DECLARED_PROVIDER_KEYS` contains exactly `google-mail`, `microsoft-mail`,
`imap-smtp`, `google-calendar`, `microsoft-calendar`, `caldav`, `telegram`,
`discord` and `whatsapp`, sorted in the catalog output. A declared provider is
metadata only: it has no adapter, no credential handling and no action, and
`adapterImplemented(key)` returns false for it. Requesting a connection against a
declared-but-unimplemented key fails with 400 from `providerDefinition`, because
no definition exists for it.

Adapter hooks are attached per provider through `ADAPTER_HOOKS`,
`registerAdapter(key, hooks)` and `adapterFor(key)`. `adapterFor` throws 500 when
a registered provider has no adapter, which is how the runtime refuses to pretend
a provider works.

`packages/connectors/index.ts` registers `SYNTHETIC_HOOKS` for
`SYNTHETIC_PROVIDER_KEY` (`synthetic-test`) at module load, so importing the
package is enough to have one complete, exercisable provider with no external
account and no credential.

## Capability vocabulary

`CONNECTOR_CAPABILITIES` is the versioned vocabulary, stamped by
`CAPABILITY_VOCABULARY_VERSION` (`1.0.0`, bumped whenever a capability changes
meaning):

`mail.read`, `mail.search`, `mail.send`, `mail.reply`, `calendar.read`,
`calendar.create`, `calendar.update`, `calendar.cancel`, `calendar.freebusy`,
`message.receive`, `message.send`, `message.reply`, `connection.health`,
`connection.sync`.

`CAPABILITY_CATEGORY` maps each capability to a display category: `email`,
`calendar`, `messaging` or `connector_management`. `isCapability()` type-guards a
value. `normalizeCapabilities()` rejects an unknown capability string rather than
dropping it, so a caller can never believe it was granted something that does not
exist, and it deduplicates and sorts. `defaultCapabilities(definition)` requests
every capability the provider declares.

Requested and granted capabilities are separate columns. A new connection stores
`capabilities_requested` and an empty `capabilities_granted`. Capabilities become
granted only when `connectConnection` establishes the connection, in the same
statement that sets `status='connected'`, and `revokeConnection` clears
`capabilities_granted` back to `{}`. An action may run only when the connection
holds its required capability.

## Connection ownership and authorization

`ownership` is one of `user` or `tenant`, and it is explicit:

- `user` is a delegated connection. It has an `owner_user_id` and is readable and
  manageable by that user, and by a tenant owner or administrator.
- `tenant` is a shared tenant resource. `owner_user_id` is null. It is readable by
  tenant members and manageable only by a tenant owner or administrator.

`canReadConnection`, `canManageConnection` and `isTenantAdministrator` in
`packages/connectors/runtime.ts` implement those rules. A normal member can never
manage a shared company mailbox, bot or calendar, and an unrelated user can never
read a delegated connection. `createConnection` refuses `tenant` ownership for a
non-administrator with 403 and refuses an ownership kind the provider does not
declare with 400. A connection the caller may not see reports 404 from
`loadConnection`, never 403, so the API cannot be used to enumerate connections.

Ownership is immutable. The database enforces it twice: the `CHECK` constraint on
`connector_connections` binds `ownership='user'` to a non-null `owner_user_id` and
`ownership='tenant'` to a null one, and the trigger
`connector_connections_identity_immutable` (function
`workspace_connector_connection_identity_guard`) raises an exception if an update
changes `tenant_id`, `id`, `provider_key`, `ownership`, `owner_user_id`,
`created_by` or `created_at`. Authorization decisions are bound to exactly those
columns, so a connection may be relabelled, disabled, revoked or reconnected, but
it can never silently change owner, tenant or provider and thereby inherit a
different authorization outcome.

## Connection lifecycle and timestamps

`status` is one of `pending`, `connected`, `attention_required`, `disabled`,
`revoked`, `error` (`ConnectionStatus` in `packages/connectors/failure.ts`).

| Transition | Function | Effect |
|---|---|---|
| Created | `createConnection` | `status='pending'`, `enabled=true`, `capabilities_granted='{}'`, `created_at` set; a `connector_sync_state` row is created with the provider's `default_poll_interval_seconds` |
| Established | `connectConnection` | `status='connected'`, `enabled=true`, `connected_at=now()`, capabilities granted, `disabled_at`/`attention_reason`/`last_error_*` cleared |
| Disabled | `setConnectionEnabled(false)` | `enabled=false`, `status='disabled'`, `disabled_at=now()` |
| Re-enabled | `setConnectionEnabled(true)` | `enabled=true`, `status='connected'` when it was `disabled`, `disabled_at` cleared |
| Needs a human | `applyConnectionAttention` | `status='attention_required'` unless it is `revoked` or `disabled`, `attention_reason` (up to 200 characters), `last_error_at`, `last_error_category` |
| Credential replaced | `rotateConnectionCredential` | `attention_required` returns to `connected`, `attention_reason` and `last_error_*` cleared |
| Revoked | `revokeConnection` | `status='revoked'`, `enabled=false`, `revoked_at=now()`, `capabilities_granted='{}'`, `attention_reason='Revoked by an administrator'`, credentials revoked and cursor destroyed |

Timestamps: `created_at`, `updated_at`, `connected_at`, `disabled_at`,
`revoked_at`, `last_success_at`, `last_sync_at`, `last_event_at`, `last_error_at`
plus `last_error_category` and `attention_reason`. A database `CHECK` requires
`revoked_at` to be set whenever `status='revoked'`.

Enabling a `pending` connection fails with 409 (`Connect the provider before
enabling it`), and a `revoked` connection cannot be reconnected, enabled, rotated
or tested (409 in each case). Revocation is deliberately one way.

## Credential lifecycle

Credential material is sealed with the existing Workspace encryption primitive:
AES-256-GCM under the deployment `ENCRYPTION_KEY` (validated as 64 hexadecimal
characters), stored in `connector_credentials.secret_encrypted` as the base64url
`iv.tag.ciphertext` envelope that `sealCredential` produces and `openCredential`
reads. The ciphertext is bound to its scope by additional authenticated data:
`credentialAad(tenant, connection, kind)` returns
`` `${tenant}:${connection}:${kind}:v1` ``. A ciphertext moved to another tenant,
connection or kind therefore fails to open, so a copy or a cross-tenant lookup
cannot read someone else's secret.

Storage carries two strictly separated halves:

- `secret_encrypted`: ciphertext only. It is never returned to a client, never
  logged, never audited and never placed in a support bundle.
- `metadata`: non-secret descriptors only, restricted to the allowlist
  `CREDENTIAL_METADATA_KEYS` (`token_digest`, `scopes`, `expires_at`,
  `algorithm`, `key_id`, `label`, `chat_id`, `account_hint`).
  `sanitizeCredentialMetadata` drops every other key, truncates strings to 512
  characters and caps an array value at 32 string entries. A raw token, a refresh
  token or an authorization header is therefore dropped rather than stored.

What must never be returned or logged: `secret_encrypted` in any form, any
decrypted secret, any OAuth access or refresh token, any bot token, API key,
client secret or SMTP credential, and any `Authorization` header.
`assertNoSecretMaterial(serialized)` is the adversarial guard used by the status
projection and the acceptance suite; it rejects a serialized structure matching
`/secret_encrypted|client_secret"|refresh_token|access_token|bot_token"|api_key"|-----BEGIN/`.
`publicCredential(row)` builds the only credential shape a caller receives, and
`publicConnection()` builds the only connection shape a browser receives.

Lifecycle:

- `putCredential(q, tenant, connection, kind, secret, metadata)` stores a
  credential. It reads the active predecessor of the same kind, computes
  `key_version` as `MAX(key_version)+1`, REVOKES the predecessor and then inserts
  the replacement, both inside the caller's transaction. The revoke-first order is
  load-bearing: the partial unique index `connector_credentials_active` permits at
  most one non-revoked credential per `(tenant_id, connection_id, kind)`, so
  inserting while the predecessor is still active is rejected and rotation would
  always fail. Because the two statements share a transaction, a rotation either
  lands completely or not at all, so an interrupted rotation never leaves the
  connection without usable material.
- `rotateConnectionCredential` is the route-level rotation. A rotation that ends
  in `attention_required` returns the connection to `connected`.
- `readCredential` reads and decrypts the active credential of one kind, or null.
  It is used by the ingress path only.
- `revokeCredentials` marks every active credential of a connection revoked and
  returns the count. `revokeConnection` calls it, then clears the cursor, so a
  revoked connection retains no material and no checkpoint.
- `credentialsFor` returns the metadata history for a connection, ordered by kind
  then newest first, and is included in the API response only for a caller who may
  manage the connection.
- A connection's own non-secret configuration is held in
  `connector_connections.config`, sanitized through the same allowlist and capped
  at 8192 bytes by both the runtime (`CONNECTOR_LIMITS.max_config_bytes`) and the
  database (`CHECK(pg_column_size(config) <= 8192)`).

Credential kinds: `oauth_access`, `oauth_refresh`, `api_key`, `bot_token`,
`client_secret`, `webhook_secret`, `basic` (`CREDENTIAL_KINDS`), matching the
database `CHECK` on `connector_credentials.kind`. Each provider declares which
kinds it uses in `credential_kinds`. `connectConnection` and
`rotateConnectionCredential` seal a caller-supplied secret (16 to 4096
characters) under `definition.credential_kinds[0]`, and for a provider with
`webhook` true they also store an irreversible ingress token digest,
`tokenDigest(secret)` = SHA-256 of `connector-ingress:<token>`, in the credential
metadata under `token_digest`.

## Authentication contracts for provider adapters

`AUTH_MODES` declares the modes a future adapter may use:
`oauth2_authorization_code_pkce`, `oauth2_authorization_code`, `api_key`,
`bot_token`, `basic`, `none`. The synthetic provider uses `none` and holds a
`webhook_secret` so its ingress path can be authenticated.

The contract the next tranche must implement:

- **OAuth 2.0 authorization code.** The provider declares
  `oauth2_authorization_code` or `oauth2_authorization_code_pkce`. The adapter
  obtains an authorization code, exchanges it for tokens, and the tokens are
  sealed as `oauth_access` and `oauth_refresh` credentials with `scopes` and
  `expires_at` in the sanitized metadata. The authorization request must carry a
  `state` value bound to the connection and the initiating session, verified on
  the callback, and the PKCE code verifier must be stored with the same
  connection binding so a callback for one connection cannot establish another.
- **Refresh.** An expired access token is refreshed by the adapter using the
  sealed refresh token, and the replacement is written with `putCredential` so the
  predecessor is revoked rather than overwritten.
- **Revocation.** Revoking a connection revokes its credentials locally through
  `revokeCredentials`; an adapter that supports provider-side revocation must call
  it and classify a failure through `classifyProviderFailure`.
- **Static secret.** A provider that authenticates with a bot token, an API key or
  an SMTP or IMAP credential declares `api_key`, `bot_token` or `basic` and stores
  one credential of that kind. `connectConnection` already accepts such a secret
  from an operator, seals it and never echoes it.
- **Inbound authentication.** Any provider with `webhook` true must declare
  `webhook_secret`, and its adapter must implement `verifyInbound`. Verification
  runs before normalization, and the provider-neutral runtime resolves the
  connection from an irreversible token digest, never from a tenant supplied by
  the request.

**No OAuth endpoint is implemented in this tranche.** There is no authorization
redirect, no callback route, no PKCE verifier store, no token exchange, no refresh
scheduler and no provider-side revocation call anywhere in the tree. The auth
modes above are declared metadata that a future adapter is validated against; the
only authentication path that executes today is the synthetic provider's inbound
token comparison.

## Sync and checkpoint semantics

`connector_sync_state` is keyed `(tenant_id, connection_id)` and holds the sync
checkpoint: `cursor`, `sync_generation`, `status`
(`idle`, `pending`, `running`, `failed`, `attention`), `poll_interval_seconds`
(bounded `60..86400`), `consecutive_failures`, `attempts`, `last_attempt_at`,
`last_success_at`, `next_attempt_at`, `lease_token`, `lease_expires_at`,
`last_error_category` and `last_error_summary` (up to 200 characters).

- **Provider cursors are opaque.** The cursor column is documented as opaque to
  generic Workspace code; only the owning adapter may interpret it. The runtime
  passes it to `AdapterHooks.sync` and stores what the adapter returns, up to 4096
  characters. No generic code parses, compares or synthesizes a cursor.
- **A failed sync may not advance the cursor.** The cursor is written in exactly
  one place, the single `UPDATE` inside `completeSync`, which advances it with
  `COALESCE($4,cursor)` and simultaneously records `status='idle'`,
  `sync_generation=sync_generation+1`, `consecutive_failures=0`,
  `last_success_at`, the next attempt instant and a cleared lease, and only for a
  row that is still `status='running'` and still owned by this lease token.
  `failSync` never names the cursor column, so a failed sync leaves the checkpoint
  exactly where the last successful sync left it.
- **Connecting queues the first sync.** `connectConnection` sets the connection's
  sync row to `pending` with `next_attempt_at=now()`, so a freshly connected
  provider is picked up by the worker rather than sitting `idle` until an operator
  presses sync. Enabling a connection queues it again when it is still `idle`.
- **Claiming is leased and bounded.** `claimDueSync` selects at most
  `CONNECTOR_LIMITS.sync_claim_batch` (10) rows joining `connector_sync_state` to
  `connector_connections` where the connection is `enabled` and `status='connected'`,
  the sync status is `pending` or `failed`, `next_attempt_at <= now()` and the
  lease is free or expired, ordered by `next_attempt_at` then `connection_id` with
  `FOR UPDATE OF s SKIP LOCKED`. It then sets `status='running'`, a fresh
  `lease_token` (`randomUUID()`), `lease_expires_at = now() + 120 s`
  (`CONNECTOR_LIMITS.sync_lease_seconds`), `last_attempt_at=now()` and
  `attempts=attempts+1`, and returns a `SyncClaim` carrying the provider key, the
  cursor, the connection config, the lease token, the attempt number and the poll
  interval.
- **Completion is lease-checked.** `completeSync` and `failSync` both act only
  where `status='running' AND lease_token=$3`, so a worker that lost its lease
  cannot overwrite the outcome recorded by the worker that took over.
- **Failure escalates visibly.** `failSync` increments `consecutive_failures` and
  sets `status='attention'` when the failure is not retryable or when
  `consecutive_failures` reaches `RETRY_POLICY.attention_after_failures` (5),
  otherwise `status='failed'` with a bounded `next_attempt_at`. A retryable
  failure of an otherwise healthy connection records the error against the
  connection (`last_error_at`, `last_error_category`) without changing its status;
  a terminal failure moves the connection to `attention_required`.
- The worker phase `connectorTick` in `apps/worker/src/connected-work.ts` performs
  the provider call with no database transaction held, records every returned
  event with `recordConnectorEvent`, and then calls `completeSync` or `failSync`
  in a short tenant transaction. The poll interval for the next attempt comes from
  `connector_sync_state.poll_interval_seconds`.

## Webhook and event ingress

`POST /api/v1/connectors/ingress/:connectionId` is registered by
`registerConnectorIngress` in `apps/api/src/connected-work.ts`. It carries no
session. `ingestProviderEvent` in `packages/connectors/runtime.ts` is the whole
flow, and the order is deliberate:

1. The connection id must match `^[0-9a-f-]{36}$/i` (both in the route and in
   `ingestProviderEvent`) and the request body must be within
   `CONNECTOR_LIMITS.max_config_bytes * 4` bytes, enforced by
   `registerConnectorIngress`.
2. The presented `x-connector-token` must be at most 4096 characters.
3. The tenant is resolved with `db.system` calling the definer function
   `connector_ingress_context(connection, token_hash)` from migration 029, which
   matches `connector_credentials.metadata->>'token_digest'` for the active
   `webhook_secret` of that connection. No client-supplied value selects the
   tenant. The lookup exists because the connector tables are `FORCE ROW LEVEL
   SECURITY` and an unauthenticated request has no tenant setting, so a plain
   select would return nothing and report every request as a uniform failure.
4. A missing row returns `unknown_connection`; a `revoked` connection or a
   disabled one returns `disabled`; a provider with no adapter returns
   `not_normalizable`. All three answer identically at the HTTP layer (401), so the
   endpoint cannot be used to enumerate connection ids.
5. The definer lookup returns the sealed envelope. `openCredential` opens it with
   the `webhook_secret` AAD purely to hand it to the adapter's own verification
   step. It is never logged and never returned.
6. `verifyInbound` runs BEFORE normalization. An unverified request returns
   `invalid_signature` and nothing is normalized or stored.
7. Only then does `normalizeInbound` run. A thrown normalization error returns
   `not_normalizable` (HTTP 400) and a null result returns `rejected_event`
   (HTTP 409).
8. With a tenant context established by the verified connection,
   `recordConnectorEvent` writes the event with `verification='verified'` and
   `dispatch_state='pending'`, and updates `last_event_at` on the connection.

**An unverified inbound event can never become executable workflow input.** The
`verification` column is checked `('verified','unverified','rejected')`,
`recordConnectorEvent` sets `dispatch_state='skipped'` for anything that is not
verified, `pendingConnectorEvents` selects only `verification='verified' AND
dispatch_state='pending'`, and `markEventDispatched` updates only a verified row.
An adapter that returns `verified: false` therefore produces no stored event at
all, and no event that is not verified is ever offered to the workflow engine.

Deduplication identity is `UNIQUE(tenant_id,connection_id,dedupe_key)` where
`dedupe_key` is the adapter-supplied stable provider-side identity of the
delivery. `recordConnectorEvent` inserts with
`ON CONFLICT (tenant_id,connection_id,dedupe_key) DO UPDATE SET
duplicate_count = connector_events.duplicate_count + 1` and returns
`(xmax = 0) AS inserted`, so repeated delivery of the same provider event
increments a counter on one logical row instead of creating a second event. One
provider event therefore maps to one connector event and, through the workflow
idempotency key, to at most one run. That is the replay protection at this layer:
a replayed delivery is accepted, counted as a duplicate, and is not dispatched
again. `payload_ref` holds an opaque reference plus bounded metadata (capped at
8192 bytes by the runtime and by
`CHECK(pg_column_size(payload_ref) <= 8192)`); the raw provider payload is never
stored, and neither are credential values.

`connector_events` also carries `provider_event_id` (up to 256 characters),
`provider_occurred_at`, `normalized_resource_refs` (bounded to 8192 bytes and 16
entries), `received_at`, `processed_at`, `duplicate_count` and `dispatch_state`.
`pendingConnectorEvents` offers at most
`CONNECTOR_LIMITS.event_dispatch_batch` (25) verified, pending events per tenant
with `FOR UPDATE SKIP LOCKED`.

## Polling, leases and worker reuse

Connector sync and connector event dispatch are polled, not pushed. They reuse the
worker that already exists instead of adding a second queue or a second process:

- `apps/worker/src/worker.ts` already enumerates tenants through the definer
  function `worker_tenants()` (migration 001) and runs `tick()` on a one second
  interval from `startWorker()`. `connectorTick` and `automationTick` are called
  from inside that tick, so connector and workflow work is bounded by the same
  per-tenant, per-tick budget as imports, exports and webhook delivery.
- Claims are PostgreSQL row locks plus a lease token with an expiry, following the
  patterns already used for `webhook_deliveries` (migration 020) and `jobs`
  (migration 021). The provider or adapter call is made outside any database
  transaction, so a slow provider cannot hold a database connection or a row lock.
  A crashed worker leaves a lease that becomes claimable when it expires.
- There is no user-facing throttling knob: the poll interval comes from the
  provider definition and is bounded in the database (`60..86400`), the per-tick
  batch is bounded by `CONNECTOR_LIMITS` (10 syncs, 25 events), and everything is
  per-tenant.

## Rate limits and failure classification

`packages/connectors/failure.ts` is the single classification vocabulary shared by
the connector sync path and the workflow engine, so the two can never disagree
about what is retryable. `FAILURE_CATEGORIES` is the bounded list: `transient`,
`rate_limited`, `provider_unavailable`, `credential_expired`, `permission_revoked`,
`permanent`, `validation`, `authorization_revoked`,
`connector_attention_required`, `capability_missing`, `not_found`, `conflict`.
`isRetryableCategory` treats only `transient`, `rate_limited` and
`provider_unavailable` as retryable. `RETRY_POLICY` is
`{max_attempts: 7, base_seconds: 5, cap_seconds: 3600, attention_after_failures: 5}`.
`backoffSeconds(attempt, retryAfterSeconds)` returns
`min(cap, max(base * 2^attempt, retryAfter))` with the attempt clamped to `0..32`
and no jitter, so retries are reproducible.

`classifyProviderFailure(input)` maps a provider outcome to a category, a
retryable flag, a backoff or null, the connection status the failure implies, and
a bounded non-secret summary:

| Input | Category | Retryable | Connection status |
|---|---|---|---|
| HTTP 429 | `rate_limited` | yes | unchanged (transient) |
| HTTP 5xx | `provider_unavailable` | yes | unchanged (transient) |
| HTTP 401, or code `invalid_grant`, `invalid_token`, `expired_token`, `invalid_client`, `unauthorized_client` | `credential_expired` | no | `attention_required` |
| HTTP 403 | `permission_revoked` | no | `attention_required` |
| HTTP 400 or 422 | `validation` | no | `error` |
| HTTP 404 | `not_found` | no | `error` |
| HTTP 409 | `conflict` | no | `error` |
| transport `network` or `timeout` | `transient` | yes | unchanged |
| transport `protocol` | `permanent` | no | `error` |
| other HTTP status, or none | `permanent` | no | `error` |

A `Retry-After` value is honoured: `classifyProviderFailure` passes
`retryAfterSeconds` into `backoffSeconds`, which never returns less than the
provider's directed delay. Quota exhaustion arrives as a rate limit or a 403 from
the provider and is classified as `rate_limited` or `permission_revoked`
accordingly; there is no separate quota category.

`classifyStepFailure(error)` classifies a failure raised by Workspace itself for
the workflow engine: 403 and 401 become `authorization_revoked` (not retryable),
404 `not_found` (not retryable), 409 `conflict` (retryable), 429 `rate_limited`
(retryable), 5xx `transient` (retryable), 400 and 422 `validation` (not
retryable), and anything else `transient` (retryable). `assertFailureCategory`
validates a stored category string.

## Audit

Connector audit rows are written to the existing `audit_events`
(`id, tenant_id, actor_id, action, resource_id, request_id`) in the caller's
transaction. The helper deliberately carries no detail column, so a secret cannot
reach the audit trail through this path.

| Action | Written by |
|---|---|
| `connector.connection_created` | `createConnection` |
| `connector.connected`, `connector.capabilities_granted` | `connectConnection` |
| `connector.enabled`, `connector.disabled` | `setConnectionEnabled` |
| `connector.credential_rotated` | `rotateConnectionCredential` |
| `connector.revoked` | `revokeConnection` |
| `connector.health_checked` | `testConnection` |
| `connector.sync_requested` | the sync route in `apps/api/src/connected-work.ts` |
| `connector.sync_completed`, `connector.sync_failed` | `connectorTick` in `apps/worker/src/connected-work.ts` (actor null) |

## Health, status and metrics surfaces

- `publicConnection(row, credentials)` is the only shape a browser receives. It
  carries provider display name, category, `provider_implemented`,
  `adapter_version`, ownership and a human ownership label (`Delegated user` or
  `Shared (tenant)`), the label and status, `enabled`, requested, granted and
  available capabilities, the sanitized `config`, every lifecycle timestamp and
  error field, and credential metadata only for a caller who may manage the
  connection.
- `testConnection` performs the health probe. Health is never inferred from the
  presence of a credential: the adapter is asked through `AdapterHooks.health`,
  and the result is applied to the connection. A provider with `health_check`
  false, or with no adapter, returns `{ok: false, category: "permanent", detail:
  "Provider adapter is not implemented"}` without changing the connection.
- Connector fleet counters come from the definer function
  `workspace_connector_health()` (migration 029) and are surfaced by
  `connectorMetrics(db)` as `connections`, `attention_required`, `sync_failures`,
  `events_received` and `events_duplicate`. The function is a `SECURITY DEFINER`
  count-only aggregate returning integers, because the connector tables are
  `FORCE ROW LEVEL SECURITY` and a tenant-less direct aggregate would falsely
  report an empty fleet. It can never be turned into a cross-tenant row primitive.
- `GET /connectors/metrics` returns those raw counters. The deployment-wide
  Prometheus snapshot assembled in `apps/api/src/app.ts` reads the same function
  directly and publishes it as `workspace_connector_<counter>` samples (HELP and
  TYPE `workspace_connector_count`), alongside the workflow counters as
  `workspace_workflow_<counter>`. The counters are observational: if the function
  cannot be read the counters are omitted from the snapshot rather than failing the
  response.
- The tenant-scoped operator surfaces that already exist are unchanged:
  `GET /operations/status` (admin, human session) for tenant queue status, and
  `GET /metrics` behind the metrics bearer token for the deployment-wide snapshot.

## Bounded limits

`CONNECTOR_LIMITS` in `packages/connectors/runtime.ts`:

| Limit | Value | Enforced by |
|---|---|---|
| `max_connections_per_tenant` | 50 | `createConnection` (409) |
| `max_user_connections_per_user` | 20 | `createConnection` (409) |
| `max_events_per_sync` | 50 | the sync contract and the worker phase |
| `sync_claim_batch` | 10 | `claimDueSync` |
| `event_dispatch_batch` | 25 | `pendingConnectorEvents` |
| `max_credentials_per_connection` | 16 | credential storage bound |
| `sync_lease_seconds` | 120 | `claimDueSync` lease |
| `max_config_bytes` | 8192 | `createConnection`, `recordConnectorEvent`, ingress body bound |

Database bounds in migration 029: `provider_key` 1 to 64 characters, `label` 1 to
120, `config` at most 8192 bytes, credential metadata at most 4096 bytes,
`secret_encrypted` between 1 and 16384 characters, `key_version` between 1 and
1000, cursor at most 4096 characters, `sync_generation` at least 1,
`poll_interval_seconds` between 60 and 86400, `event_type` 1 to 120 characters,
`provider_event_id` at most 256 characters, `dedupe_key` 1 to 256 characters,
`payload_ref` and `normalized_resource_refs` at most 8192 bytes each, and ingress
tokens at most 4096 characters in the runtime.

## No LLM is required for workflow execution.

No LLM is required for workflow execution. The connector plane contains no model
call, no inference dependency and no external AI service. A future agent layer may
propose or invoke permitted workflows, but it can never bypass workflow validation,
Workspace authorization, connector capabilities, approvals or run recording: it
would have to act through the same `connector.action.invoke` authority checks,
the same capability vocabulary and the same run evidence described in
[Automation architecture](AUTOMATION_ARCHITECTURE.md). Provider adapters cannot
reach Workspace authorization from the connector plane, and no agent can reach a
provider without a granted capability on a live connection.

## Deferred to the next tranche

- **Every real provider integration.** Gmail (`google-mail`), Microsoft Graph mail
  (`microsoft-mail`), IMAP/SMTP (`imap-smtp`), Google Calendar
  (`google-calendar`), Microsoft Calendar (`microsoft-calendar`), CalDAV
  (`caldav`), Telegram (`telegram`), Discord (`discord`) and WhatsApp
  (`whatsapp`) are declared in `DECLARED_PROVIDER_KEYS` with no adapter, no
  credential handling and no action. The catalog reports each as
  `implemented: false`.
- **The OAuth flow.** No authorization endpoint, callback route, state binding,
  PKCE verifier store, token exchange, refresh or provider-side revocation call
  exists.
- **Provider-backed actions.** No adapter implements a real action, so no workflow
  can send mail, create or cancel a calendar event, or post to a messaging
  channel. Only `synthetic.record` exists.
- **Provider onboarding flows.** A connection management component exists at
  `apps/web/components/Connections.tsx`, but per-provider consent, scope selection
  and action mapping depend on the adapters below.
- **Linking and capture into Workspace objects.** Creating Workspace pages or
  records from a captured email thread or calendar event, and the reverse
  association, is not implemented.
- **Provider onboarding operations.** No runbook, no allowlist of provider
  endpoints, no real-provider acceptance evidence and no per-provider support
  matrix exists yet. W31 will record real-provider acceptance separately.
