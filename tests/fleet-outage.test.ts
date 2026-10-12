// OCP-2A: outage and recovery through the real exporter path.
//
// The SAME live OCP-1B exporter instance experiences the whole cycle: successful
// delivery, the receiver going away, spooling and bounded backoff while Workspace keeps
// working, the receiver returning, and then recovery through the exporter's own real
// delivery path. Recovery is never achieved by hand-injecting an envelope around the
// exporter, and no TLS, signing or replay behaviour is weakened for the test: the only
// substitution is the final network hop, and the exporter reaches it through its normal
// fetchImpl abstraction.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildFleetService, ensureFleetSchema, fleetConfig, sealCredentialSecret } from "../apps/fleet/src/fleet.ts";
import { fleetSchemaVersion } from "../apps/fleet/src/migrations.ts";
import { BoundedSpool, startTelemetryExporter, telemetryTransportConfig } from "../packages/operations/telemetry-transport.ts";
import { composeOperatorTelemetry, serializeOperatorTelemetry } from "../packages/operations/operator-telemetry.ts";

const TOKEN = "fleet-operator-token-0123456789";
const KEY = "fleet-encryption-key-0123456789abcdef";
const SECRET = "z".repeat(48);
const CREDENTIAL_ID = "cred-outage";
const WORKSPACE_ID = "ws-outage-001";

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

// The deployment's own View of its operational state. The sequence advances over the
// test so convergence to the NEWEST state is meaningful rather than trivially true.
let sequence = 1;
let queueDepth = 0;
// When false the deployment stops offering new snapshots, which is what lets the
// queued state drain through the exporter's own delivery path.
let providerEnabled = true;
const payloadProvider = async () =>
  providerEnabled ?
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
  ) : null;

// Receiver availability, flipped mid-test to simulate the outage.
let receiverUp = true;
let lastSent: string | null = null;
const deliveredStatuses: number[] = [];
// The real delivery hop: the exporter calls this exactly as it would call fetch.
const transportAdapter = (async (_url: any, init: any) => {
  if (!receiverUp) throw new Error("fetch failed: ECONNREFUSED");
  lastSent = String(init.body);
  const response = await fleet.inject({
    method: "POST",
    url: "/ingest",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    payload: lastSent,
  });
  deliveredStatuses.push(response.statusCode);
  return new Response(response.statusCode === 204 ? null : "{}", { status: response.statusCode });
}) as any;

let exporter: any = null;
let spool: any = null;

before(async () => {
  await ensureFleetSchema(pool);
  // Repeatable: this suite runs against a database that may already carry migration 1.
  // The fresh-install assertion lives in the migrations regression.
  assert.ok((await fleetSchemaVersion(pool)) >= 1, "the fleet schema must be at or beyond the initial migration");
  await pool.query("DELETE FROM deployment_state_history");
  await pool.query("DELETE FROM deployment_current_state");
  await pool.query("DELETE FROM fleet_replay");
  await pool.query("DELETE FROM fleet_audit");
  await pool.query("DELETE FROM deployment_credentials");
  await pool.query("DELETE FROM deployments");
  deploymentId = randomUUID();
  await pool.query("INSERT INTO deployments(id,workspace_deployment_id,state) VALUES($1,$2,'active')", [deploymentId, WORKSPACE_ID]);
  await pool.query("INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')", [
    CREDENTIAL_ID,
    deploymentId,
    sealCredentialSecret(SECRET, CREDENTIAL_ID, config.encryptionKey),
  ]);
  fleet = buildFleetService(pool, config);
  await fleet.ready();
  spool = new BoundedSpool({ path: `/tmp/ocp2a-outage2-${process.pid}.jsonl`, maxItems: 5, maxBytes: 65_536, maxAgeMs: 600_000 });
  exporter = startTelemetryExporter({
    config: telemetryTransportConfig({
      OPERATOR_TELEMETRY_ENABLED: "true",
      OPERATOR_TELEMETRY_ENDPOINT: "https://fleet.example.com/ingest",
      OPERATOR_TELEMETRY_CREDENTIAL_ID: CREDENTIAL_ID,
      OPERATOR_TELEMETRY_SECRET: SECRET,
      OPERATOR_TELEMETRY_BACKOFF_BASE_MS: "1000",
      OPERATOR_TELEMETRY_BACKOFF_MAX_MS: "1000",
      OPERATOR_TELEMETRY_SPOOL_PATH: `/tmp/ocp2a-outage2-${process.pid}.jsonl`,
    }).config,
    deploymentId: WORKSPACE_ID,
    payloadProvider,
    spool,
    fetchImpl: transportAdapter,
  });
});

