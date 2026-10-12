// OCP-2B browser acceptance: a real fleet console listener with deterministic fixtures.
//
// Started by the dedicated Playwright config's webServer. It uses the real
// `buildFleetConsole()` application and a stub FleetClient over the shared fixtures, so no
// fleet database, no OCP-2A service and no customer Workspace stack is required, and the
// online/stale/offline/never-seen/disabled/revoked states plus unknown fields are all
// deterministic rather than wall-clock dependent.
import { buildFleetConsole, fleetConsoleConfig } from "../apps/fleet-web/src/server.ts";
import type { FleetClient } from "../apps/fleet-web/src/fleet-api.ts";
import { ALERTS, AUDIT, DEPLOYMENTS, E2E_OPERATOR_TOKEN } from "./fixtures.ts";

export { E2E_OPERATOR_TOKEN };
const PORT = Number(process.env.FLEET_CONSOLE_E2E_PORT) || 4319;

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

await app.listen({ host: config.host, port: PORT });
console.log(`OCP-2B fleet console E2E listener ready on http://127.0.0.1:${PORT}`);

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
