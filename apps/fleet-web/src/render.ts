// OCP-2B: server-rendered HTML for the fleet console.
//
// The console deliberately ships NO client-side JavaScript. Everything is rendered
// server-side as semantic HTML, so there is no client bundle for the fleet operator
// credential to leak into, interactions work without script, and the accessibility
// baseline is straightforward to hold. State is carried in query parameters.

import type { FleetAlert, FleetAuditEntry, FleetDeployment, FleetDeploymentDetail } from "./fleet-api.ts";

// ---------------------------------------------------------------------------
// Honest unknown rendering.
//
// A null, an absent value and an explicit "unknown" are NEVER converted into 0,
// "healthy", "OK" or an empty cell. Each semantic gets its own marker:
//   - "Unknown"      a state the deployment reported as unknown, or that is unset
//   - "Not reported" a metric the deployment simply does not publish
//   - "Never seen"   a deployment that has never reported telemetry
// ---------------------------------------------------------------------------
export const UNKNOWN = "Unknown";
export const NOT_REPORTED = "Not reported";
export const NEVER_SEEN = "Never seen";

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return UNKNOWN;
  const text = String(value).trim();
  if (!text) return UNKNOWN;
  if (text === "unknown" || text === "n/a" || text === "null") return UNKNOWN;
  return text;
}

// A count is never fabricated: a null count is Unknown, and a real zero stays "0".
export function displayCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
  return String(value);
}

export function displayMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_REPORTED;
  return String(value);
}

export function displayTimestamp(value: string | null | undefined): string {
  if (!value) return NOT_REPORTED;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return NOT_REPORTED;
  return parsed.toISOString().replace("T", " ").replace(".000Z", "Z");
}

export function displayLastSeen(value: string | null | undefined): string {
  if (!value) return NEVER_SEEN;
  return displayTimestamp(value);
}

