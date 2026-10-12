// OCP-2A corrections: strict canonical payload validation at ingestion, atomic
// accepted-ingestion persistence with rollback-safe replay, deployment disabled/revoked
// enforcement, the operator-plane lifecycle API, versioned fleet migrations, and the
// smaller correctness corrections (first_seen, threshold progression, UTF-8 bytes).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  buildFleetService,
  ensureFleetSchema,
  fleetConfig,
  openCredentialSecret,
  sealCredentialSecret,
} from "../apps/fleet/src/fleet.ts";
import { FLEET_MIGRATIONS, fleetSchemaVersion, runFleetMigrations } from "../apps/fleet/src/migrations.ts";
import { buildEnvelope } from "../packages/operations/telemetry-transport.ts";
import {
  OPERATOR_TELEMETRY_LIMITS,
  composeOperatorTelemetry,
  deploymentIdFrom,
  isCanonicalDeploymentId,
  serializeOperatorTelemetry,
  validateOperatorTelemetryV1,
} from "../packages/operations/operator-telemetry.ts";

const TOKEN = "fleet-operator-token-0123456789";
const KEY = "fleet-encryption-key-0123456789abcdef";
const SECRET_A = "a".repeat(48);
const SECRET_B = "b".repeat(48);

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
const config = fleetConfig({
  FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
  FLEET_OPERATOR_TOKEN: TOKEN,
  FLEET_ENCRYPTION_KEY: KEY,
  FLEET_STALE_MS: "60000",
  FLEET_OFFLINE_MS: "120000",
});
const hooks: {
  beforeStatePersist?: () => void;
  beforeReplayInsert?: () => void;
  beforeLifecycleAudit?: () => void;
  duringLifecycleTransaction?: (context: { action: string; deploymentId: string | null }) => Promise<void>;
} = {};
const app = buildFleetService(pool, config, hooks);

// Real OCP-1A opaque deployment identities, produced by the shared helper rather than
// invented literals.
const SEED_A = "corrections-a";
const SEED_B = "corrections-b";
const SEED_L = "lifecycle-001";
const WS_L = deploymentIdFrom(SEED_L);
const SEED_F = "first-seen-1";
const WS_F = deploymentIdFrom(SEED_F);
const WS_A = deploymentIdFrom(SEED_A);
const WS_B = deploymentIdFrom(SEED_B);
const CRED_A = "cred-corr-a";
const CRED_B = "cred-corr-b";
let deploymentA = "";
let deploymentB = "";

const validPayload = (seed = SEED_A, overrides: Record<string, unknown> = {}) => {
  const payload: any = JSON.parse(
    serializeOperatorTelemetry(
      composeOperatorTelemetry({
        application: "workspace",
        version: "1.0.0",
        deploymentIdSeed: seed,
        sequence: 1,
        dependencies: { database: true, redis: true },
        services: { worker: { healthy: true, values: { requests: 12, errors: 0 } } },
        antivirus: { clean: 1, infected: 0, error: 0 },
        queueDepth: 2,
        queueState: "degraded",
        now: new Date(),
      }),
    ),
  );
  return { ...payload, ...overrides };
};

// Only a request that actually carries a body declares a JSON content type; an empty
// body with a JSON content type is a malformed request rather than an intentional one.
const operator = (method: "GET" | "POST", url: string, payload?: unknown) =>
  payload === undefined
    ? app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } })
    : app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: payload as any,
      });

const ingest = (body: string) => app.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: body });

const envelopeFor = (payload: unknown, secret = SECRET_A, credentialId = CRED_A, deploymentId = WS_A) =>
  JSON.stringify(
    buildEnvelope({ deploymentId, credentialId, secret, payload: JSON.stringify(payload), now: new Date() }),
  );

const stateOf = async (id: string) => {
  const rows = await pool.query("SELECT telemetry FROM deployment_current_state WHERE deployment_id=$1", [id]);
  return rows.rowCount ? rows.rows[0].telemetry : null;
};

before(async () => {
  await ensureFleetSchema(pool);
  await pool.query("DELETE FROM deployment_state_history");
  await pool.query("DELETE FROM deployment_current_state");
  await pool.query("DELETE FROM fleet_replay");
  await pool.query("DELETE FROM fleet_audit");
  await pool.query("DELETE FROM deployment_credentials");
  await pool.query("DELETE FROM deployments");
  await app.ready();
  deploymentA = randomUUID();
  deploymentB = randomUUID();
  await pool.query("INSERT INTO deployments(id,workspace_deployment_id,state) VALUES($1,$2,'active')", [deploymentA, WS_A]);
  await pool.query("INSERT INTO deployments(id,workspace_deployment_id,state) VALUES($1,$2,'active')", [deploymentB, WS_B]);
  await pool.query("INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')", [
    CRED_A, deploymentA, sealCredentialSecret(SECRET_A, CRED_A, config.encryptionKey),
  ]);
  await pool.query("INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')", [
    CRED_B, deploymentB, sealCredentialSecret(SECRET_B, CRED_B, config.encryptionKey),
  ]);
});

