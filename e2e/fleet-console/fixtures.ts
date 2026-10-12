// OCP-2B browser acceptance fixtures.
//
// Shared by the harness server and the spec so identifiers cannot drift between them.
// Workspace deployment ids are generated through the accepted OCP-1A `deploymentIdFrom()`
// helper rather than synthetic literals, keeping the fixtures consistent with the real
// OCP-2A/OCP-1A contract.
import { deploymentIdFrom } from "../../packages/operations/operator-telemetry.ts";

export const E2E_OPERATOR_TOKEN = "e2e-fleet-operator-token-0123456789";

export const E2E_IDS = {
  online: "e2e-record-online",
  stale: "e2e-record-stale",
  offline: "e2e-record-offline",
  never: "e2e-record-never",
  disabled: "e2e-record-disabled",
  revoked: "e2e-record-revoked",
} as const;

export const base = {
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

export const DEPLOYMENTS = [
  { ...base, id: E2E_IDS.online, workspace_deployment_id: deploymentIdFrom("e2e-online-seed"), alias: "e2e-alpha", state: "active", online_state: "online" },
  { ...base, id: E2E_IDS.stale, workspace_deployment_id: deploymentIdFrom("e2e-stale-seed"), alias: "e2e-bravo", state: "active", online_state: "stale", queue: { depth: 9, state: "degraded" } },
  {
    ...base,
    id: E2E_IDS.offline,
    workspace_deployment_id: deploymentIdFrom("e2e-offline-seed"),
    alias: "e2e-charlie",
    state: "active",
    online_state: "offline",
    storage: null,
    backup: { last_backup_at: null, state: "unknown" },
  },
  { ...base, id: E2E_IDS.never, workspace_deployment_id: deploymentIdFrom("e2e-never-seed"), alias: "e2e-delta", state: "active", online_state: "never_seen", last_seen: null, first_seen: null },
  { ...base, id: E2E_IDS.disabled, workspace_deployment_id: deploymentIdFrom("e2e-disabled-seed"), alias: "e2e-echo", state: "disabled", online_state: "disabled" },
  { ...base, id: E2E_IDS.revoked, workspace_deployment_id: deploymentIdFrom("e2e-revoked-seed"), alias: "e2e-foxtrot", state: "revoked", online_state: "revoked" },
] as any[];

export const ALERTS = [
  { deployment_id: E2E_IDS.offline, category: "deployment.offline", severity: "warning" },
  { deployment_id: E2E_IDS.stale, category: "queue.degraded", severity: "warning" },
  { deployment_id: E2E_IDS.never, category: "deployment.never_seen", severity: "info" },
] as any[];

export const AUDIT = [
  { action: "deployment.registered", deployment_id: E2E_IDS.online, detail: null, created_at: "2026-10-01T00:00:00.000Z" },
  { action: "credential.rotated", deployment_id: E2E_IDS.online, detail: "cred-e2e-1", created_at: "2026-10-02T00:00:00.000Z" },
  { action: "ingestion.rejected", deployment_id: null, detail: "replayed", created_at: "2026-10-03T00:00:00.000Z" },
];

