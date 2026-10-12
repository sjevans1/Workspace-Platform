// OCP-2B browser acceptance: a real fleet console listener with deterministic fixtures.
//
// Started by the dedicated Playwright config's webServer. It uses the real
// `buildFleetConsole()` application and a stub FleetClient holding fixed fixtures, so no
// fleet database, no OCP-2A service and no customer Workspace stack is required, and the
// online/stale/offline/never-seen/disabled/revoked states plus unknown fields are all
// deterministic rather than wall-clock dependent.
import { buildFleetConsole, fleetConsoleConfig } from "../../apps/fleet-web/src/server.ts";
import type { FleetClient } from "../../apps/fleet-web/src/fleet-api.ts";

export const E2E_OPERATOR_TOKEN = "e2e-fleet-operator-token-0123456789";
const PORT = Number(process.env.FLEET_CONSOLE_E2E_PORT) || 4319;

const base = {
  first_seen: "2026-10-01T00:00:00.000Z",
  last_seen: "2026-10-12T06:00:00.000Z",
  app_version: "1.0.0",
  build_sha: "e2e-build-sha",
  schema_version: "28",
  contract_version: "openjm.workspace.operator-telemetry.v1",
  queue: { depth: 0, state: "healthy" },
  storage: 41,
  database_capacity: null,
  backup: { last_backup_at: "2026-10-12T05:00:00.000Z", state: "healthy" },
  runtime: {
    overall: "healthy",
    api: "healthy",
    worker: "healthy",
    collaboration: "unknown",
    database: "healthy",
    redis: "unknown",
    storage: "healthy",
    antivirus: "healthy",
  },
};

const DEPLOYMENTS = [
  { ...base, id: "e2e-online", workspace_deployment_id: "ws-e2e1", alias: "e2e-alpha", state: "active", online_state: "online" },
  { ...base, id: "e2e-stale", workspace_deployment_id: "ws-e2e2", alias: "e2e-bravo", state: "active", online_state: "stale", queue: { depth: 9, state: "degraded" } },
  {
    ...base,
    id: "e2e-offline",
    workspace_deployment_id: "ws-e2e3",
    alias: "e2e-charlie",
    state: "active",
    online_state: "offline",
    storage: null,
    backup: { last_backup_at: null, state: "unknown" },
  },
  { ...base, id: "e2e-never", workspace_deployment_id: "ws-e2e4", alias: "e2e-delta", state: "active", online_state: "never_seen", last_seen: null, first_seen: null },
  { ...base, id: "e2e-disabled", workspace_deployment_id: "ws-e2e5", alias: "e2e-echo", state: "disabled", online_state: "disabled" },
  { ...base, id: "e2e-revoked", workspace_deployment_id: "ws-e2e6", alias: "e2e-foxtrot", state: "revoked", online_state: "revoked" },
] as any[];

const ALERTS = [
  { deployment_id: "e2e-offline", category: "deployment.offline", severity: "warning" },
  { deployment_id: "e2e-stale", category: "queue.degraded", severity: "warning" },
  { deployment_id: "e2e-never", category: "deployment.never_seen", severity: "info" },
] as any[];

const AUDIT = [
  { action: "deployment.registered", deployment_id: "e2e-online", detail: null, created_at: "2026-10-01T00:00:00.000Z" },
  { action: "credential.rotated", deployment_id: "e2e-online", detail: "cred-e2e-1", created_at: "2026-10-02T00:00:00.000Z" },
  { action: "ingestion.rejected", deployment_id: null, detail: "replayed", created_at: "2026-10-03T00:00:00.000Z" },
];

const client: FleetClient = {
  listDeployments: async () => ({ ok: true, data: { deployments: DEPLOYMENTS } }),
  deployment: async (id: string) => {
    const deployment = DEPLOYMENTS.find((entry) => entry.id === id);
    if (!deployment) return { ok: false, error: "server_error", status: 404 };
    return {
      ok: true,
      data: {
        deployment: { ...deployment, notes: null },
        credentials: [{ id: "cred-e2e-1", state: "active", created_at: "2026-10-01T00:00:00.000Z", rotated_at: null, revoked_at: null }],
        telemetry: {
          runtime: deployment.runtime,
          signals: {
            requests: { total: 120, by_status_class: [{ status_class: "2xx", count: 120 }] },
            errors: { total: 0, by_status_class: [] },
            latency: { samples: 120, total_seconds: 3.5, max_seconds: 0.4 },
            services: [{ name: "worker", state: "healthy", configured: true, values: [{ name: "requests", value: 12 }, { name: "failures", value: null }] }],
            queue: deployment.queue,
            capacity: { storage: null, database: null },
          },
        },
        history: [
          { observed_at: "2026-10-12T06:00:00.000Z", queue_state: deployment.queue.state, backup_state: deployment.backup.state, online_state: "online" },
          { observed_at: "2026-10-12T05:00:00.000Z", queue_state: null, backup_state: null, online_state: "online" },
        ],
        alerts: ALERTS.filter((alert) => alert.deployment_id === id),
      },
    };
  },
  alerts: async () => ({ ok: true, data: { alerts: ALERTS } }),
  audit: async () => ({ ok: true, data: { audit: AUDIT } }),
  health: async () => ({ ok: true, data: { status: "ok" } }),
};

// The console talks to a real listener; the stub replaces only the outbound OCP-2A hop.
const config = fleetConsoleConfig({
  FLEET_API_BASE_URL: "https://fleet.e2e.test",
  FLEET_OPERATOR_TOKEN: E2E_OPERATOR_TOKEN,
  FLEET_CONSOLE_SESSION_SECRET: "e2e-fleet-console-session-secret-0123456789",
  FLEET_CONSOLE_PORT: String(PORT),
  FLEET_CONSOLE_SECURE_COOKIE: "false",
});

const app = buildFleetConsole(config, {
  client,
  verifier: async (token: string) => (token === E2E_OPERATOR_TOKEN ? { ok: true } : { ok: false, error: "unauthorized" }),
});

await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`OCP-2B fleet console E2E listener ready on http://127.0.0.1:${PORT}`);

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
