# OCP-1B authenticated outbound telemetry transport

Release-operations package OCP-1B (issue #198), after OCP-1A and Wave X closeout.
Transport infrastructure only: it does not build the OCP-2 central Fleet Control
Plane or any ingestion service.

## Execution placement

The exporter is an isolated, optional loop inside the existing worker process
(`apps/worker/src/main.ts`), not a new deployable and not a route in the API.

Why: the worker is already a separate process from the API, so telemetry can never
block or slow product request traffic, and the existing per-service configuration
validation, internal health server and graceful shutdown are reused. Isolation is
enforced by construction:

- it has its own timer, its own consecutive-failure counter and complete error
  containment, so it never throws into the worker;
- it never runs inside `tick()`, so it never enters the product job claim path and
  cannot starve product jobs;
- it is deliberately excluded from `workerHealthState()`, so a transport failure
  cannot flip worker liveness or `/ready`;
- when disabled it is not started at all and the worker behaves exactly as before.

## Envelope and signed bytes

Envelope version `openjm.workspace.telemetry-envelope.v1`, carrying the OCP-1A
contract version, the bounded deployment id, the credential id, a generated
timestamp, a unique nonce, a SHA-256 payload digest and the canonical OCP-1A
serialized payload.

The exact bytes signed are the newline-joined concatenation of: envelope version,
contract version, deployment id, credential id, timestamp, nonce, payload digest
and payload. The signature is the repository primitive
`signature(secret, timestamp, signingInput)` from `packages/events`, which is
HMAC-SHA-256 over `` `${timestamp}.${signingInput}` `` returned as hex. No new
cryptographic scheme is introduced.

Because the signing input covers all of those fields, changing any one of them
(timestamp, nonce, deployment id, credential id, payload, payload digest, envelope
version) invalidates the signature. The secret itself is never placed in the
envelope.

## Credential model

One credential per deployment: an explicit credential id plus a random high-entropy
shared secret held only as configuration. There is no fleet-wide secret, so one
compromised deployment credential cannot authorize another. Rotation is replacing
the active credential id and secret; revocation is the receiver rejecting a
credential id. A `401` or `403` is classified as an authentication failure, is not
retried in a tight loop, and the item is dropped so bounded retention still applies.
Local operator visibility comes from the status surface, not from product audit
rows, because `audit_events` is tenant-scoped and product-facing.

## Timestamp and replay contract

Receiver acceptance semantics, implemented here as a bounded deterministic test
receiver and required of the future OCP-2 ingestion service:

- valid signed envelope accepted;
- unsupported envelope or contract version rejected;
- unknown credential id rejected (401);
- revoked credential id rejected (403);
- signature invalid rejected (401), including any modified payload or digest;
- timestamp outside the allowed clock skew rejected (408), stale or future;
- replayed nonce rejected (409);
- the same signed envelope replayed rejected (409);
- oversized body rejected (413);
- nonce and signature tracking is bounded, so the verifier cannot grow without
  limit.

## HTTPS trust model

Production endpoint requirements: HTTPS only, platform CA verification with
certificate and hostname validation enabled, finite request timeout, bounded
response handling (status only, body discarded), and `redirect: "error"` so the
credential and signature can never be forwarded to another origin. Configuration
rejects credentials embedded in the URL, query strings, fragments and unsupported
schemes. There is no TLS-disable option in production code, and no test path that
weakens verification: HTTPS acceptance uses a real test server with a trusted
ephemeral CA, and the failure cases are exercised by not trusting it.

RESTRICTED the trust model in writing: the endpoint is operator configuration, not
user input, and a sovereign on-prem deployment may legitimately use private
address space, so RFC1918 endpoints are not prohibited; the operator owns that
trust decision.

## Retry categories

- Retryable: connection unavailable, timeout, transient 5xx, 408 and 429.
- Non-retryable, operator action required: invalid endpoint configuration, TLS
  validation failure until configuration is corrected, invalid or revoked
  credential, and unsupported contract or envelope version.

Backoff is exponential from a bounded base to a bounded maximum with jitter. There
is no busy loop: a failed attempt sets the backoff deadline and subsequent ticks
return `skipped` until it expires. A successful delivery resets the failure counter
and the backoff.

## Bounded spool

Best-effort durable buffering in a telemetry-specific local file, deliberately not
the product storage tree, so telemetry pressure cannot affect product storage.
Bounds: item count, total bytes and maximum age, all configuration-bounded.
Telemetry snapshots describe current state, so the policy is newest-state-first:
deterministic FIFO eviction discards the oldest entries when a bound is exceeded,
which means stale snapshots can never permanently block the current one, and
thousands of obsolete health snapshots are never queued. Restart is safe: a new
process loads the persisted bounded set. Corruption is fail-soft and counted rather
than fatal, and a write failure is swallowed so the exporter keeps running on its
in-memory copy. Exporter failure can never fill the disk without bound.

## Fail-soft behavior

Every failure mode is contained: unreachable endpoint, DNS or connect timeout, TLS
failure, 5xx, 429, revoked credential, unavailable or corrupt spool, and a
composition error in the payload provider. None of them can reach product
operation, `/health`, `/ready`, sign-in, page and database operations, file access,
collaboration or worker product jobs. Telemetry failure is operationally observable
through the status surface and never product-critical.

## Product-health isolation

Telemetry transport state never feeds normal worker health or product readiness. A
revoked credential, a TLS validation failure, an unreachable receiver, a 5xx, a 429
or a full bounded spool leaves `/health`, `/ready` and worker product-job liveness
exactly as they were, while the telemetry transport status reports its own degraded
or failed condition independently. Telemetry failure is therefore operationally
observable but never product-critical.

The isolation is structural, not merely tested: the exporter is started only when
enabled, it keeps its own failure counter and backoff, it never runs inside
`tick()`, and it deliberately does not contribute to `workerHealthState()`.
`tests/telemetry-sovereignty.test.ts` asserts the behaviour directly, including
that product work keeps progressing under sustained telemetry failure, that the
exporter never throws into its caller, that retries are bounded by backoff rather
than a busy loop, that a full spool stays bounded, that a restart with a non-empty
spool resumes delivery and removes the delivered item, and that corruption is
fail-soft.

## Operator status surface

`GET /api/v1/admin/operator-telemetry/status`, owner/admin authorized (a plain
member is denied), returns bounded state only: enabled, configuration validity,
credential id, endpoint origin, contract and envelope versions, last attempted and
last successful send, last failure category, consecutive failures, backoff state,
spool items and bytes, and evicted count. It never returns the credential secret, a
signature or authorization header, a raw envelope, a raw remote response body,
spool payload contents or customer data. The worker also exposes the same bounded
status on its internal health surface.

## Privacy inheritance

The exporter consumes the canonical OCP-1A serialization and never reconstructs
telemetry, never bypasses the OCP-1A prohibition scan, and never forwards raw
metric labels, logs, exceptions, audit records or configuration objects. Tests
assert that the actual outbound request body contains none of the OCP-1A prohibited
sentinels and no credential secret.

## Known limitations

- Production OCP-2 ingestion does not exist yet; receiver semantics are specified
  and proven against a deterministic test receiver.
- mTLS is not implemented. The envelope is designed so mTLS can be layered later
  without changing the application telemetry contract.
- Source enrichment is not implemented: queue depth and state, storage capacity,
  database capacity, last backup timestamp and backup verification remain honestly
  unknown.
- Raw logs are not exported and support bundles are not implemented.
- The endpoint trust model trusts operator configuration.
