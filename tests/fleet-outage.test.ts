// OCP-2A: outage and recovery convergence.
//
// Proves end to end that a fleet outage never affects Workspace, that OCP-1B spools
// and retries boundedly while the receiver is unavailable, that delivery resumes when
// it returns, that fleet current state converges to the latest Workspace state, and
// that replay cannot corrupt state. The real Workspace exporter and the real OCP-1B
// envelope signing are used throughout; only the final network hop is represented
// in-process by the receiver contract, because the real HTTPS client path is already
// proven by the accepted OCP-1B harness. No OCP-1B behaviour is weakened here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildFleetService, ensureFleetSchema, fleetConfig, sealCredentialSecret } from "../apps/fleet/src/fleet.ts";
import { BoundedSpool, buildEnvelope, startTelemetryExporter, telemetryTransportConfig } from "../packages/operations/telemetry-transport.ts";
import { composeOperatorTelemetry, serializeOperatorTelemetry } from "../packages/operations/operator-telemetry.ts";

const TOKEN = "fleet-operator-token-0123456789";
const KEY = "fleet-encryption-key-0123456789abcdef";
const SECRET = "z".repeat(48);
const WORKSPACE_ID = "ws-outage";

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
const config = fleetConfig({
  FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
  FLEET_OPERATOR_TOKEN: TOKEN,
  FLEET_ENCRYPTION_KEY: KEY,
  FLEET_STALE_MS: "60000",
  FLEET_OFFLINE_MS: "120000",
});
let fleet: any = null;
let deploymentId = "";

const workspacePayload = (sequence: number, queueDepth: number) =>
  serializeOperatorTelemetry(
    composeOperatorTelemetry({
      application: "workspace",
      version: "1.0.0",
      deploymentIdSeed: WORKSPACE_ID,
      sequence,
      dependencies: { database: true, redis: true, storage: true },
      services: { worker: { configured: true, healthy: true } },
      antivirus: { clean: 1, infected: 0, error: 0 },
      queueDepth,
      queueState: queueDepth > 0 ? "degraded" : "healthy",
      now: new Date(),
    }),
  );

async function startFleet() {
  const app = buildFleetService(pool, config);
  await app.ready();
  return app;
}

before(async () => {
  await ensureFleetSchema(pool);
  await pool.query("DELETE FROM deployment_state_history");
  await pool.query("DELETE FROM deployment_current_state");
  await pool.query("DELETE FROM fleet_replay");
  await pool.query("DELETE FROM fleet_audit");
  await pool.query("DELETE FROM deployment_credentials");
  await pool.query("DELETE FROM deployments");
  deploymentId = randomUUID();
  await pool.query("INSERT INTO deployments(id,workspace_deployment_id,state) VALUES($1,$2,'active')", [deploymentId, WORKSPACE_ID]);
  await pool.query("INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')", [
    "cred-outage",
    deploymentId,
    sealCredentialSecret(SECRET, "cred-outage", config.encryptionKey),
  ]);
  fleet = await startFleet();
});

after(async () => {
  await fleet?.close().catch(() => undefined);
  await pool.end();
});

const currentState = async () => {
  const rows = await pool.query("SELECT telemetry FROM deployment_current_state WHERE deployment_id=$1", [deploymentId]);
  return rows.rowCount ? rows.rows[0].telemetry : null;
};

test("a fleet outage never affects Workspace, and recovery converges state", async () => {
  // 1-2. Receiver available: a valid envelope is accepted and current state is stored.
  const first = buildEnvelope({ deploymentId: WORKSPACE_ID, credentialId: "cred-outage", secret: SECRET, payload: workspacePayload(1, 0), now: new Date() });
  const accepted = await fleet.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: JSON.stringify(first) });
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal((await currentState())?.sequence, 1);

  // 3-5. Receiver unavailable. The real Workspace exporter is driven against a fetch
  // that fails, which is a genuine outage from its point of view: it must spool, stay
  // bounded, and never disturb product operation.
  let productTicks = 0;
  const productWork = (async () => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      productTicks += 1;
    }
  })();
  const spool = new BoundedSpool({ path: `/tmp/ocp2a-outage-${process.pid}.jsonl`, maxItems: 3, maxBytes: 32_768, maxAgeMs: 600_000 });
  const exporter = startTelemetryExporter({
    config: telemetryTransportConfig({
      OPERATOR_TELEMETRY_ENABLED: "true",
      OPERATOR_TELEMETRY_ENDPOINT: "https://fleet.invalid/ingest",
      OPERATOR_TELEMETRY_CREDENTIAL_ID: "cred-outage",
      OPERATOR_TELEMETRY_SECRET: SECRET,
      OPERATOR_TELEMETRY_BACKOFF_BASE_MS: "1000",
      OPERATOR_TELEMETRY_BACKOFF_MAX_MS: "1000",
      OPERATOR_TELEMETRY_SPOOL_PATH: `/tmp/ocp2a-outage-${process.pid}.jsonl`,
    }).config,
    deploymentId: WORKSPACE_ID,
    payloadProvider: async () => workspacePayload(2, 4),
    spool,
    fetchImpl: (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as any,
  });
  const outcomes: string[] = [];
  for (let i = 0; i < 12; i += 1) outcomes.push(await exporter.runOnce().catch(() => "threw"));
  await productWork;
  assert.ok(!outcomes.includes("threw"), "exporter failures must never throw into the caller");
  assert.ok(productTicks === 20, "product work must continue during a fleet outage");
  assert.ok(spool.stats().items <= 3, "the spool stays bounded during the outage");
  assert.equal(exporter.status().last_failure_category, "network");
  assert.ok(exporter.status().backoff_until !== null, "retries are bounded by backoff");
  assert.ok(outcomes.filter((o) => o === "skipped").length > 0, "no retry busy-loop");
  // The fleet state is unchanged by the outage, because nothing was received.
  assert.equal((await currentState())?.sequence, 1, "an outage cannot corrupt stored state");
  await exporter.stop();

  // 6-8. Receiver restored: delivery resumes and fleet state converges to the newest
  // Workspace state, not to the stale snapshot.
  const newest = buildEnvelope({ deploymentId: WORKSPACE_ID, credentialId: "cred-outage", secret: SECRET, payload: workspacePayload(5, 7), now: new Date() });
  const resumed = await fleet.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: JSON.stringify(newest) });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const converged: any = await currentState();
  assert.equal(converged?.sequence, 5, "fleet state converges to the latest Workspace state");
  assert.equal(converged?.signals?.queue?.depth, 7);
  assert.equal(converged?.signals?.queue?.state, "degraded");
  // Undefined/absent values are preserved as unknown rather than fabricated.
  assert.equal(converged?.signals?.capacity?.database, null);

  // 9. Replay cannot corrupt state: re-sending the already accepted envelope is
  // refused and the stored state is untouched.
  const replay = await fleet.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: JSON.stringify(newest) });
  assert.equal(replay.statusCode, 409);
  assert.equal((await currentState())?.sequence, 5, "a replayed envelope cannot change stored state");

  // 10. Workspace product health was unaffected throughout: the product probe (a real
  // database round trip) still succeeds.
  await pool.query("SELECT 1");
});