after(async () => {
  await app.close();
  await pool.end();
});

// ---------------------------------------------------------------------------
// 1. Strict canonical telemetry validation
// ---------------------------------------------------------------------------
test("a correctly signed envelope with extra or content-bearing fields is rejected and nothing is persisted", async () => {
  const before_ = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_current_state");
  const cases: [string, Record<string, unknown>][] = [
    ["extra top-level field", { customer_content: "project apollo kickoff notes" }],
    ["extra nested field", (() => { const p = validPayload(); (p.signals.queue as any).tenant_id = "tenant-12345"; return p; })()],
    ["email in a legal field", (() => { const p = validPayload(); p.deployment.alias = "ops@example.com"; return p; })()],
    ["token in a legal field", (() => { const p = validPayload(); p.deployment.alias = "bearer abcdefgh12345678"; return p; })()],
    ["filename in a legal field", (() => { const p = validPayload(); p.deployment.alias = "invoice-2026.pdf"; return p; })()],
    ["connection string in a legal field", (() => { const p = validPayload(); p.deployment.alias = "postgres://u:pw@db.internal:5432/app"; return p; })()],
    ["session cookie in a legal field", (() => { const p = validPayload(); p.deployment.alias = "workspace_session=abcdef123456"; return p; })()],
  ];
  for (const [name, payload] of cases) {
    const response = await ingest(envelopeFor(payload));
    assert.equal(response.statusCode, 400, `${name} must be rejected`);
    assert.match(JSON.parse(response.body).error, /^canonical_/, `${name} must carry a precise canonical code`);
  }
  const after_ = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_current_state");
  assert.equal(after_.rows[0].n, before_.rows[0].n, "nothing is persisted for a rejected payload");
  const replay = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  assert.equal(replay.rows[0].n, 0, "a rejected payload never consumes replay state");
});

test("the canonical validator enforces shape, enums, bounds and the payload byte ceiling", async () => {
  const good = JSON.stringify(validPayload());
  assert.equal(validateOperatorTelemetryV1(good).ok, true);
  const bad = (mutate: (p: any) => void) => {
    const p = validPayload();
    mutate(p);
    return validateOperatorTelemetryV1(JSON.stringify(p));
  };
  assert.deepEqual(bad((p) => { p.schema = "openjm.workspace.operator-telemetry.v9"; }), { ok: false, code: "unsupported_schema" });
  assert.equal((bad((p) => { delete p.sequence; }) as any).ok, false);
  assert.deepEqual(bad((p) => { p.deployment.deployment_id = "short"; }), { ok: false, code: "invalid_deployment_id" });
  assert.deepEqual(bad((p) => { p.runtime.worker = "mostly-fine"; }), { ok: false, code: "invalid_runtime_worker" });
  assert.equal((bad((p) => { p.events = Array.from({ length: OPERATOR_TELEMETRY_LIMITS.maxEvents + 1 }, () => ({ category: "ok", count: 1 })); }) as any).ok, false);
  assert.equal((bad((p) => { p.deployment.alias = "x".repeat(OPERATOR_TELEMETRY_LIMITS.maxAliasLength + 1); }) as any).ok, false);
  assert.equal((bad((p) => { p.signals.requests.total = -1; }) as any).ok, false);
  assert.equal((bad((p) => { p.signals.requests.total = 1.5; }) as any).ok, false);
  // JSON cannot carry NaN or Infinity, so non-finite values can only arrive as
  // mistyped strings or booleans; both must still be refused.
  assert.equal((bad((p) => { p.signals.capacity.storage = "12"; }) as any).ok, false);
  assert.equal((bad((p) => { p.signals.capacity.storage = true; }) as any).ok, false);
  assert.equal((bad((p) => { p.signals.services = "nope"; }) as any).ok, false);
  assert.equal((bad((p) => { p.readiness.profiles = { identity: null, storage: null, extra: null }; }) as any).ok, false);
});

test("an oversized canonical payload is rejected independently of the envelope ceiling", async () => {
  // Structurally legal, but far over the OCP-1A 16384-byte payload ceiling. Multi-byte
  // characters are used so byte counting, not character counting, is what rejects it.
  const wide = "☃".repeat(96);
  const payload = validPayload();
  payload.signals.services = Array.from({ length: OPERATOR_TELEMETRY_LIMITS.maxServices }, (_, i) => ({
    name: `${wide}${i}`.slice(0, 96),
    state: "healthy",
    configured: true,
    values: Array.from({ length: OPERATOR_TELEMETRY_LIMITS.maxServiceValues }, (_, j) => ({ name: `${wide}${j}`.slice(0, 96), value: 1 })),
  }));
  const serialized = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(serialized, "utf8") > OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes, "the fixture must exceed the payload ceiling");
  assert.ok(Buffer.byteLength(serialized, "utf8") < config.maxEnvelopeBytes, "the envelope itself stays under the envelope ceiling");
  assert.deepEqual(validateOperatorTelemetryV1(serialized), { ok: false, code: "payload_too_large" });
  const response = await ingest(envelopeFor(payload));
  assert.equal(response.statusCode, 413);
  assert.equal(JSON.parse(response.body).error, "canonical_payload_too_large");
});

