# OCP-2A: fleet foundation (OpenJM operator plane)

The fleet/operator plane for issue #198. It is a **separate service boundary**
(`apps/fleet`), deliberately not customer Workspace routes, and it owns the
deployment registry, per-deployment credentials, telemetry ingestion, current state,
bounded history, fleet operator authorization, fleet audit and read APIs.

The three planes stay distinct: Workspace customer roles, the OpenJM fleet operator
plane, and the customer tenant admin surfaces are not mixed.

## Boundaries

- Workspace does not depend on this service at runtime. A fleet outage leaves
  Workspace fully functional; OCP-1B spools and retries boundedly and delivery
  resumes when the receiver returns.
- Fleet operator authorization is independent of any Workspace role.
- No customer content, tenant data or Workspace secrets are stored here. The
  registry holds only the opaque Workspace deployment id, an operator-controlled
  alias, lifecycle state and operational telemetry.
- The wire contract is the already-accepted OCP-1B envelope, verified with the same
  pure helpers Workspace uses. The envelope was not redesigned.

## Service configuration

Fail-closed on security-sensitive misconfiguration, verified by test:
`FLEET_DATABASE_URL`, `FLEET_OPERATOR_TOKEN` (minimum 24 characters, stored only as a
SHA-256 hash and compared in constant time) and `FLEET_ENCRYPTION_KEY` (minimum 32
characters) are all required.

The fleet persistence boundary is explicit: `FLEET_DATABASE_URL` is required and the
service never consults `DATABASE_URL`, so it cannot silently inherit the customer
Workspace database configuration. Production should point this at an appropriately
scoped fleet database and role. Workspace remains independent of, and unaware of, the
fleet database. Operational thresholds are explicit and configurable:
`FLEET_SKEW_MS` (default 120 s), `FLEET_STALE_MS` (default 15 min),
`FLEET_OFFLINE_MS` (default 60 min), `FLEET_HISTORY_LIMIT` (default 50),
`FLEET_MAX_ENVELOPE_BYTES` (default 128 KiB) and `FLEET_REPLAY_RETENTION_MS` (default
24 h). Workspace never needs to know any of them.

## Schema

Applied at boot through the versioned runner in `apps/fleet/src/migrations.ts`, which
keeps a ledger table `fleet_schema_migrations` and applies pending migrations in
ascending order, each in its own transaction. The initial schema is
`apps/fleet/src/migrations/001_initial.sql`, and it is independent of the Workspace
schema: `deployments`, `deployment_credentials`, `deployment_current_state`,
`deployment_state_history`, `fleet_replay`, `fleet_audit`. Credential secrets are sealed with AES-256-GCM whose AAD is bound to
the credential id, so a ciphertext cannot be moved between credentials; there is no
fleet-wide shared secret.

## Credential lifecycle

Issue, rotate and revoke are operator-plane actions. Each credential belongs to
exactly one deployment, is independently revocable, and the secret is never returned
by any read API, never logged, and never included in an audit event.

## Ingestion receiver

`POST /ingest` verifies in a deliberate order, rejecting fail closed with a precise
code: envelope byte size, envelope version, credential existence, credential active
state, deployment lifecycle state, **deployment binding** (a credential may only speak
for its own deployment), timestamp window, payload digest, contract version support,
HMAC signature, then **strict canonical payload validation**, then **identity binding**
(the validated payload's `deployment.deployment_id` must equal the envelope's
`deployment_id`, closing the chain credential -> envelope deployment -> telemetry
deployment so a valid credential cannot submit an envelope for one deployment whose
inner telemetry claims another). On acceptance it upserts
current state, updates last-seen, records `first_seen` once and appends one bounded
history row. It never persists authorization headers, credential secrets, raw request
bodies or customer content.

### Strict canonical payload validation

A signature proves who sent the bytes; it does not prove the bytes are the accepted
shape. A deployment holding a valid credential could otherwise sign arbitrary JSON
carrying the accepted schema name plus extra customer or content fields, which the
fleet service would persist and return. `validateOperatorTelemetryV1` in
`packages/operations/operator-telemetry.ts` is therefore the single shared definition
of the accepted payload, used by both producer and receiver so semantics cannot drift,
and enforced at runtime rather than by TypeScript typing.

