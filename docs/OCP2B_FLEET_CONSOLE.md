# OCP-2B: OpenJM read-only fleet console

The initial OpenJM-owned operator console over the accepted OCP-2A read APIs. It gives
OpenJM operators a clear operational view of the installed Workspace fleet while
preserving the sovereignty and privacy boundaries accepted in OCP-1 and OCP-2A.

The 1.0 console is **read-only**.

## Plane boundary

This is the vendor/operator plane. It is deliberately not the customer Workspace
application, not the customer owner/admin settings surface, not a remote administration
shell, not a customer-content browser and not an automation console. The three planes
stay separate:

| Plane | Application | Owns |
| --- | --- | --- |
| Customer Workspace | `apps/web` (+ `apps/api`, `apps/worker`, `apps/collab`) | Customer documents, tenants, customer admin |
| OpenJM fleet service | `apps/fleet` | Fleet registry, credentials, ingestion, current state, audit |
| OpenJM fleet console | `apps/fleet-web` (this package) | Read-only operator presentation over the fleet service |

`apps/fleet-web` is a distinct application directory that imports nothing from
`apps/web`, and `apps/web` gains no fleet route, tab or navigation. A regression test
asserts both directions.

## Application architecture

The console is a standalone **server-rendered** application using Fastify, which is
already a repository dependency. It ships **no client-side JavaScript at all**, and its
Content-Security-Policy is `default-src 'none'` with `style-src 'self'`. Interactions
(search, filters, refresh, navigation) are plain HTML forms and links, so state lives in
query parameters and every surface works without script.

Why this shape rather than a second Next/React application: it avoids introducing a
second front-end build pipeline and its dependency and CI cost, it keeps the operator
credential strictly server-side with nothing shipped to a browser, and it keeps the
plane boundary explicit in the repository layout. The console reuses the OpenJM/Workspace
design tokens (accent, ink, muted, border, surface, soft, sage, Inter) so it reads as the
same product family, without any runtime coupling to the customer product.

## Server-side BFF and credential isolation

The OCP-2A operator credential is a shared bootstrap bearer token. It must never reach a
browser, so the console is a BFF:

```
browser -> fleet-web server -> OCP-2A fleet API (server-side bearer credential)
```

`FLEET_OPERATOR_TOKEN` exists only in server-side environment configuration. It is not
placed in `NEXT_PUBLIC_*` (there is no such usage), localStorage, sessionStorage, a
browser-readable cookie, page source, a query string or a client bundle, and no response
body contains it. A regression test asserts the token is absent from every console page,
from the only static asset, and from the session cookie, and that no page loads a script.

## Bootstrap operator access

W27 will address individual operator identity, and this package deliberately does not
build a second enterprise identity system in the meantime.

- The operator signs in on `GET /login` with the fleet operator credential.
- The credential is verified **server-side** against an authenticated OCP-2A read
  endpoint; it is never echoed, logged or stored in the browser.
- On success the console issues its own opaque session cookie: an HMAC-SHA256 signed
  payload containing a random session id and an expiry, and nothing else. **No fleet
  credential is stored in the cookie.**
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, and
  expires within a bounded session lifetime (default 8 hours, maximum 24 hours).
- `POST /logout` clears the cookie, which destroys the session.
- Tampered or expired cookies are simply unauthenticated. A session record that somehow
  contained credential material is refused rather than trusted.
- Customer Workspace tenant sessions are not connected to fleet authorization, and a
  customer owner/admin is not a fleet operator.

Individual OpenJM operator identity, per-operator authorisation and server-side session
storage remain **W27 hardening items**.

## Read-only API contract

The console consumes only the accepted OCP-2A read APIs: `GET /deployments`,
`GET /deployments/:id`, `GET /alerts`, `GET /audit`, `GET /health`. It calls no mutation
endpoint, and the registered route set contains only `GET /`, `GET /deployments`,
`GET /deployments/:id`, `GET /alerts`, `GET /audit`, `GET /login`, `POST /login`,
`POST /logout` and `GET /assets/console.css`. A regression test enumerates the routes and
asserts that no registration, issuance, rotation, revocation, lifecycle or remote-action
surface exists, and that no rendered markup exposes those paths.

## Screens

- **Fleet overview** (`/`): factual counts of total deployments plus online, stale,
  offline, never seen, disabled and revoked, the number of alerting deployments, warning
  and total alert counts, a freshness statement and a manual refresh link. No percentages
  and no SLA claims are derived, because the fleet service does not provide them.
- **Deployment inventory** (`/deployments`): searchable and filterable table with alias,
  opaque Workspace deployment ID, lifecycle state, online state, last seen, version, build
  SHA, schema version, telemetry contract version, queue state and depth, storage signal,
  backup state and alert state. Filters cover online state, lifecycle state and alerting
  deployments; search covers only the bounded operator-safe fields the registry holds.
  Rows link to detail.
- **Deployment detail** (`/deployments/<fleet record id>`): identity and inventory;
  runtime health for overall, API, worker, collaboration, database, Redis, storage and
  antivirus; current telemetry explicitly labelled as a snapshot rather than a trend;
  service detail; queue; capacity; backup; credential status (identifiers and lifecycle
  timestamps only, never secrets or ciphertext); recent bounded state history; and the
  deployment's bounded alerts. An unknown id returns a bounded 404.
