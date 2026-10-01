# External monitoring and alerts

OpenJM Workspace exposes an optional Prometheus-compatible `/metrics` endpoint for deployment monitoring. The endpoint contains only low-cardinality service and dependency telemetry; it does not emit tenant names, user IDs, resource IDs, document IDs or customer content.

## Metrics credential

Docker deployments created with:

```bash
node scripts/init-env.mjs
```

receive a random `METRICS_BEARER_TOKEN` in the generated `.env`. The token is not printed by the generator.

If `METRICS_BEARER_TOKEN` is empty, `/metrics` returns HTTP 404. If it is configured, a scrape requires:

```http
Authorization: Bearer <METRICS_BEARER_TOKEN>
```

Do not put the token in URLs, dashboards, tickets, screenshots or source control. Store it in the monitoring system's secret store or a protected credentials file.

## Scrape endpoint

Use the same trusted Workspace HTTPS origin:

```
https://workspace.example.com/metrics
```

The Caddy route proxies the request to the API. Worker and collaboration health listeners remain unpublished to the host; the API reaches them only over the private Compose network and exposes a bounded aggregate.

An example Prometheus scrape configuration is committed at:

```
infrastructure/monitoring/prometheus.yml.example
```

It uses `authorization.credentials_file` rather than embedding the token in the configuration file.

For private/LAN deployments using Caddy's internal CA, configure Prometheus to trust the exported Workspace root CA. Do not disable TLS verification.

## Exported signals

The current endpoint includes:

- `workspace_up` — API process is serving the scrape;
- `workspace_process_uptime_seconds`;
- `workspace_dependency_ready{dependency="database|redis|storage"}`;
- `workspace_service_configured{service="api|collaboration|worker"}`;
- `workspace_service_healthy{service="api|collaboration|worker"}`;
- collaboration document, connection and loading-document counts;
- worker running state, running duration, consecutive failures and last-success age;
- HTTP request counts and cumulative duration grouped only by HTTP method and status class.

HTTP method labels are bounded to GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD and OTHER. Response status is reduced to `2xx`, `3xx`, `4xx`, `5xx` or `other`. Route paths, tenant IDs and other user-controlled identifiers are deliberately not metrics labels.

## Alert rules

Reference Prometheus rules are committed at:

```
infrastructure/monitoring/prometheus-rules.yml
```

They cover:

- metrics target unreachable;
- required API dependency unavailable;
- worker or collaboration service unhealthy;
- repeated worker failures;
- stale worker completion;
- sustained HTTP 5xx rate.

Treat the supplied thresholds as safe starting points, not customer-specific SLOs. Adjust durations and severity to the customer's operating model after observing real workload behavior.

## Alert routing

Workspace does not bundle a specific paging vendor. Route Prometheus alerts through the customer's normal Alertmanager/monitoring stack to email, Slack, Teams, PagerDuty, Opsgenie or another approved channel.

Avoid including Workspace secrets or customer content in alert annotations. The supplied rules use only service/dependency names and aggregate counts.

## Deployment verification

After deployment:

```bash
token="$(sed -n 's/^METRICS_BEARER_TOKEN=//p' .env)"

# Must reject an unauthenticated scrape.
curl -i https://workspace.example.com/metrics

# Authenticated scrape.
curl --fail \
  -H "Authorization: Bearer $token" \
  https://workspace.example.com/metrics
```

Expected:

- unauthenticated request: HTTP 401;
- correct bearer token: HTTP 200 Prometheus text;
- database and storage readiness gauges are `1`;
- configured worker/collaboration health gauges are `1` in a healthy deployment;
- no tenant/user/resource/document identifiers appear in the output.

If monitoring is intentionally disabled by clearing `METRICS_BEARER_TOKEN`, the endpoint returns HTTP 404.

## Boundaries

This slice provides external service monitoring and reference alert rules. It does not yet provide:

- distributed tracing;
- long-term metric storage;
- customer-specific SLO/error-budget policy;
- host CPU/memory/disk metrics;
- PostgreSQL exporter metrics;
- container runtime metrics;
- centralized log aggregation.

Those can be integrated with the customer's observability platform without changing the Workspace application metric contract.