It enforces the **producer's own contract**, not a compatible-looking superset, and it
does so through shared canonical predicates defined in terms of the producer's
helpers, so there is no second and drifting set of sanitation rules: canonical text is
exactly `sanitizeText(value, bound) === value` including the producer's bounds (48 for
`source.application`, 32 for versions, 40 for build SHAs, 24 for release channel,
environment and region, 64 for the alias, 32 for `schema_version`, 40 for profile
names), a canonical service name is `sanitizeServiceName(value) === value`, a canonical
event category is `sanitizeCategory(value) === value`, status classes are `[1-5]xx`
only, counts, depths and capacities are the non-negative integers `boundedInt()`
produces rather than arbitrary fractional values, latency keeps the producer's
three-decimal rounding, and timestamps must be the canonical `toISOString()` form.
Values the producer would sanitize, truncate or drop cannot be introduced directly by a
credential holder and accepted. Where the wire contract permits null it is preserved.

The deployment identity is the OCP-1A **opaque** contract from `deploymentIdFrom()`
(`ws-` plus a SHA-256 hex prefix). One shared predicate defines it, and the same
predicate gates telemetry validation, fleet registration and identity binding, so the
registry cannot be populated with identifiers Workspace itself would never produce. It rejects, in order: the
`16384`-byte OCP-1A payload ceiling (UTF-8 bytes), non-JSON, non-object payloads,
unknown top-level or nested fields, unsupported schema, missing required fields,
invalid values (enums outside the accepted set, non-integer or negative counts,
strings beyond their bounded length, mistyped scalars), a malformed deployment id, and
any content matched by `scanForProhibited()`. Rejections carry a precise code such as
`canonical_unknown_field:customer_content` or `canonical_prohibited:email_address`, and
nothing is persisted and no replay state is consumed. A structurally legal but
byte-oversized payload is refused independently of the envelope ceiling.

## Replay protection

Bounded state in `fleet_replay`, unique on (credential_id, nonce) and on signature, so
a replayed nonce and a replayed envelope are both rejected with 409. Rows are pruned
deterministically to a retention window on every accept, so the table cannot grow
without bound.