export function displayHealth(state: string | null | undefined): string {
  if (!state) return UNKNOWN;
  const text = String(state).trim().toLowerCase();
  if (!text || text === "unknown") return UNKNOWN;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function displayBackup(backup: { last_backup_at: string | null; state: string } | null | undefined): string {
  if (!backup) return UNKNOWN;
  const state = displayHealth(backup.state);
  if (!backup.last_backup_at) return state;
  return `${state} · last verified ${displayTimestamp(backup.last_backup_at)}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Human labels. Canonical values are preserved alongside for inspection.
// ---------------------------------------------------------------------------
const ONLINE_LABELS: Record<string, string> = {
  online: "Online",
  stale: "Stale",
  offline: "Offline",
  never_seen: "Never seen",
  disabled: "Disabled",
  revoked: "Revoked",
};

export const onlineStateLabel = (state: string | null | undefined): string =>
  state && ONLINE_LABELS[state] ? ONLINE_LABELS[state] : UNKNOWN;

const LIFECYCLE_LABELS: Record<string, string> = { active: "Active", disabled: "Disabled", revoked: "Revoked" };
export const lifecycleLabel = (state: string | null | undefined): string =>
  state && LIFECYCLE_LABELS[state] ? LIFECYCLE_LABELS[state] : UNKNOWN;

const ALERT_LABELS: Record<string, string> = {
  "deployment.offline": "Deployment offline",
  "deployment.stale": "Deployment stale",
  "deployment.never_seen": "Deployment never seen",
  "deployment.disabled": "Deployment disabled",
  "credential.revoked": "Credential revoked",
  "backup.verification_failed": "Backup verification failed",
  "queue.degraded": "Queue degraded",
};
export const alertLabel = (category: string): string => ALERT_LABELS[category] ?? category;

const AUDIT_LABELS: Record<string, string> = {
  "deployment.registered": "Deployment registered",
  "deployment.enabled": "Deployment enabled",
  "deployment.disabled": "Deployment disabled",
  "deployment.revoked": "Deployment revoked",
  "deployment.lifecycle_rejected": "Lifecycle change rejected",
  "credential.issued": "Credential issued",
  "credential.rotated": "Credential rotated",
  "credential.revoked": "Credential revoked",
  "ingestion.rejected": "Telemetry ingestion rejected",
  "ingestion.failed": "Telemetry ingestion failed",
};
export const auditLabel = (action: string): string => AUDIT_LABELS[action] ?? action;

const SERVICE_LABELS: Record<string, string> = {
  overall: "Overall",
  api: "API",
  worker: "Worker",
  collaboration: "Collaboration",
  database: "Database",
  redis: "Redis",
  storage: "Storage",
  antivirus: "Antivirus",
};
export const serviceLabel = (key: string): string => SERVICE_LABELS[key] ?? key;

// Status is always conveyed as text, never by colour alone.
export function badge(text: string, tone = "neutral"): string {
  return `<span class="badge badge--${escapeHtml(tone)}">${escapeHtml(text)}</span>`;
}

export function onlineBadge(state: string | null | undefined): string {
  const tone =
    state === "online" ? "ok" : state === "stale" ? "warn" : state === "offline" ? "bad" : state === "revoked" ? "bad" : "neutral";
  return badge(onlineStateLabel(state), tone);
}

export function lifecycleBadge(state: string | null | undefined): string {
  const tone = state === "active" ? "ok" : state === "disabled" ? "warn" : state === "revoked" ? "bad" : "neutral";
  return badge(lifecycleLabel(state), tone);
}

export function healthBadge(state: string | null | undefined): string {
  const normalized = state ? String(state).toLowerCase() : "";
  const tone = normalized === "healthy" ? "ok" : normalized === "degraded" ? "warn" : normalized === "unhealthy" ? "bad" : "neutral";
  return badge(displayHealth(state), tone);
}

// ---------------------------------------------------------------------------
// Layout and reusable fragments
// ---------------------------------------------------------------------------
export type NavKey = "overview" | "deployments" | "alerts" | "audit";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "overview", href: "/", label: "Fleet overview" },
  { key: "deployments", href: "/deployments", label: "Deployments" },
  { key: "alerts", href: "/alerts", label: "Alerts" },
  { key: "audit", href: "/audit", label: "Operator audit" },
];

export function layout(options: {
  title: string;
  nav: NavKey;
  body: string;
  refreshedAt?: string | null;
  serviceNotice?: string | null;
}): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}" class="nav__link${item.key === options.nav ? " nav__link--current" : ""}"${
        item.key === options.nav ? ' aria-current="page"' : ""
      }>${escapeHtml(item.label)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.title)} · OpenJM Fleet Console</title>
<link rel="stylesheet" href="/assets/console.css" />
</head>
<body>
<a class="skiplink" href="#main">Skip to main content</a>
<header class="console__header">
  <p class="console__product">OpenJM Fleet Console <span class="console__plane">operator plane</span></p>
  <nav class="nav" aria-label="Fleet console sections">${nav}</nav>
  <form method="post" action="/logout" class="console__session">
    <button type="submit" class="button button--quiet">Sign out</button>
  </form>
</header>
${
  options.serviceNotice
    ? `<div class="notice notice--error" role="status" id="main-service-notice">${escapeHtml(options.serviceNotice)}</div>`
    : ""
}
<main id="main" class="console__main">
${options.body}
</main>
<footer class="console__footer">
  <p>Read-only console over the accepted OCP-2A fleet APIs. Data refreshed ${escapeHtml(
    options.refreshedAt ? displayTimestamp(options.refreshedAt) : UNKNOWN,
  )}.</p>
  <p>Deployment detail and credentials displayed without secret material. Individual operator identity is a W27 hardening item.</p>
</footer>
</body>
</html>`;
}

export function table(headers: string[], rows: string[][], options: { caption: string; empty?: string } = { caption: "" }): string {
  if (!rows.length) return `<p class="empty">${escapeHtml(options.empty ?? "Nothing to show.")}</p>`;
  const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="table"${options.caption ? ` aria-label="${escapeHtml(options.caption)}"` : ""}>
<thead><tr>${head}</tr></thead>
<tbody>${body}</tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const STATE_ORDER = ["online", "stale", "offline", "never_seen", "disabled", "revoked"] as const;

export function renderOverview(deployments: FleetDeployment[], alerts: FleetAlert[]): string {
  const counts = new Map<string, number>(STATE_ORDER.map((state) => [state, 0]));
  for (const deployment of deployments) {
    const key = deployment.online_state;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const alerting = new Set(alerts.map((alert) => alert.deployment_id)).size;
  const cards = STATE_ORDER.map(
    (state) => `<div class="stat">
  <p class="stat__label">${escapeHtml(onlineStateLabel(state))}</p>
  <p class="stat__value">${counts.get(state) ?? 0}</p>
</div>`,
  ).join("");
  const warnings = alerts.filter((alert) => alert.severity === "warning").length;
  return `<h1>Fleet overview</h1>
<p class="lede">Factual counts from the accepted OCP-2A read APIs. No percentages or SLA claims are derived, because the fleet service does not provide them.</p>
<section aria-labelledby="fleet-counts">
  <h2 id="fleet-counts">Deployment states</h2>
  <div class="stats">
    <div class="stat">
      <p class="stat__label">Total deployments</p>
      <p class="stat__value">${deployments.length}</p>
    </div>
    ${cards}
  </div>
</section>
<section aria-labelledby="fleet-alerting">
  <h2 id="fleet-alerting">Alerts</h2>
  <p>${alerting} deployment${alerting === 1 ? "" : "s"} with at least one active alert, ${warnings} warning${
    warnings === 1 ? "" : "s"
  } and ${alerts.length} alert${alerts.length === 1 ? "" : "s"} total. <a href="/alerts">View fleet alerts</a>.</p>
</section>
<section aria-labelledby="fleet-freshness">
  <h2 id="fleet-freshness">Freshness</h2>
  <p>Console data was fetched from the fleet API when this page was rendered. Per-deployment freshness is shown as last seen in the inventory and on each detail page.</p>
  <p><a class="button" href="/">Refresh console data</a></p>
</section>`;
}

export function renderInventory(
  deployments: FleetDeployment[],
  filters: { q: string; onlineState: string; lifecycle: string; alerting: boolean },
  alerts: FleetAlert[],
): string {
  const alertingIds = new Set(alerts.map((alert) => alert.deployment_id));
  const query = filters.q.trim().toLowerCase();
  const filtered = deployments.filter((deployment) => {
    if (filters.onlineState && deployment.online_state !== filters.onlineState) return false;
    if (filters.lifecycle && deployment.state !== filters.lifecycle) return false;
    if (filters.alerting && !alertingIds.has(deployment.id)) return false;
    if (!query) return true;
    // Search is limited to the bounded operator-safe fields the fleet registry
    // actually holds. No customer names or content exist here to search.
    return [
      deployment.alias,
      deployment.workspace_deployment_id,
      deployment.app_version,
      deployment.build_sha,
      deployment.schema_version,
      deployment.contract_version,
    ]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(query));
  });

  const option = (value: string, label: string, selected: string) =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

  const form = `<form method="get" action="/deployments" class="filters" role="search">
  <div class="filters__field">
    <label for="q">Search</label>
    <input id="q" name="q" type="search" value="${escapeHtml(filters.q)}" placeholder="Alias, deployment ID, version" />
  </div>
  <div class="filters__field">
    <label for="online_state">Online state</label>
    <select id="online_state" name="online_state">
      ${option("", "Any", filters.onlineState)}
      ${STATE_ORDER.map((state) => option(state, onlineStateLabel(state), filters.onlineState)).join("")}
    </select>
  </div>
  <div class="filters__field">
    <label for="lifecycle">Lifecycle state</label>
    <select id="lifecycle" name="lifecycle">
      ${option("", "Any", filters.lifecycle)}
      ${["active", "disabled", "revoked"].map((state) => option(state, lifecycleLabel(state), filters.lifecycle)).join("")}
    </select>
  </div>
  <div class="filters__field filters__field--check">
    <input id="alerting" name="alerting" type="checkbox" value="1"${filters.alerting ? " checked" : ""} />
    <label for="alerting">Alerting deployments only</label>
  </div>
  <div class="filters__actions">
    <button type="submit" class="button">Apply filters</button>
    <a href="/deployments" class="button button--quiet">Clear</a>
  </div>
</form>`;

  const rows = filtered.map((deployment) => [
    `<a href="/deployments/${escapeHtml(deployment.id)}">${escapeHtml(deployment.alias ?? deployment.workspace_deployment_id)}</a>`,
    `<code>${escapeHtml(deployment.workspace_deployment_id)}</code>`,
    lifecycleBadge(deployment.state),
    onlineBadge(deployment.online_state),
    escapeHtml(displayLastSeen(deployment.last_seen)),
    escapeHtml(displayValue(deployment.app_version)),
    `<code>${escapeHtml(displayValue(deployment.build_sha))}</code>`,
    escapeHtml(displayValue(deployment.schema_version)),
    escapeHtml(displayValue(deployment.contract_version)),
    `${escapeHtml(displayHealth(deployment.queue?.state))} (${escapeHtml(displayCount(deployment.queue?.depth))})`,
    escapeHtml(displayMetric(deployment.storage)),
    escapeHtml(displayBackup(deployment.backup)),
    alertingIds.has(deployment.id) ? badge("Alerting", "warn") : badge("No alerts", "ok"),
  ]);

  return `<h1>Deployments</h1>
<p class="lede">${filtered.length} of ${deployments.length} registered deployment${deployments.length === 1 ? "" : "s"} shown.</p>
${form}
<section aria-labelledby="inventory-list">
<h2 id="inventory-list">Registered deployments</h2>
${
  deployments.length
    ? table(
        [
          "Alias / ID",
          "Workspace deployment ID",
          "Lifecycle",
          "Online",
          "Last seen",
          "Version",
          "Build",
          "Schema",
          "Contract",
          "Queue",
          "Storage %",
          "Backup",
          "Alerts",
        ],
        rows,
        { caption: "Fleet deployments", empty: "No deployments match these filters." },
      )
    : `<p class="empty">No deployments are registered in the fleet yet. Registration is an OCP-2A operator-plane action and is not available from this console.</p>`
}
</section>`;
}

export function renderDetail(detail: FleetDeploymentDetail): string {
  const deployment = detail.deployment;
  const telemetry = detail.telemetry ?? {};
  const runtime = telemetry?.runtime ?? deployment.runtime ?? null;
  const requests = telemetry?.signals?.requests ?? null;
  const errors = telemetry?.signals?.errors ?? null;
  const latency = telemetry?.signals?.latency ?? null;
  const values = telemetry?.signals?.services ?? [];

  const identity = table(
    ["Field", "Value"],
    [
      ["Operator alias", escapeHtml(displayValue(deployment.alias))],
      ["Opaque deployment ID", `<code>${escapeHtml(deployment.workspace_deployment_id)}</code>`],
      ["Fleet record id", `<code>${escapeHtml(deployment.id)}</code>`],
      ["Lifecycle state", lifecycleBadge(deployment.state)],
      ["Online state", onlineBadge(deployment.online_state)],
      ["First seen", escapeHtml(displayTimestamp(deployment.first_seen))],
      ["Last seen", escapeHtml(displayLastSeen(deployment.last_seen))],
      ["Application version", escapeHtml(displayValue(deployment.app_version))],
      ["Build SHA", `<code>${escapeHtml(displayValue(deployment.build_sha))}</code>`],
      ["Schema version", escapeHtml(displayValue(deployment.schema_version))],
      ["Telemetry contract", escapeHtml(displayValue(deployment.contract_version))],
    ],
    { caption: "Deployment identity and inventory" },
  );

  const runtimeRows = ["overall", "api", "worker", "collaboration", "database", "redis", "storage", "antivirus"].map((key) => [
    escapeHtml(serviceLabel(key)),
    healthBadge(runtime ? runtime[key] : null),
  ]);

  const snapshotRows = [
    ["Requests (current)", escapeHtml(displayCount(requests?.total ?? null))],
    ["Errors (current)", escapeHtml(displayCount(errors?.total ?? null))],
    ["Latency samples", escapeHtml(displayCount(latency?.samples ?? null))],
    ["Latency total seconds", escapeHtml(displayMetric(latency?.total_seconds ?? null))],
    ["Latency max seconds", escapeHtml(displayMetric(latency?.max_seconds ?? null))],
    ["Queue depth", escapeHtml(displayCount(deployment.queue?.depth ?? null))],
    ["Queue state", healthBadge(deployment.queue?.state ?? "unknown")],
    ["Local storage used %", escapeHtml(displayMetric(deployment.storage))],
    ["Database capacity", escapeHtml(displayMetric(deployment.database_capacity))],
    ["Backup", escapeHtml(displayBackup(deployment.backup))],
  ];

  const serviceRows = (Array.isArray(values) ? values : []).map((service: any) => {
    const metrics = (Array.isArray(service?.values) ? service.values : [])
      .map((item: any) => `${escapeHtml(serviceLabel(item?.name))}: ${escapeHtml(displayMetric(item?.value))}`)
      .join(", ");
    return [
      escapeHtml(displayValue(service?.name)),
      healthBadge(service?.state),
      service?.configured === false ? "Not configured" : "Configured",
      escapeHtml(metrics || NOT_REPORTED),
    ];
  });

  const credentialRows = (detail.credentials ?? []).map((credential) => [
    `<code>${escapeHtml(credential.id)}</code>`,
    badge(displayHealth(credential.state), credential.state === "active" ? "ok" : "bad"),
    escapeHtml(displayTimestamp(credential.created_at)),
    escapeHtml(credential.rotated_at ? displayTimestamp(credential.rotated_at) : NOT_REPORTED),
    escapeHtml(credential.revoked_at ? displayTimestamp(credential.revoked_at) : NOT_REPORTED),
  ]);

  const historyRows = (detail.history ?? []).map((entry) => [
    escapeHtml(displayTimestamp(entry.observed_at)),
    escapeHtml(displayHealth(entry.queue_state)),
    escapeHtml(displayHealth(entry.backup_state)),
    escapeHtml(onlineStateLabel(entry.online_state)),
  ]);

  const alertRows = (detail.alerts ?? []).map((alert) => [
    escapeHtml(alertLabel(alert.category)),
    badge(alert.severity === "warning" ? "Warning" : "Info", alert.severity === "warning" ? "warn" : "neutral"),
    `<code>${escapeHtml(alert.category)}</code>`,
  ]);

  return `<p class="breadcrumb"><a href="/deployments">← All deployments</a></p>
<h1>${escapeHtml(deployment.alias ?? deployment.workspace_deployment_id)}</h1>
<p class="lede">${onlineBadge(deployment.online_state)} ${lifecycleBadge(deployment.state)} Last seen ${escapeHtml(
    displayLastSeen(deployment.last_seen),
  )}.</p>
<section aria-labelledby="identity"><h2 id="identity">Identity and inventory</h2>${identity}</section>
<section aria-labelledby="runtime"><h2 id="runtime">Runtime health</h2>${table(
    ["Component", "State"],
    runtimeRows,
    { caption: "Runtime health by component" },
  )}<p class="hint">States are shown as text as well as colour. Unknown means the deployment did not report that component.</p></section>
<section aria-labelledby="snapshot"><h2 id="snapshot">Current telemetry</h2>
<p class="hint">This is the latest accepted snapshot from the deployment, not a time series. The fleet service stores no trend data, and none is inferred here.</p>
${table(["Signal", "Value"], snapshotRows, { caption: "Current telemetry snapshot" })}</section>
${
  serviceRows.length
    ? `<section aria-labelledby="services"><h2 id="services">Service detail</h2>${table(
        ["Service", "State", "Configured", "Reported values"],
        serviceRows,
        { caption: "Reported service detail" },
      )}</section>`
    : ""
}
<section aria-labelledby="credentials"><h2 id="credentials">Credential status</h2>
<p class="hint">Identifiers and lifecycle timestamps only. Credential secrets and ciphertext are never returned by the fleet API and never displayed.</p>
${
  credentialRows.length
    ? table(["Credential ID", "State", "Created", "Rotated", "Revoked"], credentialRows, { caption: "Deployment credentials" })
    : `<p class="empty">No credentials are recorded for this deployment.</p>`
}</section>
<section aria-labelledby="history"><h2 id="history">Recent state history</h2>
<p class="hint">Bounded state observations recorded by the fleet service. Only these fields are persisted, so no richer historical telemetry is shown.</p>
${
  historyRows.length
    ? table(["Observed", "Queue state", "Backup state", "Recorded online state"], historyRows, {
        caption: "Bounded deployment state history",
      })
    : `<p class="empty">No state history recorded yet.</p>`
}</section>
<section aria-labelledby="alerts"><h2 id="alerts">Alerts</h2>
${
  alertRows.length
    ? table(["Alert", "Severity", "Category"], alertRows, { caption: "Deployment alerts" })
    : `<p class="empty">No active alerts for this deployment.</p>`
}</section>`;
}

export function renderAlerts(alerts: FleetAlert[], deployments: FleetDeployment[], filters: { severity: string; category: string; deployment: string }): string {
  const nameById = new Map(deployments.map((deployment) => [deployment.id, deployment.alias ?? deployment.workspace_deployment_id]));
  const categories = Array.from(new Set(alerts.map((alert) => alert.category))).sort();
  const filtered = alerts.filter((alert) => {
    if (filters.severity && alert.severity !== filters.severity) return false;
    if (filters.category && alert.category !== filters.category) return false;
    if (filters.deployment && alert.deployment_id !== filters.deployment) return false;
    return true;
  });
  const option = (value: string, label: string, selected: string) =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const form = `<form method="get" action="/alerts" class="filters">
  <div class="filters__field">
    <label for="severity">Severity</label>
    <select id="severity" name="severity">${option("", "Any", filters.severity)}${option("warning", "Warning", filters.severity)}${option(
      "info",
      "Info",
      filters.severity,
    )}</select>
  </div>
  <div class="filters__field">
    <label for="category">Category</label>
    <select id="category" name="category">${option("", "Any", filters.category)}${categories
      .map((category) => option(category, alertLabel(category), filters.category))
      .join("")}</select>
  </div>
  <div class="filters__field">
    <label for="deployment">Deployment</label>
    <select id="deployment" name="deployment">${option("", "Any", filters.deployment)}${deployments
      .map((deployment) => option(deployment.id, deployment.alias ?? deployment.workspace_deployment_id, filters.deployment))
      .join("")}</select>
  </div>
  <div class="filters__actions"><button type="submit" class="button">Apply filters</button><a href="/alerts" class="button button--quiet">Clear</a></div>
</form>`;
  const rows = filtered.map((alert) => [
    `<a href="/deployments/${escapeHtml(alert.deployment_id)}">${escapeHtml(nameById.get(alert.deployment_id) ?? alert.deployment_id)}</a>`,
    escapeHtml(alertLabel(alert.category)),
    badge(alert.severity === "warning" ? "Warning" : "Info", alert.severity === "warning" ? "warn" : "neutral"),
    `<code>${escapeHtml(alert.category)}</code>`,
  ]);
  return `<h1>Fleet alerts</h1>
<p class="lede">${filtered.length} of ${alerts.length} current alert${alerts.length === 1 ? "" : "s"} shown. Alerts are deterministic and derived by the fleet service; there is no acknowledgement, suppression or notification workflow in this console.</p>
${form}
<section aria-labelledby="alerts-list">
<h2 id="alerts-list">Current alerts</h2>
${
  alerts.length
    ? table(["Deployment", "Alert", "Severity", "Category"], rows, { caption: "Fleet alerts", empty: "No alerts match these filters." })
    : `<p class="empty">No current fleet alerts. Nothing in the fleet is alerting right now.</p>`
}
</section>`;
}

export function renderAudit(entries: FleetAuditEntry[], deployments: FleetDeployment[]): string {
  const nameById = new Map(deployments.map((deployment) => [deployment.id, deployment.alias ?? deployment.workspace_deployment_id]));
  const rows = entries.map((entry) => [
    escapeHtml(displayTimestamp(entry.created_at)),
    escapeHtml(auditLabel(entry.action)),
    `<code>${escapeHtml(entry.action)}</code>`,
    entry.deployment_id
      ? `<a href="/deployments/${escapeHtml(entry.deployment_id)}">${escapeHtml(nameById.get(entry.deployment_id) ?? entry.deployment_id)}</a>`
      : `<span class="muted">${NOT_REPORTED}</span>`,
    escapeHtml(displayValue(entry.detail)),
  ]);
  return `<h1>Operator audit</h1>
<p class="lede">Bounded operator-plane audit records returned by the fleet API. Secret material is never audited. This view is read-only; audit retention is a W27 item.</p>
<section aria-labelledby="audit-list">
<h2 id="audit-list">Audit records</h2>
${
  rows.length
    ? table(["When", "Action", "Canonical action", "Deployment", "Detail"], rows, { caption: "Fleet operator audit" })
    : `<p class="empty">No operator audit records yet.</p>`
}
</section>`;
}

export function renderLogin(error?: string): string {
  return `<h1>Sign in to the OpenJM Fleet Console</h1>
<p class="lede">This console is an OpenJM operator surface over the accepted OCP-2A fleet APIs. It is not the customer Workspace application.</p>
${error ? `<div class="notice notice--error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/login" class="login">
  <div class="filters__field">
    <label for="token">Fleet operator credential</label>
    <input id="token" name="token" type="password" autocomplete="off" required />
    <p class="hint">The credential is verified server-side and is never stored in your browser. Individual operator identity is a W27 hardening item.</p>
  </div>
  <button type="submit" class="button">Sign in</button>
</form>`;
}

export function renderServiceError(kind: "unreachable" | "timeout" | "unauthorized" | "server_error", surface: string): string {
  const detail =
    kind === "unreachable"
      ? "The fleet API could not be reached. This is a fleet-console-to-fleet-API problem, not a statement about any deployment."
      : kind === "timeout"
        ? "The fleet API did not respond within the console timeout. This is a fleet-service problem, not a statement about any deployment."
        : kind === "unauthorized"
          ? "The fleet API rejected the console credential. No fleet data is available until that is corrected."
          : "The fleet API returned an error response. No fleet data is available for this request.";
  return `<h1>Fleet API unavailable</h1>
<div class="notice notice--error" role="alert">
  <p>${escapeHtml(detail)}</p>
  <p>Deployment states are deliberately not shown, because a fleet-API outage must never be rendered as deployments being offline or stale.</p>
</div>
<p>Affected surface: ${escapeHtml(surface)}.</p>
<p><a class="button" href="${escapeHtml(surface === "overview" ? "/" : `/${surface}`)}">Retry</a></p>`;
}

export function renderNotFound(kind: "deployment" | "surface"): string {
  return kind === "deployment"
    ? `<h1>Deployment not found</h1><p>The fleet registry has no deployment with that identifier. It may never have been registered, or the identifier may be incorrect.</p><p><a class="button" href="/deployments">Back to deployments</a></p>`
    : `<h1>Page not found</h1><p>That console page does not exist.</p><p><a class="button" href="/">Back to the fleet overview</a></p>`;
}