- **Fleet alerts** (`/alerts`): deployment, human-readable alert label, severity and the
  canonical category, filterable by severity, category and deployment, with an explicit
  empty state. Technical categories are mapped to readable labels while the canonical
  value is retained for inspection. There is no acknowledgement, suppression or
  notification workflow.
- **Operator audit** (`/audit`): bounded records with timestamp, readable action, the
  canonical action, deployment and bounded detail. Read-only, with no deletion or export
  controls. Audit retention is a W27 item.

## Honest unknown rendering

A null, an absent value or a reported `unknown` is never converted into `0`, `healthy`,
`OK` or a blank cell:

- `Unknown` for a state reported as unknown or otherwise unset;
- `Not reported` for a metric the deployment does not publish (database capacity,
  local storage signal, latency figures, service values);
- `Never seen` for a deployment that has never reported telemetry.

Database capacity stays unknown where OCP-1 reports it unknown, storage stays unknown when
unavailable, backup state and timestamp stay unknown when not reported, and service states
stay unknown where reported unknown. A genuine zero still renders as `0`. Regression tests
assert both the helper semantics and the specific rendered cells.

## Accessibility and design

Semantic landmarks (skip link, `header`, labelled `nav`, `main`, `footer`), a proper
heading hierarchy, labelled filter controls, tables with `scope`d headers, status conveyed
as text as well as colour, visible focus, responsive layout at desktop and tablet widths,
and `prefers-reduced-motion` handling. This is an operational console: dense, calm and
scannable, with tables, status summaries and bounded history rather than decorative
metrics or fabricated charts. The final manual NVDA acceptance remains part of the later
global Workspace 1.0 manual gate.

## Error isolation

Four states are kept distinct and are never conflated: the console itself failing, the
fleet API being unreachable or unhealthy, a deployment being stale or offline, and a
deployment being disabled or revoked. When the fleet API cannot be reached the console
renders a bounded service error and deliberately shows **no** deployment data, because a
fleet-API outage must never be rendered as deployments being offline or stale. No raw
backend error or secret-bearing exception reaches the browser.

## Data access

A small explicit data-access layer performs server-side calls to the OCP-2A API with a
bounded per-request timeout, normalized error outcomes (`unreachable`, `timeout`,
`unauthorized`, `server_error`), no secret leakage and no retry storm. Manual refresh is
always available. There is no caching or invalidation infrastructure, and no periodic or
realtime push; a modest periodic refresh is deliberately not implemented in 1.0.

## Configuration

| Setting | Required | Meaning |
| --- | --- | --- |
| `FLEET_API_BASE_URL` | yes | Base URL of the OCP-2A fleet API |
| `FLEET_OPERATOR_TOKEN` | yes | Bootstrap operator credential, server-side only |
| `FLEET_CONSOLE_SESSION_SECRET` | yes | Signing secret for the console session cookie (>= 32 chars) |
| `FLEET_CONSOLE_PORT` | no | Listen port (default 4200) |
| `FLEET_CONSOLE_SESSION_TTL_MS` | no | Session lifetime, clamped to 15 minutes to 24 hours (default 8 hours) |
| `FLEET_CONSOLE_REQUEST_TIMEOUT_MS` | no | Fleet API timeout, clamped to 500 ms to 15 s (default 5 s) |
| `FLEET_CONSOLE_SECURE_COOKIE` | no | Force `Secure` cookies outside production |

Configuration fails closed: a missing base URL, credential or session secret refuses to
start, and the console never inherits the customer Workspace database configuration.

## Local start and tests

```
npm run start:fleet-web
```

Targeted tests:

```
node --import tsx --test tests/fleet-web.test.ts
```

The suite covers plane separation, configuration fail-closed behaviour, credential
isolation from the browser, unauthenticated denial, sign-in and sign-out, overview
counts, inventory filters and search, unknown semantics in rendered cells, deployment
detail, alerts, audit, fleet-API error isolation, the read-only boundary and accessibility
structure.

## Explicitly out of scope

No remote shell or arbitrary command execution, no diagnostic bundle request or upload, no
support-bundle viewing, no deployment registration UI, no credential mutation UI, no
lifecycle mutation UI, no upgrade orchestration, no incident acknowledgement, no
notification integrations, no Grafana, Loki or OpenTelemetry Collector, no
customer-content access, no raw logs, and no W27/W29/W30 scope beyond the minimal secure
bootstrap session described above.

## Deferred to W27

Individual fleet-operator identity rather than the shared bootstrap credential;
per-operator authorisation; server-side session storage and revocation; fleet audit
retention and lifecycle management; fleet migration concurrency for multi-replica
startup; encryption-key rotation guidance; a final HMAC/timing security review; fleet rate
limiting and abuse protection; deployment and credential lifecycle hardening around
concurrent credential operations on a terminally revoked deployment; and wiring a
deterministic browser/E2E acceptance harness for this console into the deployment tier.