A `409` is emitted **only** for a genuine PostgreSQL uniqueness violation on
`fleet_replay` (SQLSTATE `23505` naming that table's constraint). Any other database
error during the replay insert, a transient failure, connection loss, permission or
disk problem, or a different constraint, is **not** reported as a replay: it rolls
back and returns a retryable `503`. This matters because OCP-1B treats `409` as
permanent, so an infrastructure error must never be allowed to masquerade as a replay
attack and permanently drop telemetry that was never accepted.

Accepted ingestion is persisted **atomically**: replay insertion and pruning, the
current-state upsert, the deployment last-seen and version update, and the history
append and pruning all run in one transaction and commit together or not at all. A
failure after the replay insert therefore rolls the replay state back too, so a
legitimate retry is accepted rather than being consumed as a phantom replay, and the
caller receives a retryable `503` instead of a `409`. Replay rejection after a
successful commit is unchanged.

## Isolation

Proven adversarially: a credential for deployment B cannot be used to submit for
deployment A (403 `credential_deployment_mismatch`), an unknown credential is 401, a
revoked credential or revoked deployment is 403, and revoking A leaves B untouched.
There is no per-credential read surface at all: registry reads require the operator
token, unauthenticated access is 401, an unknown deployment id is 404 rather than an
enumeration, and there is no cross-deployment read or write path.

Deployment lifecycle is enforced independently of credential state. A credential may
still be active while its deployment is `disabled` or `revoked`, and ingestion is
refused in both cases with the distinct precise codes `deployment_disabled` and
`deployment_revoked`. Disabling is reversible and never inferred from telemetry or
network failure; revocation is terminal and a revoked deployment cannot be moved back
to active.

## Current state and unknown preservation

Current state stores the accepted telemetry verbatim, so Workspace-reported `unknown`
stays `unknown`: a null database capacity is never coerced to a number, and a queue
state of `unknown` is never rendered as healthy. This is asserted by test.

## Deployment identity and thresholds

`first_seen` is recorded on the first accepted telemetry and never overwritten;
`last_seen` advances on every acceptance. Envelope and payload size limits are
enforced in UTF-8 bytes rather than JavaScript character counts. The stale and offline
thresholds are normalized so the progression `online -> stale -> offline` always
holds: if an operator configures an offline threshold at or below the stale threshold,
the offline threshold is raised and `offlineMsNormalized` reports that it happened,
rather than allowing an inverted state machine.

## Stale and offline semantics

Factual and time-based, with distinct states: `never_seen`, `online`, `stale`,
`offline`, `disabled`, `revoked`. Revoked and disabled are registry facts and are
never inferred from missing telemetry; a network failure never marks a deployment
disabled. Thresholds are configuration with documented defaults, and boundary
behaviour (exactly at the threshold is still online) is tested deterministically.

## Bounded history and alerts

History is state observations only, pruned per deployment to `FLEET_HISTORY_LIMIT` on
each accept; there is no telemetry warehouse and no raw payload retention beyond
current state. Alerts are rule-based, deterministic, bounded to twelve per deployment
and derived only from factual state: stale, offline, never seen, revoked, disabled,
backup verification failure, queue degraded, and unhealthy or degraded services.

## Operator audit

`fleet_audit` records deployment lifecycle, credential issue/rotation/revocation and
security rejections such as replay and binding mismatch, bounded in size and free of
secret material. Audit writes never break ingestion or reads.

## Operator-plane lifecycle

Registration and credential management are real service capabilities rather than
tests seeding tables, all operator-authorized, all audited, and with no dependency on
customer Workspace admin surfaces and no remote Workspace command execution:

`POST /deployments` (register) · `POST /deployments/:id/credentials` (issue) ·
`POST /deployments/:id/credentials/:credentialId/rotate` ·
`POST /deployments/:id/credentials/:credentialId/revoke` ·
`POST /deployments/:id/lifecycle` (`enabled` / `disabled` / `revoked`).

Issued secrets are 256 bits of entropy, sealed at rest, and returned exactly once at
issuance or rotation so Workspace can be provisioned; no read API ever returns a
secret, and rotation makes the previous secret fail immediately.

Lifecycle coherence: rotation requires the credential to be active, so a revoked
credential stays revoked and is never handed fresh but unusable secret material;
issuance is refused for a terminally revoked deployment; and issuance while a
deployment is disabled is **deliberately permitted**, so a deployment can be
provisioned before it is enabled. The deployment-state check and the transition
decision are taken under a `SELECT ... FOR UPDATE` row lock inside the same
transaction as the mutation and its required audit, so a concurrent enable cannot
overtake a terminal revocation and undo it. Each action writes a
bounded audit event carrying no secret material. These mutation endpoints are
deliberately not exposed through OCP-2B, which stays read-only.

## Audit-required control-plane mutations

Security-sensitive lifecycle mutations are audited transactionally: the state change
and its required audit record commit together or roll back together, so a deployment
can never be registered, a credential issued, rotated or revoked, or a deployment
enabled, disabled or revoked **unaudited**. Correspondingly, a rotation cannot change
the secret when its audit record cannot be committed, a revocation cannot apply
silently, and an issued credential is not left behind when its issuance audit fails;
the caller receives a bounded `503` and nothing is half-applied. Fail-soft auditing
remains in place for observational paths such as rejected ingestion, where audit
failure must not take down ingestion.

## Deferred to W27 hardening (not part of OCP-2A)

Recorded, not implemented here: individual operator identity rather than a single
bootstrap bearer token; lifecycle-managed audit retention; migration-runner
concurrency and advisory locking for multi-replica fleet startup; encryption-key
rotation operational guidance; a final security review of the inherited OCP-1B HMAC
comparison and timing behaviour; and fleet rate limiting and abuse protection.

## Versioned fleet migrations

Schema evolution is versioned, not assumed. `apps/fleet/src/migrations.ts` keeps a
ledger (`fleet_schema_migrations`), applies pending migrations in ascending order,
each in its own transaction, and is idempotent; the initial schema is migration
`001_initial.sql`. Pending migrations are applied on boot, which is the chosen
deployment model, but there is no destructive implicit schema rewrite at startup and
no mixing with customer Workspace tenant migrations. A failed migration rolls back
without advancing the ledger.

## Read APIs (the OCP-2B contract)

`GET /deployments`, `GET /deployments/:id`, `GET /alerts`, `GET /audit` and
`GET /health`, all operator-token authorized. There are deliberately no mutation or
remote-execution endpoints.

## Out of scope

No remote shell or command execution, no customer document access, no configuration
mutation, no fleet automation or upgrade orchestration, no Grafana, Loki or
OpenTelemetry requirement, no support-bundle dependency, and no W29/W30 work.
