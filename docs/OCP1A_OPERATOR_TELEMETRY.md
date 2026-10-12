# OCP-1A operator telemetry contract and privacy core

Release-operations package OCP-1A (issue #198), within Workspace-Platform, after
Wave X closeout and CI-3L adoption. This tranche defines the application-facing
contract only. It does not build the central Fleet Control Plane and does not
introduce outbound transport.

## Purpose

Answer one question in a stable, versioned, privacy-safe format: what operational
state is Workspace willing to expose to an OpenJM operator plane, without making
that plane a runtime dependency?

## Contract

Schema identifier: `openjm.workspace.operator-telemetry.v1`
Module: `packages/operations/operator-telemetry.ts`

Fields, in fixed order so the serialized shape is stable:

- metadata: `schema`, `generated_at`, `sequence`, and `source`
  (application, version, build sha);
- `deployment`: opaque `deployment_id`, optional operator alias, version, build
  sha, release channel, environment label, region label;
- `runtime`: `uptime_seconds` plus bounded health states for overall, API, worker,
  collaboration, database, Redis, storage and antivirus;
- `signals`: request and error totals with per-status-class counts, a bounded
  latency summary, bounded per-service values, queue depth and state, and
  capacity placeholders;
- `readiness`: last backup time, backup state, migration/schema version, upgrade
  readiness, TLS state, and secret-free identity and storage profile summaries;
- `events`: bounded sanitized category summaries only.

Health vocabulary is exactly `healthy | degraded | unhealthy | unknown`.
`unknown` is the honest representation for any source that is absent, failing or
not yet wired, and it never degrades Workspace.

## Source reuse

No existing primitive was rebuilt. The composition service consumes the same
primitives as the Prometheus endpoint through one shared snapshot builder
(`buildMetricsSnapshot`), so `/metrics` and operator telemetry can never drift:

- `dependencyReadiness()` for database, Redis and storage health;
- `serviceMetrics()` for worker and collaboration health and bounded values;
- `httpMetrics.snapshot()` for request, error and latency summaries;
- `antivirusMetrics` for antivirus counters;
- `metricsStartedAt` for uptime;
- `validateDeployment()` for preflight readiness and secret-free profile summaries;
- `schema_migrations` (read-only, fail-soft) for the schema version.

Fields with no honest source today (queue depth, storage and database capacity,
last backup time, backup verification) are reported as `unknown` or `null` rather
than invented.

## Privacy model

Privacy is enforced by construction and then re-checked on the wire.

1. Allowlist sanitizers. Values entering the contract are control-character
   stripped, length bounded, and URLs reduced to scheme and host so query strings
   and customer identifiers cannot ride along. A value that matches any prohibited
   pattern is dropped rather than forwarded, so a hostile source cannot make
   composition fatal or leak.
2. Category and service names are allowlisted by pattern, so no user-generated
   string can become a label and no unbounded label set can enter the contract.
3. Machine-enforced prohibition scan over the serialized payload. Serialization
   refuses to emit a payload matching any prohibited pattern, and the admin route
   returns exactly the vetted serialization, so the check applies to the real
   response bytes.
4. Deployment identity is a digest (`ws-` plus a SHA-256 prefix). The seed never
   appears, and the identifier contains no customer name, tenant id, hostname or
   email. Hashing is used for the deployment identifier only, never to smuggle
   high-cardinality customer identifiers into telemetry.

Prohibited content includes: email addresses, bearer tokens, JWTs, session and
OIDC-state cookies, connection strings, authorization headers, AWS-style keys,
private keys, password and secret field patterns, URLs carrying query strings, and
customer-looking filenames.

## Deployment identity derivation

The `deployment_id` is the only deployment identity that leaves the deployment, and
it is always the bounded digest form (`ws-` plus a SHA-256 prefix). Its seed is,
in order of precedence: the operator-supplied `OPERATOR_TELEMETRY_DEPLOYMENT_ID`,
otherwise a locally held deployment secret (`ENCRYPTION_KEY`) which is random,
per-deployment and stable across restarts. The seed is never a customer name, a
tenant, user, resource or document identifier, a hostname, an email address, a
domain, an IP address, or the customer-safe alias, and the seed itself is never
emitted. Hashing here creates an opaque handle for a registry lookup; it is not
used to smuggle high-cardinality customer identifiers into telemetry.

## Bounds

`maxEvents 12`, `maxServices 12`, `maxStatusClasses 6`, `maxServiceValues 8`,
`maxStringLength 96`, `maxAliasLength 64`, `maxDeploymentIdLength 64`,
`maxPayloadBytes 16384`. Serialization is deterministic: fixed field order, no
unbounded arrays, no arbitrary label dictionaries, no raw logs.

## Version behaviour

The producer emits exactly one schema identifier. Serialization rejects any
schema that is not in the supported list, so an unknown version is never silently
interpreted as v1 and future transport can negotiate or reject cleanly. Tests
freeze the public serialized shape to detect accidental breakage. No multi-version
migration machinery is introduced yet.

## Configuration boundary

All fleet configuration is optional and telemetry is disabled by default:
`OPERATOR_TELEMETRY_ENABLED` (default `false`), `OPERATOR_TELEMETRY_DEPLOYMENT_ID`,
`OPERATOR_TELEMETRY_ALIAS`, `OPERATOR_TELEMETRY_ENVIRONMENT`,
`OPERATOR_TELEMETRY_REGION`, `OPERATOR_TELEMETRY_RELEASE_CHANNEL`. Workspace boots
and operates normally with every one of them absent. No endpoint and no telemetry
credential are required, and the local inspection surface does not enable outbound
telemetry.

## Local inspection

`GET /api/v1/admin/operator-telemetry` returns the canonical v1 payload using the
existing owner/admin authorization, read-only and secret-free. It exists for
transparency and acceptance. It is not a substitute for the authenticated outbound
transport that OCP-1B will add, and it does not require the OpenJM Fleet Control
Plane.

## Logging boundary

Raw logs remain local by default. Structured logging stays sanitizable. Only
bounded category summaries may enter telemetry. Raw logs and raw exception payloads
never enter a telemetry snapshot. Customer-authorized, bounded support bundles are a
later OCP-1 tranche, and there is no permanent remote log access and no Loki
integration.

## What OCP-1A proves, and what it does not

Proven here, mostly natively: Workspace functional with telemetry disabled and with
every fleet setting absent; a canonical snapshot generated locally; missing optional
sources degrading to `unknown` instead of failing; reuse rather than duplication of
health primitives; correct owner/admin authorization with members denied; hostile
fixtures not surviving serialization; deterministic bounding; explicit versioning.

Deferred to OCP-1B and beyond, and deliberately not claimed here: outbound
transport and its credentials, mTLS, replay protection over a real network,
timestamp validation, disconnected spool and retry, revocation, support-bundle
transport, central ingestion, the Fleet Console, and remote actions. Actual
network-outage exporter behaviour is an OCP-1B proof, not an OCP-1A claim.
