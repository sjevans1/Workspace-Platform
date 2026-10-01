export type HttpMetricSnapshot = {
  method: string;
  statusClass: string;
  count: number;
  durationSeconds: number;
};

export class HttpMetrics {
  private values = new Map<string, { count: number; durationSeconds: number }>();

  record(method: string, statusCode: number, durationMs: number) {
    const normalizedMethod = new Set([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ]).has(method)
      ? method
      : "OTHER";
    const statusClass =
      Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
        ? `${Math.floor(statusCode / 100)}xx`
        : "other";
    const key = `${normalizedMethod}\0${statusClass}`;
    const current = this.values.get(key) || { count: 0, durationSeconds: 0 };
    current.count += 1;
    current.durationSeconds += Math.max(0, durationMs) / 1000;
    this.values.set(key, current);
  }

  snapshot(): HttpMetricSnapshot[] {
    return [...this.values.entries()]
      .map(([key, value]) => {
        const [method, statusClass] = key.split("\0");
        return { method, statusClass, ...value };
      })
      .sort((a, b) =>
        `${a.method}:${a.statusClass}`.localeCompare(
          `${b.method}:${b.statusClass}`,
        ),
      );
  }
}

export type MetricsSnapshot = {
  startedAt: number;
  dependencies: Record<string, boolean>;
  services: Record<
    string,
    | {
        healthy: boolean;
        configured?: true;
        values?: Record<string, number | null>;
      }
    | { configured: false }
  >;
  http: HttpMetricSnapshot[];
  antivirus?: Record<"clean" | "infected" | "error", number>;
};

const label = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
const number = (value: number) => (Number.isFinite(value) ? String(value) : "0");
const sample = (
  name: string,
  value: number,
  labels?: Record<string, string>,
) =>
  `${name}${
    labels
      ? `{${Object.entries(labels)
          .map(([key, item]) => `${key}="${label(item)}"`)
          .join(",")}}`
      : ""
  } ${number(value)}`;

export function renderPrometheusMetrics(snapshot: MetricsSnapshot) {
  const lines: string[] = [
    "# HELP workspace_up Whether the Workspace API process is running.",
    "# TYPE workspace_up gauge",
    "workspace_up 1",
    "# HELP workspace_process_uptime_seconds Seconds since the API process started.",
    "# TYPE workspace_process_uptime_seconds gauge",
    sample(
      "workspace_process_uptime_seconds",
      Math.max(0, (Date.now() - snapshot.startedAt) / 1000),
    ),
    "# HELP workspace_dependency_ready Whether an API dependency is currently reachable.",
    "# TYPE workspace_dependency_ready gauge",
  ];

  for (const [dependency, ready] of Object.entries(snapshot.dependencies).sort())
    lines.push(
      sample("workspace_dependency_ready", ready ? 1 : 0, { dependency }),
    );

  lines.push(
    "# HELP workspace_service_configured Whether an internal Workspace service health target is configured.",
    "# TYPE workspace_service_configured gauge",
    "# HELP workspace_service_healthy Whether a configured internal Workspace service reports healthy.",
    "# TYPE workspace_service_healthy gauge",
  );
  for (const [service, state] of Object.entries(snapshot.services).sort()) {
    const configured = state.configured !== false;
    lines.push(
      sample("workspace_service_configured", configured ? 1 : 0, { service }),
    );
    if (!configured) continue;
    lines.push(
      sample("workspace_service_healthy", state.healthy ? 1 : 0, { service }),
    );
    for (const [metric, value] of Object.entries(state.values || {}).sort()) {
      if (value == null) continue;
      lines.push(sample(`workspace_${service}_${metric}`, value));
    }
  }

  if (snapshot.antivirus) {
    lines.push(
      "# HELP workspace_antivirus_scans_total File malware scans by result since process start.",
      "# TYPE workspace_antivirus_scans_total counter",
    );
    for (const result of ["clean", "infected", "error"] as const)
      lines.push(
        sample("workspace_antivirus_scans_total", snapshot.antivirus[result], {
          result,
        }),
      );
  }

  lines.push(
    "# HELP workspace_http_requests_total HTTP responses by method and status class since process start.",
    "# TYPE workspace_http_requests_total counter",
    "# HELP workspace_http_request_duration_seconds_sum Cumulative HTTP response time by method and status class.",
    "# TYPE workspace_http_request_duration_seconds_sum counter",
    "# HELP workspace_http_request_duration_seconds_count HTTP responses included in the duration sum.",
    "# TYPE workspace_http_request_duration_seconds_count counter",
  );
  for (const item of snapshot.http) {
    const labels = { method: item.method, status_class: item.statusClass };
    lines.push(
      sample("workspace_http_requests_total", item.count, labels),
      sample(
        "workspace_http_request_duration_seconds_sum",
        item.durationSeconds,
        labels,
      ),
      sample(
        "workspace_http_request_duration_seconds_count",
        item.count,
        labels,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function fetchHealth(
  url: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown> & { healthy: boolean }> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return { healthy: false, status_code: response.status };
    const value = (await response.json()) as Record<string, unknown>;
    return { ...value, healthy: value.healthy === true };
  } catch {
    return { healthy: false };
  }
}