// ---------------------------------------------------------------------------
// 2. Atomic accepted-ingestion persistence
// ---------------------------------------------------------------------------
test("a failure after replay insertion rolls back and the same envelope is then accepted", async () => {
  const body = envelopeFor(validPayload(SEED_A));
  const sequencesBefore = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_state_history WHERE deployment_id=$1", [deploymentA]);

  hooks.beforeStatePersist = () => {
    throw new Error("forced persistence failure after replay insertion");
  };
  const failed = await ingest(body);
  assert.equal(failed.statusCode, 503, "a persistence failure is reported as retryable, not as a replay");
  assert.equal(JSON.parse(failed.body).error, "persistence_failed");
  hooks.beforeStatePersist = undefined;

  // The transaction rolled back completely, including replay state, and no partial
  // state was written.
  const replay = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  assert.equal(replay.rows[0].n, 0, "replay state must be rolled back with the failed ingestion");
  const afterFailure = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_state_history WHERE deployment_id=$1", [deploymentA]);
  assert.equal(afterFailure.rows[0].n, sequencesBefore.rows[0].n, "no history row is written on failure");
  assert.equal(await stateOf(deploymentA), null, "no current state is written on failure");

  // Retrying the exact same envelope must succeed rather than being rejected as replay.
  const retry = await ingest(body);
  assert.equal(retry.statusCode, 202, `the same valid envelope must be retryable: ${retry.body}`);
  assert.equal((await stateOf(deploymentA))?.sequence, 1);
  const afterRetry = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_state_history WHERE deployment_id=$1", [deploymentA]);
  assert.equal(afterRetry.rows[0].n, sequencesBefore.rows[0].n + 1, "state is written exactly once");
  const replayAfter = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  assert.equal(replayAfter.rows[0].n, 1);

  // True replay rejection still holds after a successful commit.
  assert.equal((await ingest(body)).statusCode, 409);
});

// ---------------------------------------------------------------------------
// 3. Deployment disabled and revoked enforcement
// ---------------------------------------------------------------------------
test("a disabled or revoked deployment cannot ingest even with an active credential", async () => {
  assert.equal((await ingest(envelopeFor(validPayload(SEED_B), SECRET_B, CRED_B, WS_B))).statusCode, 202, "active deployment and active credential are accepted");

  const disable = await operator("POST", `/deployments/${deploymentB}/lifecycle`, { state: "disabled" });
  assert.equal(disable.statusCode, 200);
  const disabled = await ingest(envelopeFor(validPayload(SEED_B), SECRET_B, CRED_B, WS_B));
  assert.equal(disabled.statusCode, 403);
  assert.equal(JSON.parse(disabled.body).error, "deployment_disabled", "disabled is distinct from revoked and precisely coded");

  const enable = await operator("POST", `/deployments/${deploymentB}/lifecycle`, { state: "enabled" });
  assert.equal(enable.statusCode, 200);
  assert.equal((await ingest(envelopeFor(validPayload(SEED_B), SECRET_B, CRED_B, WS_B))).statusCode, 202, "re-enabling restores ingestion");

  const revoke = await operator("POST", `/deployments/${deploymentB}/lifecycle`, { state: "revoked" });
  assert.equal(revoke.statusCode, 200);
  const revoked = await ingest(envelopeFor(validPayload(SEED_B), SECRET_B, CRED_B, WS_B));
  assert.equal(revoked.statusCode, 403);
  assert.equal(JSON.parse(revoked.body).error, "deployment_revoked");
  // Revocation is terminal.
  assert.equal((await operator("POST", `/deployments/${deploymentB}/lifecycle`, { state: "enabled" })).statusCode, 409);

  // Disabling or revoking one deployment never affects another.
  assert.equal((await ingest(envelopeFor(validPayload(SEED_A)))).statusCode, 202, "deployment A is unaffected");
  await operator("POST", `/deployments/${deploymentB}/lifecycle`, { state: "disabled" });
  assert.equal((await ingest(envelopeFor(validPayload(SEED_A)))).statusCode, 202, "deployment A remains accepted");
  await operator("POST", `/deployments/${deploymentB}/lifecycle`, { state: "revoked" });
});