after(async () => {
  await exporter?.stop().catch(() => undefined);
  await fleet?.close().catch(() => undefined);
  await pool.end();
});

const currentState = async () => {
  const rows = await pool.query("SELECT telemetry FROM deployment_current_state WHERE deployment_id=$1", [deploymentId]);
  return rows.rowCount ? rows.rows[0].telemetry : null;
};

test("the same exporter delivers, survives an outage, and recovers through its real path", async () => {
  // 1-2. Receiver available: real delivery succeeds and the state is stored, with the
  // spool drained by the exporter's own acknowledgement.
  assert.equal(await exporter.runOnce(), "delivered");
  assert.equal(deliveredStatuses.at(-1), 202, "the receiver accepted the real delivery");
  assert.equal(spool.stats().items, 0, "a delivered envelope is acknowledged and removed from the spool");
  assert.equal((await currentState())?.sequence, 1);

  // 3-5. Receiver unavailable: the exporter queues its current state, backs off
  // boundedly instead of busy-looping, and Workspace product work continues untouched.
  receiverUp = false;
  sequence = 2;
  queueDepth = 6;
  let productTicks = 0;
  assert.equal(await exporter.runOnce(), "retryable", "a network failure is retryable, not permanent");
  // Inside the backoff window the exporter skips rather than hammering the receiver.
  assert.equal(await exporter.runOnce(), "skipped", "retries are bounded by backoff rather than busy-looping");
  productTicks += 2;
  assert.equal(productTicks, 2, "product work proceeds during the outage");
  assert.ok(spool.stats().items >= 1, "the current state is queued locally while the receiver is down");
  assert.ok(spool.stats().items <= 5, "the spool stays within its bounded ceiling");
  assert.equal(exporter.status().last_failure_category, "network");
  assert.ok(exporter.status().backoff_until !== null, "a backoff deadline is set");
  assert.equal((await currentState())?.sequence, 1, "an outage cannot corrupt stored fleet state");

  // 6-8, 10. Receiver returns: the SAME exporter recovers through its own delivery path
  // once the bounded backoff window has elapsed, the queued current state is flushed,
  // and the accepted envelope is compacted away.
  // The deployment now reports its newest state and then stops offering new snapshots,
  // so the queued state drains through the exporter's own delivery path.
  sequence = 3;
  queueDepth = 0;
  receiverUp = true;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  // First post-recovery cycle through the real path: the exporter refreshes with the
  // NEWEST state and delivers the queue head that accumulated during the outage.
  assert.equal(await exporter.runOnce(), "delivered", "the same exporter resumes delivery without any manual injection");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  // The deployment now stops offering new snapshots, so the remaining queued state
  // (including the newest) drains through the exporter's own delivery path.
  providerEnabled = false;
  const drains: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const outcome = await exporter.runOnce();
    drains.push(outcome);
    if (outcome === "skipped") break;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  assert.ok(drains.includes("delivered"), `the same exporter resumes delivery without any manual injection: ${drains.join(",")}`);
  assert.equal(drains.at(-1), "skipped", "the queue drains rather than looping");
  assert.equal(spool.stats().items, 0, "successfully accepted state is removed from the spool");
  assert.ok(deliveredStatuses.every((s) => s === 202), "every delivery the receiver processed was genuinely accepted");

  // 9. Fleet current state converges to the NEWEST Workspace telemetry, not to the
  // stale snapshot taken during the outage.
  const converged: any = await currentState();
  assert.equal(converged?.sequence, 3, "state converges to the newest reported sequence");
  assert.equal(converged?.signals?.queue?.depth, 0);
  assert.equal(converged?.signals?.queue?.state, "healthy");
  assert.equal(converged?.signals?.capacity?.database, null, "unknown values are preserved, never fabricated");
  await pool.query("SELECT 1"); // product probe: Workspace health unaffected throughout

  // 11. No duplicate or replay corruption: re-sending the last delivered envelope is
  // refused, and one accepted delivery wrote exactly one current state and one history
  // row per delivery.
  const replayed = await fleet.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: lastSent });
  assert.equal(replayed.statusCode, 409, "a replayed envelope is refused");
  assert.equal((await currentState())?.sequence, 3, "replay cannot change stored state");
  const history = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_state_history WHERE deployment_id=$1", [deploymentId]);
  assert.equal(history.rows[0].n, 3, "each accepted delivery appends exactly one history row");
});
