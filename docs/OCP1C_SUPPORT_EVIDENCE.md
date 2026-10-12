# OCP-1C: customer-authorized support evidence

Bounded, sanitized, local support evidence for Workspace issue #198. It is optional:
Workspace functions normally when it is unused, disabled or disconnected, and there
is no dependency on any OpenJM control plane.

## Model

A support window is an explicit, time-bounded, revocable and auditable authorization
held by a customer owner/admin. Generating a support bundle requires an active,
unexpired authorization. **Telemetry being enabled never implies support
authorization**, there is no standing authorization by default, and authorization is
never granted implicitly.

State machine, evaluated against the record and the current time: `none` when no
record exists, `revoked` when a revocation timestamp is present, `expired` when the
expiry has passed (exactly at expiry is already expired), otherwise `active`.

Bounds: default window 60 minutes, maximum 1440 minutes, so a window is never
unbounded. Granting a new window revokes any previous active one, keeping exactly
one live authorization at a time.

## Bundle contract

Version `openjm.workspace.support-bundle.v1`. Contents are constructed from a strict
allowlist rather than collected broadly and then redacted:

- the already-vetted OCP-1A telemetry snapshot, embedded unchanged;
- the bounded transport status;
- the deployment preflight summary (validity, issue count, secret-free profile
  names);
- the enriched operational state (queue depth/state, storage used percentage,
  backup timestamp/state);
- application version and build, and the schema version when known;
- a bounded list of summarized operational events.

Explicitly absent: raw logs, database rows, customer content, document titles or
page text, filenames, attachment contents, tenant/user/document/resource/object
identifiers, raw exception payloads, raw headers, credentials, connection strings,
cookies and tokens.

Ceiling: 32 KiB, enforced on the serialized bytes. The embedded OCP-1A snapshot keeps
its own 16 KiB ceiling, asserted separately.

## Structured operational events

Events are derived factual summaries, not logs: queue degraded or unavailable,
storage or database capacity unknown, backup verification failed or unknown, service
or dependency not healthy, telemetry transport failure or disabled. Each event
carries an allowlisted category, a bounded severity of `info` or `warning`, a
bounded detail and an observation timestamp. Count and categories are capped. No
customer value can become a category, and healthy services produce no events.

## Privacy

Allowlist first, prohibition scan second, matching the OCP-1A philosophy. Values that
match a prohibited pattern are dropped, never truncated into something that looks
safe. Serialization refuses to emit a bundle that fails the prohibition scan or
exceeds the ceiling. The hostile-fixture tests prove that emails, customer strings,
tenant identifiers, filenames, bearer and session material, connection strings and
secret fields do not survive into the serialized bundle, and that the digest is
deterministic for identical input.

## Generation, storage and retention

Generation is explicit, local, bounded and fail-soft, and nothing is uploaded
automatically. Only package **metadata** is retained (digest, byte size, event
count, creation time) in a tenant-scoped table under FORCE RLS; bundle content is
returned to the caller and never persisted. Retention is bounded to the configured
newest 20 packages, pruned deterministically on each generation, so no indefinite
retention and no unbounded archive growth can occur. Object storage is not required.

## Audit

Tenant-scoped audit events are emitted for: `support.authorization_granted`,
`support.authorization_revoked`, `support.bundle_generated` and
`support.bundle_failed`. Raw package contents are never audited.

## Operator surface

Owner/admin only, all under existing authorization:

- `GET /api/v1/admin/support/authorization` reads the current state and the bounds;
- `POST /api/v1/admin/support/authorization` grants a bounded window;
- `DELETE /api/v1/admin/support/authorization` revokes it;
- `POST /api/v1/admin/support/bundle` generates a bundle, requiring an active window;
- `GET /api/v1/admin/support/packages` lists bounded package metadata.

A plain member is denied on every one of these routes. There is no dashboard, no
remote command execution and no remote support session.

## Disconnected operation

Bundle generation needs no network, no OCP-2 and no OpenJM control plane, and works
with telemetry transport disabled. It reads local operational state only.

## Out of scope

No automatic upload, no remote support session or shell, no arbitrary commands, no
remote configuration mutation, no customer-content or raw-log export, no screen
capture, no database dump, no support chat, and no Grafana, Loki or OpenTelemetry
requirement. OCP-1C does not ingest or require support bundles in OCP-2.
