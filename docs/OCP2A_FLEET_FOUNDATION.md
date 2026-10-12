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
characters) are all required. Operational thresholds are explicit and configurable:
`FLEET_SKEW_MS` (default 120 s), `FLEET_STALE_MS` (default 15 min),
`FLEET_OFFLINE_MS` (default 60 min), `FLEET_HISTORY_LIMIT` (default 50),
`FLEET_MAX_ENVELOPE_BYTES` (default 128 KiB) and `FLEET_REPLAY_RETENTION_MS` (default
24 h). Workspace never needs to know any of them.

## Schema

Applied idempotently at boot from `apps/fleet/src/schema.sql`, independent of the
Workspace schema: `deployments`, `deployment_credentials`,
`deployment_current_state`, `deployment_state_history`, `fleet_replay`,
`fleet_audit`. Credential secrets are sealed with AES-256-GCM whose AAD is bound to
the credential id, so a ciphertext cannot be moved between credentials; there is no
fleet-wide shared secret.

## Credential lifecycle

Issue, rotate and revoke are operator-plane actions. Each credential belongs to
exactly one deployment, is independently revocable, and the secret is never returned
by any read API, never logged, and never included in an audit event.

## Ingestion receiver

`POST /ingest` verifies in a deliberate order, rejecting fail closed with a precise
code: envelope size, envelope version, credential existence, credential active state,
**deployment binding** (a credential may only speak for its own deployment), timestamp
window, payload digest, contract version support, HMAC signature, then payload
parsing against its declared contract. On acceptance it upserts current state,
updates last-seen and appends one bounded history row. It never persists
authorization headers, credential secrets, raw request bodies or customer content.

## Replay protection

Bounded state in `fleet_replay`, unique on (credential_id, nonce) and on signature, so
a replayed nonce and a replayed envelope are both rejected with 409. Rows are pruned
deterministically to a retention window on every accept, so the table cannot grow
without bound.

## Isolation

Proven adversarially: a credential for deployment B cannot be used to submit for
deployment A (403 `credential_deployment_mismatch`), an unknown credential is 401, a
revoked credential or revoked deployment is 403, and revoking A leaves B untouched.
There is no per-credential read surface at all: registry reads require the operator
token, unauthenticated access is 401, an unknown deployment id is 404 rather than an
enumeration, and there is no cross-deployment read or write path.

## Current state and unknown preservation

Current state stores the accepted telemetry verbatim, so Workspace-reported `unknown`
stays `unknown`: a null database capacity is never coerced to a number, and a queue
state of `unknown` is never rendered as healthy. This is asserted by test.

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

## Read APIs (the OCP-2B contract)

`GET /deployments`, `GET /deployments/:id`, `GET /alerts`, `GET /audit` and
`GET /health`, all operator-token authorized. There are deliberately no mutation or
remote-execution endpoints.

## Out of scope

No remote shell or command execution, no customer document access, no configuration
mutation, no fleet automation or upgrade orchestration, no Grafana, Loki or
OpenTelemetry requirement, no support-bundle dependency, and no W29/W30 work.