// ---------------------------------------------------------------------------
// 4. Operator-plane lifecycle API
// ---------------------------------------------------------------------------
test("registration, credential issuance, rotation and revocation are real audited capabilities", async () => {
  const registration = await operator("POST", "/deployments", { workspace_deployment_id: WS_L, alias: "fleet-a" });
  assert.equal(registration.statusCode, 201);
  const registered = registration.json();
  assert.equal(registered.state, "active");
  assert.equal((await operator("POST", "/deployments", { workspace_deployment_id: WS_L })).statusCode, 409, "duplicate registration is refused");
  assert.equal((await operator("POST", "/deployments", { workspace_deployment_id: "bad id!" })).statusCode, 400, "an invalid deployment id is refused");

  const issued = await operator("POST", `/deployments/${registered.id}/credentials`);
  assert.equal(issued.statusCode, 201);
  const { credential_id: credentialId, secret } = issued.json();
  assert.ok(typeof secret === "string" && secret.length >= 43, "the issued secret has high entropy");
  assert.equal(Buffer.from(secret, "base64url").length, 32, "the secret is 256 bits");
  // The secret is encrypted at rest, not stored in the clear.
  const stored = await pool.query("SELECT secret_encrypted FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.ok(!stored.rows[0].secret_encrypted.includes(secret), "the stored form must not contain the plaintext");
  assert.equal(openCredentialSecret(stored.rows[0].secret_encrypted, credentialId, config.encryptionKey), secret);

  // The read API reports credential identifiers and lifecycle state only.
  const detail = await operator("GET", `/deployments/${registered.id}`);
  assert.ok(!detail.body.includes(secret), "no read API may return the secret");
  assert.equal(detail.json().credentials[0].state, "active");

  // The issued credential works for ingestion.
  const usable = await ingest(envelopeFor(validPayload(SEED_L), secret, credentialId, WS_L));
  assert.equal(usable.statusCode, 202, usable.body);

  // Rotation replaces the secret; the previous secret stops working immediately.
  const rotated = await operator("POST", `/deployments/${registered.id}/credentials/${credentialId}/rotate`);
  assert.equal(rotated.statusCode, 200);
  const newSecret = rotated.json().secret;
  assert.notEqual(newSecret, secret, "rotation must produce a new secret");
  assert.equal((await ingest(envelopeFor(validPayload(SEED_L), secret, credentialId, WS_L))).statusCode, 401, "the previous secret is rejected");
  assert.equal((await ingest(envelopeFor(validPayload(SEED_L), newSecret, credentialId, WS_L))).statusCode, 202, "the rotated secret is accepted");
  const rotatedRow = await pool.query("SELECT rotated_at FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.ok(rotatedRow.rows[0].rotated_at !== null);

  // Revocation stops ingestion immediately.
  assert.equal((await operator("POST", `/deployments/${registered.id}/credentials/${credentialId}/revoke`)).statusCode, 200);
  const afterRevoke = await ingest(envelopeFor(validPayload(SEED_L), newSecret, credentialId, WS_L));
  assert.equal(afterRevoke.statusCode, 403);
  assert.equal(JSON.parse(afterRevoke.body).error, "credential_inactive");
  assert.equal((await operator("POST", `/deployments/${registered.id}/credentials/${credentialId}/revoke`)).statusCode, 404, "revoking twice is refused");

  // Unknown targets are 404 and every action is audited without secret material.
  assert.equal((await operator("POST", `/deployments/${randomUUID()}/credentials`)).statusCode, 404);
  assert.equal((await operator("POST", `/deployments/${registered.id}/lifecycle`, { state: "nonsense" })).statusCode, 400);
  const audit = await pool.query("SELECT action FROM fleet_audit WHERE deployment_id=$1", [registered.id]);
  const actions = audit.rows.map((row: any) => row.action);
  for (const expected of ["deployment.registered", "credential.issued", "credential.rotated", "credential.revoked"]) {
    assert.ok(actions.includes(expected), `missing audit event ${expected}`);
  }
  const allAudit = await pool.query("SELECT detail FROM fleet_audit");
  assert.ok(!JSON.stringify(allAudit.rows).includes(secret), "no secret material is written to audit");
  assert.ok(!JSON.stringify(allAudit.rows).includes(newSecret));
});

// ---------------------------------------------------------------------------
// 5. Versioned fleet migrations
// ---------------------------------------------------------------------------
test("fleet migrations are versioned, idempotent, additive and separate from Workspace", async () => {
  // Fresh install has already happened in before(): the ledger records version 1 and
  // the schema exists.
  assert.ok((await fleetSchemaVersion(pool)) >= 1, "the ledger records the applied version");
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  const names = tables.rows.map((row: any) => row.tablename);
  for (const expected of ["deployments", "deployment_credentials", "deployment_current_state", "deployment_state_history", "fleet_replay", "fleet_audit", "fleet_schema_migrations"]) {
    assert.ok(names.includes(expected), `missing fleet table ${expected}`);
  }
  // Idempotent: re-running applies nothing.
  assert.deepEqual(await runFleetMigrations(pool), [], "applying migrations twice is a no-op");
  // The ledger is entirely separate from any Workspace tenant migration state.
  assert.ok(!names.includes("schema_migrations"), "fleet migrations must not reuse the Workspace migration ledger");

  // Upgrade path: an additive future migration applies in order and preserves existing
  // rows, and is itself idempotent. The next version is derived from the live ledger so
  // the test is repeatable against a database that already carries earlier migrations.
  const nextVersion = (await fleetSchemaVersion(pool)) + 1;
  const marker = `corrections_marker_${nextVersion}`;
  const upgraded = [
    ...FLEET_MIGRATIONS,
    { version: nextVersion, name: `add_marker_${nextVersion}`, sql: `ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${marker} text;` },
  ];
  await pool.query("UPDATE deployments SET alias='survivor' WHERE id=$1", [deploymentA]);
  assert.deepEqual(await runFleetMigrations(pool, upgraded), [nextVersion], "only the pending migration is applied");
  assert.equal(await fleetSchemaVersion(pool), nextVersion, "the ledger advances");
  assert.deepEqual(await runFleetMigrations(pool, upgraded), [], "re-running the upgrade is a no-op");
  const survivor = await pool.query("SELECT alias FROM deployments WHERE id=$1", [deploymentA]);
  assert.equal(survivor.rows[0].alias, "survivor", "an additive migration preserves existing rows");

  // A broken migration rolls back without leaving a partial ledger entry.
  const broken = [
    ...upgraded,
    { version: nextVersion + 1, name: "broken", sql: "ALTER TABLE does_not_exist ADD COLUMN x text;" },
  ];
  await assert.rejects(() => runFleetMigrations(pool, broken));
  assert.equal(await fleetSchemaVersion(pool), nextVersion, "a failed migration does not advance the ledger");
});

// ---------------------------------------------------------------------------
// 6. Smaller correctness corrections
// ---------------------------------------------------------------------------
test("first_seen is recorded once and never overwritten", async () => {
  const id = randomUUID();
  await pool.query("INSERT INTO deployments(id,workspace_deployment_id,state) VALUES($1,$2,'active')", [id, WS_F]);
  const credentialId = "cred-first-seen";
  await pool.query("INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')", [
    credentialId, id, sealCredentialSecret(SECRET_A, credentialId, config.encryptionKey),
  ]);
  const first = envelopeFor(validPayload(SEED_F), SECRET_A, credentialId, WS_F);
  assert.equal((await ingest(first)).statusCode, 202);
  const after1 = await pool.query("SELECT first_seen, last_seen FROM deployments WHERE id=$1", [id]);
  assert.ok(after1.rows[0].first_seen !== null, "first_seen is set on the first accepted telemetry");
  const seen = after1.rows[0].first_seen;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = envelopeFor(validPayload(SEED_F, { sequence: 2 }), SECRET_A, credentialId, WS_F);
  assert.equal((await ingest(second)).statusCode, 202);
  const after2 = await pool.query("SELECT first_seen, last_seen FROM deployments WHERE id=$1", [id]);
  assert.equal(new Date(after2.rows[0].first_seen).toISOString(), new Date(seen).toISOString(), "first_seen is never overwritten");
  assert.notEqual(new Date(after2.rows[0].last_seen).toISOString(), new Date(seen).toISOString(), "last_seen advances");
});

test("the stale/offline threshold progression is normalized so it can never invert", () => {
  const inverted = fleetConfig({
    FLEET_DATABASE_URL: "postgres://x",
    FLEET_OPERATOR_TOKEN: TOKEN,
    FLEET_ENCRYPTION_KEY: KEY,
    FLEET_STALE_MS: "900000",
    FLEET_OFFLINE_MS: "60000",
  });
  assert.equal(inverted.offlineMsNormalized, true);
  assert.ok(inverted.offlineMs > inverted.staleMs, "offline must remain strictly beyond stale");
  const normal = fleetConfig({
    FLEET_DATABASE_URL: "postgres://x",
    FLEET_OPERATOR_TOKEN: TOKEN,
    FLEET_ENCRYPTION_KEY: KEY,
    FLEET_STALE_MS: "60000",
    FLEET_OFFLINE_MS: "120000",
  });
  assert.equal(normal.offlineMsNormalized, false);
  assert.ok(normal.staleMs < normal.offlineMs);
});

// ---------------------------------------------------------------------------
// Review pass 2 findings
// ---------------------------------------------------------------------------
test("the receiver enforces the accepted producer contract, not a superset", async () => {
  // A rich, producer-generated payload must validate unchanged.
  assert.equal(validateOperatorTelemetryV1(JSON.stringify(validPayload(SEED_A))).ok, true, "producer output validates unchanged");

  const bad = (mutate: (p: any) => void) => {
    const p = validPayload(SEED_A);
    mutate(p);
    return validateOperatorTelemetryV1(JSON.stringify(p));
  };
  // Service and value names pass through sanitizeServiceName(): lowercase [a-z0-9._-].
  assert.deepEqual(bad((p) => { p.signals.services[0].name = "Worker"; }), { ok: false, code: "invalid_signals_services" });
  // Underscore IS permitted by the producer's service-name shape, so it is not a
  // negative; a space or a leading digit is.
  assert.deepEqual(bad((p) => { p.signals.services[0].name = "my worker"; }), { ok: false, code: "invalid_signals_services" });
  assert.deepEqual(bad((p) => { p.signals.services[0].name = "1worker"; }), { ok: false, code: "invalid_signals_services" });
  assert.equal(validateOperatorTelemetryV1(JSON.stringify((() => { const q = validPayload(SEED_A); q.signals.services[0].name = "my_worker"; return q; })())).ok, true, "an underscore service name the producer accepts stays valid");
  assert.deepEqual(bad((p) => { p.signals.services[0].values[0].name = "Requests"; }), { ok: false, code: "invalid_signals_services" });
  // Status classes are producer constrained to [1-5]xx.
  assert.equal((bad((p) => { p.signals.requests.by_status_class = [{ status_class: "2XX", count: 1 }]; }) as any).ok, false);
  assert.equal((bad((p) => { p.signals.requests.by_status_class = [{ status_class: "20x", count: 1 }]; }) as any).ok, false);
  // Counts pass through boundedInt(): non-negative integers only.
  assert.deepEqual(bad((p) => { p.signals.queue.depth = 1.5; }), { ok: false, code: "invalid_signals_queue_depth" });
  assert.deepEqual(bad((p) => { p.signals.capacity.storage = 12.5; }), { ok: false, code: "invalid_signals_capacity_storage" });
  assert.equal((bad((p) => { p.signals.services[0].values[0].value = 2.25; }) as any).ok, false);
  // Event categories pass through sanitizeCategory(): lowercase allowlisted shape.
  assert.equal((bad((p) => { p.events = [{ category: "Backup.Verified", count: 1 }]; }) as any).ok, false);
  assert.equal((bad((p) => { p.events = [{ category: "backup verified", count: 1 }]; }) as any).ok, false);
  // Timestamps must be the canonical form the producer emits.
  assert.deepEqual(bad((p) => { p.generated_at = "2026-10-12T06:00:00Z"; }), { ok: false, code: "invalid_generated_at" });
  assert.equal((bad((p) => { p.readiness.last_backup_at = "2026-10-12 06:00:00"; }) as any).ok, false);
  // Text bounds are the producer's, not looser ones.
  assert.deepEqual(bad((p) => { p.source.application = "a".repeat(49); }), { ok: false, code: "invalid_source_application" });
  assert.deepEqual(bad((p) => { p.source.version = "v".repeat(33); }), { ok: false, code: "invalid_source_version" });
  assert.deepEqual(bad((p) => { p.deployment.version = "v".repeat(33); }), { ok: false, code: "invalid_deployment_version" });
  assert.deepEqual(bad((p) => { p.deployment.build_sha = "b".repeat(41); }), { ok: false, code: "invalid_deployment_build_sha" });
  assert.deepEqual(bad((p) => { p.readiness.schema_version = "s".repeat(33); }), { ok: false, code: "invalid_readiness_schema_version" });
  assert.deepEqual(bad((p) => { p.readiness.profiles.identity = "i".repeat(41); }), { ok: false, code: "invalid_readiness_profiles_identity" });
  assert.deepEqual(bad((p) => { p.deployment.release_channel = "r".repeat(25); }), { ok: false, code: "invalid_deployment_release_channel" });
  // A URL with a path or query is reduced by sanitizeText, so it is not canonical text.
  assert.deepEqual(bad((p) => { p.deployment.alias = "https://example.com/path?x=1"; }), { ok: false, code: "invalid_deployment_alias" });
  // Nulls the wire contract permits are still preserved.
  const nullable = validPayload(SEED_A);
  nullable.signals.capacity = { storage: null, database: null };
  nullable.readiness.last_backup_at = null;
  nullable.deployment.alias = null;
  assert.equal(validateOperatorTelemetryV1(JSON.stringify(nullable)).ok, true, "permitted nulls are preserved");
});

test("the validated payload identity is bound to the signed envelope", async () => {
  // Credential A, envelope A, correctly signed and digested, but the inner telemetry
  // claims deployment B.
  const impostor = validPayload(SEED_B);
  const before = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_state_history WHERE deployment_id=$1", [deploymentA]);
  const response = await ingest(envelopeFor(impostor, SECRET_A, CRED_A, WS_A));
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error, "deployment_identity_mismatch");
  const replay = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  const after = await pool.query("SELECT COUNT(*)::int AS n FROM deployment_state_history WHERE deployment_id=$1", [deploymentA]);
  assert.equal(after.rows[0].n, before.rows[0].n, "no history is persisted for a mismatched identity");
  // The replay table may hold rows from earlier tests; the mismatch must add none.
  const replayAfterMismatch = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  assert.equal(replayAfterMismatch.rows[0].n, replay.rows[0].n, "a mismatched identity consumes no replay state");
  // The matching identity still works.
  assert.equal((await ingest(envelopeFor(validPayload(SEED_A)))).statusCode, 202);
});

test("a non-uniqueness failure during the replay insert is retryable, not a replay", async () => {
  const body = envelopeFor(validPayload(SEED_A));
  const before = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  // Simulate an infrastructure error with a non-unique SQLSTATE.
  hooks.beforeReplayInsert = () => {
    throw Object.assign(new Error("simulated infrastructure failure"), { code: "57P01" });
  };
  const failed = await ingest(body);
  hooks.beforeReplayInsert = undefined;
  assert.equal(failed.statusCode, 503, "an infrastructure failure must not masquerade as a replay");
  assert.equal(JSON.parse(failed.body).error, "persistence_failed");
  const afterFailure = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_replay");
  assert.equal(afterFailure.rows[0].n, before.rows[0].n, "no replay row survives the failed attempt");
  // The very same envelope can subsequently be accepted.
  const retried = await ingest(body);
  assert.equal(retried.statusCode, 202, `the same envelope must be acceptable later: ${retried.body}`);
  // A true duplicate is still a replay.
  assert.equal((await ingest(body)).statusCode, 409, "a genuine duplicate nonce/signature is still a replay");
});

test("security-sensitive lifecycle mutations are audit-required and roll back together", async () => {
  const seed = "audit-required-1";
  const workspaceId = deploymentIdFrom(seed);
  const registration = await operator("POST", "/deployments", { workspace_deployment_id: workspaceId });
  assert.equal(registration.statusCode, 201);
  const deployment = registration.json().id;
  const issued = await operator("POST", `/deployments/${deployment}/credentials`);
  assert.equal(issued.statusCode, 201);
  const credentialId = issued.json().credential_id;
  const secret = issued.json().secret;
  assert.equal((await ingest(envelopeFor(validPayload(seed), secret, credentialId, workspaceId))).statusCode, 202);

  hooks.beforeLifecycleAudit = () => {
    throw new Error("simulated audit write failure");
  };

  // Revocation must not happen without its audit record.
  const revoke = await operator("POST", `/deployments/${deployment}/credentials/${credentialId}/revoke`);
  assert.equal(revoke.statusCode, 503);
  const stillActive = await pool.query("SELECT state FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.equal(stillActive.rows[0].state, "active", "the credential is not revoked when the audit cannot commit");
  assert.equal(
    (await pool.query("SELECT COUNT(*)::int AS n FROM fleet_audit WHERE deployment_id=$1 AND action='credential.revoked'", [deployment])).rows[0].n,
    0,
    "no revoke audit row survives the rollback",
  );
  // Ingestion still works, proving nothing was half-applied.
  assert.equal((await ingest(envelopeFor(validPayload(seed), secret, credentialId, workspaceId))).statusCode, 202);

  // A deployment lifecycle transition must not occur unaudited.
  const disable = await operator("POST", `/deployments/${deployment}/lifecycle`, { state: "disabled" });
  assert.equal(disable.statusCode, 503);
  const state = await pool.query("SELECT state FROM deployments WHERE id=$1", [deployment]);
  assert.equal(state.rows[0].state, "active", "the deployment state is unchanged when the audit cannot commit");

  // Rotation must not change the secret without its audit record.
  const rotate = await operator("POST", `/deployments/${deployment}/credentials/${credentialId}/rotate`);
  assert.equal(rotate.statusCode, 503);
  const afterRotate = await pool.query("SELECT rotated_at FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.equal(afterRotate.rows[0].rotated_at, null, "the secret is not rotated when the audit cannot commit");
  assert.equal((await ingest(envelopeFor(validPayload(seed), secret, credentialId, workspaceId))).statusCode, 202, "the original secret still works");

  hooks.beforeLifecycleAudit = undefined;

  // With auditing available again, the same operations succeed.
  assert.equal((await operator("POST", `/deployments/${deployment}/credentials/${credentialId}/revoke`)).statusCode, 200);
  const revokedNow = await pool.query("SELECT state FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.equal(revokedNow.rows[0].state, "revoked");
  const audited = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_audit WHERE deployment_id=$1 AND action='credential.revoked'", [deployment]);
  assert.equal(audited.rows[0].n, 1, "the successful revocation is audited exactly once");
});

test("fleet registration refuses identifiers Workspace would never produce", async () => {
  assert.equal(isCanonicalDeploymentId(WS_A), true);
  for (const bad of ["ws-abc", "ws-" + "A".repeat(40), "ws-" + "z".repeat(40), deploymentIdFrom("x").slice(0, 20), "corrections-a"]) {
    assert.equal(isCanonicalDeploymentId(bad), false, `${bad} is not a canonical deployment id`);
    assert.equal((await operator("POST", "/deployments", { workspace_deployment_id: bad })).statusCode, 400, `${bad} must be refused at registration`);
  }
});

// ---------------------------------------------------------------------------
// Review pass 3 findings
// ---------------------------------------------------------------------------
test("terminal revocation cannot be raced by a concurrent enable", async () => {
  const ws = deploymentIdFrom("race-1");
  const registration = await operator("POST", "/deployments", { workspace_deployment_id: ws });
  assert.equal(registration.statusCode, 201);
  const deployment = registration.json().id;
  assert.equal((await operator("POST", `/deployments/${deployment}/lifecycle`, { state: "disabled" })).statusCode, 200);

  // Hold the revocation transaction open while its row lock is held, start a concurrent
  // enable, then let the revocation commit.
  let releaseRevocation!: () => void;
  const held = new Promise<void>((resolve) => { releaseRevocation = resolve; });
  let lockHeld!: () => void;
  const acquired = new Promise<void>((resolve) => { lockHeld = resolve; });
  let armed = true;
  hooks.duringLifecycleTransaction = async () => {
    if (!armed) return;
    armed = false;
    lockHeld();
    await held;
  };

  const revocation = operator("POST", `/deployments/${deployment}/lifecycle`, { state: "revoked" });
  await acquired; // the revocation is inside its transaction, holding the row lock
  const enable = operator("POST", `/deployments/${deployment}/lifecycle`, { state: "enabled" }); // blocks on FOR UPDATE
  releaseRevocation();
  const [revoked, enabled] = await Promise.all([revocation, enable]);
  hooks.duringLifecycleTransaction = undefined;

  assert.equal(revoked.statusCode, 200, `revocation should succeed: ${revoked.body}`);
  assert.equal(enabled.statusCode, 409, `enable must observe the committed revocation: ${enabled.body}`);
  assert.equal(JSON.parse(enabled.body).error, "deployment_revocation_terminal");
  const finalState = await pool.query("SELECT state FROM deployments WHERE id=$1", [deployment]);
  assert.equal(finalState.rows[0].state, "revoked", "terminal revocation survives the race");
  const enabledAudits = await pool.query(
    "SELECT COUNT(*)::int AS n FROM fleet_audit WHERE deployment_id=$1 AND action='deployment.enabled'",
    [deployment],
  );
  assert.equal(enabledAudits.rows[0].n, 0, "no successful enabled audit is emitted after revocation");
  const revokedAudits = await pool.query(
    "SELECT COUNT(*)::int AS n FROM fleet_audit WHERE deployment_id=$1 AND action='deployment.revoked'",
    [deployment],
  );
  assert.equal(revokedAudits.rows[0].n, 1, "the applied revocation is audited exactly once");
  // The bounded statuses survive: not-found is 404, terminal conflict is 409, not 503.
  assert.equal((await operator("POST", `/deployments/${randomUUID()}/lifecycle`, { state: "enabled" })).statusCode, 404);
  assert.equal((await operator("POST", `/deployments/${deployment}/lifecycle`, { state: "enabled" })).statusCode, 409);
});

test("revoked credentials and revoked deployments keep coherent terminal semantics", async () => {
  const seed = "coherence-1";
  const ws = deploymentIdFrom(seed);
  const registration = await operator("POST", "/deployments", { workspace_deployment_id: ws });
  assert.equal(registration.statusCode, 201);
  const deployment = registration.json().id;

  // Issuance while active is permitted.
  const active = await operator("POST", `/deployments/${deployment}/credentials`);
  assert.equal(active.statusCode, 201);
  const credentialId = active.json().credential_id;
  const secret = active.json().secret;

  // Issuance while disabled is deliberately permitted, for provisioning.
  assert.equal((await operator("POST", `/deployments/${deployment}/lifecycle`, { state: "disabled" })).statusCode, 200);
  const whileDisabled = await operator("POST", `/deployments/${deployment}/credentials`);
  assert.equal(whileDisabled.statusCode, 201, "issuance while disabled stays permitted for provisioning");
  assert.ok(whileDisabled.json().secret.length >= 43);
  assert.equal((await operator("POST", `/deployments/${deployment}/lifecycle`, { state: "enabled" })).statusCode, 200, "disable/re-enable stays reversible");

  // A revoked credential cannot be rotated, and no fresh secret material is created.
  assert.equal((await operator("POST", `/deployments/${deployment}/credentials/${credentialId}/revoke`)).statusCode, 200);
  const encryptedBefore = await pool.query("SELECT secret_encrypted, rotated_at FROM deployment_credentials WHERE id=$1", [credentialId]);
  const rotateRevoked = await operator("POST", `/deployments/${deployment}/credentials/${credentialId}/rotate`);
  assert.equal(rotateRevoked.statusCode, 409);
  assert.equal(JSON.parse(rotateRevoked.body).error, "credential_not_active");
  assert.ok(!rotateRevoked.body.includes("secret"), "a refused rotation returns no secret material");
  const encryptedAfter = await pool.query("SELECT secret_encrypted, rotated_at FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.equal(encryptedAfter.rows[0].secret_encrypted, encryptedBefore.rows[0].secret_encrypted, "the stored secret is unchanged");
  assert.equal(encryptedAfter.rows[0].rotated_at, null, "a refused rotation does not stamp rotated_at");
  assert.equal((await ingest(envelopeFor(validPayload(seed), secret, credentialId, ws))).statusCode, 403, "the revoked credential stays unusable");
  // An unknown credential still returns the bounded not-found status.
  assert.equal((await operator("POST", `/deployments/${deployment}/credentials/${randomUUID()}/rotate`)).statusCode, 404);

  // Issuance for a terminally revoked deployment is refused.
  assert.equal((await operator("POST", `/deployments/${deployment}/lifecycle`, { state: "revoked" })).statusCode, 200);
  const afterRevoke = await operator("POST", `/deployments/${deployment}/credentials`);
  assert.equal(afterRevoke.statusCode, 409);
  assert.equal(JSON.parse(afterRevoke.body).error, "deployment_revoked");
  const audit = await pool.query(
    "SELECT COUNT(*)::int AS n FROM fleet_audit WHERE deployment_id=$1 AND action='credential.issued'",
    [deployment],
  );
  assert.equal(audit.rows[0].n, 2, "no third issuance is audited for the refused request");
});
