// W27 hardening acceptance: fleet migration concurrency (B1), abuse protection (B2), audit
// retention (B3) and rotate-vs-terminal-revocation ordering (B5).
//
// The concurrency properties are exercised against a real PostgreSQL database with real
// connections, not mocks, because advisory-lock and row-lock behaviour only exists there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  buildFleetService,
  ensureFleetSchema,
  fleetConfig,
  pruneFleetAudit,
  sealCredentialSecret,
} from "../apps/fleet/src/fleet.ts";
import { FLEET_MIGRATIONS, FLEET_MIGRATION_LOCK_KEY, fleetSchemaVersion, runFleetMigrations } from "../apps/fleet/src/migrations.ts";
import { RateLimiter, clientKey, rateLimitPolicy } from "../packages/security/rate-limit.ts";
import { buildEnvelope } from "../packages/operations/telemetry-transport.ts";
import { composeOperatorTelemetry, deploymentIdFrom, serializeOperatorTelemetry } from "../packages/operations/operator-telemetry.ts";
import { buildFleetConsole } from "../apps/fleet-web/src/server.ts";
import { fleetConsoleConfig } from "../apps/fleet-web/src/fleet-api.ts";

const TOKEN = "fleet-operator-token-0123456789";
const KEY = "fleet-encryption-key-0123456789abcdef";
const SECRET = "w".repeat(48);
// Per-run identities: this file must be re-runnable against a database that already carries
// earlier runs' rows and probe migrations.
const RUN = randomUUID().slice(0, 8);
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });

const config = fleetConfig({
  FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
  FLEET_OPERATOR_TOKEN: TOKEN,
  FLEET_ENCRYPTION_KEY: KEY,
  FLEET_STALE_MS: "60000",
  FLEET_OFFLINE_MS: "120000",
});

// ---------------------------------------------------------------------------
// B1 migration concurrency
// ---------------------------------------------------------------------------
test("concurrent fleet migration startup serializes on the database advisory lock", async () => {
  // Clear the probe so it is genuinely pending for this run.
  await pool.query("DELETE FROM fleet_schema_migrations WHERE version IN (9901, 9903)");
  await pool.query("DROP TABLE IF EXISTS w27_probe");
  const probe = { version: 9901, name: "w27_probe", sql: "CREATE TABLE IF NOT EXISTS w27_probe(id int PRIMARY KEY);" };
  const migrations = [...FLEET_MIGRATIONS, probe];
  // Two replicas starting at once, on separate connections from the same pool.
  const results = await Promise.all([runFleetMigrations(pool, migrations), runFleetMigrations(pool, migrations)]);
  const appliedIt = results.filter((versions) => versions.includes(9901));
  const skippedIt = results.filter((versions) => versions.length === 0);
  assert.equal(appliedIt.length, 1, "exactly one replica applies the pending migration");
  assert.equal(skippedIt.length, 1, "the waiting replica observes it already applied and applies nothing");
  const ledger = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_schema_migrations WHERE version=9901");
  assert.equal(ledger.rows[0].n, 1, "the ledger records the migration exactly once");
  const { rows } = await pool.query("SELECT to_regclass('public.w27_probe') AS t");
  assert.equal(rows[0].t, "w27_probe", "the migration's effect is present");
});

test("a failed fleet migration does not strand the advisory lock", async () => {
  await pool.query("DELETE FROM fleet_schema_migrations WHERE version IN (9902, 9903)");
  await pool.query("DROP TABLE IF EXISTS w27_after");
  const broken = [
    ...FLEET_MIGRATIONS,
    { version: 9902, name: "w27_broken", sql: "ALTER TABLE w27_does_not_exist ADD COLUMN x text;" },
  ];
  await assert.rejects(() => runFleetMigrations(pool, broken), "a failing migration rejects");
  const ledgerAfter = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_schema_migrations WHERE version=9902");
  assert.equal(ledgerAfter.rows[0].n, 0, "a failed migration does not advance the ledger");
  // If the lock had been stranded this call would block forever rather than returning.
  const after = await runFleetMigrations(pool, [
    { version: 9903, name: "w27_after_failure", sql: "CREATE TABLE IF NOT EXISTS w27_after(id int PRIMARY KEY);" },
  ]);
  assert.deepEqual(after, [9903], "the lock is released on the failure path");
  // And the lock is genuinely free for another session.
  const probe = await pool.connect();
  try {
    const got = await probe.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [FLEET_MIGRATION_LOCK_KEY.toString()]);
    assert.equal(got.rows[0].ok, true, "the advisory lock is available after the failing run");
    await probe.query("SELECT pg_advisory_unlock($1::bigint)", [FLEET_MIGRATION_LOCK_KEY.toString()]);
  } finally {
    probe.release();
  }
});

// ---------------------------------------------------------------------------
// B3 audit retention
// ---------------------------------------------------------------------------
async function seedAudit(rows: { id: string; createdAt: string }[]) {
  for (const row of rows) {
    await pool.query("INSERT INTO fleet_audit(id,action,deployment_id,detail,created_at) VALUES($1,'deployment.registered',NULL,NULL,$2)", [
      row.id,
      row.createdAt,
    ]);
  }
}

test("audit pruning removes only what is older than the cutoff and honours its batch bound", async () => {
  await pool.query("DELETE FROM fleet_audit");
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const retentionMs = 90 * 86_400_000;
  const cutoff = now - retentionMs;
  const at = (offsetMs: number) => new Date(cutoff + offsetMs).toISOString();
  await seedAudit([
    { id: randomUUID(), createdAt: at(-86_400_000) }, // well older
    { id: randomUUID(), createdAt: at(-1) }, // just before the cutoff
    { id: randomUUID(), createdAt: at(0) }, // exactly at the cutoff
    { id: randomUUID(), createdAt: at(1) }, // just after
    { id: randomUUID(), createdAt: at(86_400_000) }, // much newer
  ]);
  const removed = await pruneFleetAudit(pool, retentionMs, 500, now);
  assert.equal(removed, 2, "the two records older than the cutoff are removed");
  const remaining = await pool.query("SELECT created_at FROM fleet_audit ORDER BY created_at");
  assert.equal(remaining.rowCount, 3, "records at or newer than the cutoff are retained");
  const oldest = new Date(remaining.rows[0].created_at).getTime();
  assert.ok(oldest >= cutoff, "no retained record is older than the cutoff");

  // A large eligible set is removed in bounded batches rather than one unbounded delete.
  await pool.query("DELETE FROM fleet_audit");
  await seedAudit(Array.from({ length: 7 }, () => ({ id: randomUUID(), createdAt: at(-172_800_000) })));
  const firstPass = await pruneFleetAudit(pool, retentionMs, 3, now);
  assert.equal(firstPass, 3, "one pass removes at most the configured batch");
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM fleet_audit")).rows[0].n, 4);
  // Successive passes converge.
  let guard = 0;
  while ((await pruneFleetAudit(pool, retentionMs, 3, now)) > 0 && guard++ < 10);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM fleet_audit")).rows[0].n, 0, "repeated passes converge to empty");
});

test("audit retention configuration is bounded and defaults safely", () => {
  const low = fleetConfig({ FLEET_DATABASE_URL: "postgres://x", FLEET_OPERATOR_TOKEN: TOKEN, FLEET_ENCRYPTION_KEY: KEY, FLEET_AUDIT_RETENTION_MS: "1", FLEET_AUDIT_PRUNE_BATCH: "0" });
  assert.equal(low.auditRetentionMs, 86_400_000, "retention is clamped to a one day minimum");
  assert.equal(low.auditPruneBatch, 1, "the batch is clamped to at least one");
  const high = fleetConfig({ FLEET_DATABASE_URL: "postgres://x", FLEET_OPERATOR_TOKEN: TOKEN, FLEET_ENCRYPTION_KEY: KEY, FLEET_AUDIT_RETENTION_MS: "99999999999", FLEET_AUDIT_PRUNE_BATCH: "999999" });
  assert.equal(high.auditRetentionMs, 730 * 86_400_000, "retention is clamped to a 730 day maximum");
  assert.equal(high.auditPruneBatch, 5_000, "the batch is clamped to 5000");
  const base = fleetConfig({ FLEET_DATABASE_URL: "postgres://x", FLEET_OPERATOR_TOKEN: TOKEN, FLEET_ENCRYPTION_KEY: KEY });
  assert.equal(base.auditRetentionMs, 90 * 86_400_000, "the documented default is 90 days");
  assert.equal(base.auditPruneBatch, 500);
});

test("a pruning failure never rolls back or corrupts a committed lifecycle mutation", async () => {
  const hooks: any = {};
  const app = buildFleetService(pool, config, hooks);
  const ws = deploymentIdFrom("w27-prune-failure-" + RUN);
  const registration = await app.inject({ method: "POST", url: "/deployments", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { workspace_deployment_id: ws } });
  assert.equal(registration.statusCode, 201);
  const deployment = registration.json().id;
  hooks.beforeAuditPrune = async () => {
    throw new Error("simulated retention failure");
  };
  const disable = await app.inject({ method: "POST", url: `/deployments/${deployment}/lifecycle`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { state: "disabled" } });
  hooks.beforeAuditPrune = undefined;
  assert.equal(disable.statusCode, 200, "the mutation still reports success when retention fails");
  const state = await pool.query("SELECT state FROM deployments WHERE id=$1", [deployment]);
  assert.equal(state.rows[0].state, "disabled", "the committed lifecycle state is intact");
  const audited = await pool.query("SELECT COUNT(*)::int AS n FROM fleet_audit WHERE deployment_id=$1 AND action='deployment.disabled'", [deployment]);
  assert.equal(audited.rows[0].n, 1, "the required lifecycle audit is intact");
  await app.close();
});

// ---------------------------------------------------------------------------
// B5 rotate versus terminal revocation
// ---------------------------------------------------------------------------
test("terminal revocation wins over a concurrent credential rotation", async () => {
  const hooks: any = {};
  const app = buildFleetService(pool, config, hooks);
  const ws = deploymentIdFrom("w27-race-rotate-" + RUN);
  const registration = await app.inject({ method: "POST", url: "/deployments", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { workspace_deployment_id: ws } });
  const deployment = registration.json().id;
  const issued = await app.inject({ method: "POST", url: `/deployments/${deployment}/credentials`, headers: { authorization: `Bearer ${TOKEN}` } });
  const credentialId = issued.json().credential_id;
  const originalSecret = issued.json().secret;
  const before = await pool.query("SELECT secret_encrypted, rotated_at FROM deployment_credentials WHERE id=$1", [credentialId]);

  // Hold the revocation inside its transaction while it owns the deployment row lock.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  let armed = true;
  hooks.duringLifecycleTransaction = async () => {
    if (!armed) return;
    armed = false;
    locked();
    await held;
  };

  const revocation = app.inject({ method: "POST", url: `/deployments/${deployment}/lifecycle`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { state: "revoked" } });
  await acquired; // the revocation holds the deployment lock
  const rotation = app.inject({ method: "POST", url: `/deployments/${deployment}/credentials/${credentialId}/rotate`, headers: { authorization: `Bearer ${TOKEN}` } }); // blocks on the same lock
  release();
  const [revoked, rotated] = await Promise.all([revocation, rotation]);
  hooks.duringLifecycleTransaction = undefined;

  assert.equal(revoked.statusCode, 200, `revocation should win: ${revoked.body}`);
  assert.equal(rotated.statusCode, 409, `rotation must not return a fresh credential after revocation won: ${rotated.body}`);
  assert.equal(JSON.parse(rotated.body).error, "deployment_revoked");
  assert.ok(!rotated.body.includes("secret"), "the refused rotation returns no secret material");
  const after = await pool.query("SELECT secret_encrypted, rotated_at FROM deployment_credentials WHERE id=$1", [credentialId]);
  assert.equal(after.rows[0].secret_encrypted, before.rows[0].secret_encrypted, "no new secret material was written");
  assert.equal(after.rows[0].rotated_at, null, "the rotation did not proceed");
  // The terminal state is intact and the original secret is now unusable because the
  // deployment is revoked.
  const deploymentState = await pool.query("SELECT state FROM deployments WHERE id=$1", [deployment]);
  assert.equal(deploymentState.rows[0].state, "revoked");
  const payload = serializeOperatorTelemetry(composeOperatorTelemetry({ application: "workspace", version: "1.0.0", deploymentIdSeed: "w27-race-rotate", dependencies: { database: true }, now: new Date() }));
  const envelope = buildEnvelope({ deploymentId: ws, credentialId, secret: originalSecret, payload, now: new Date() });
  const ingest = await app.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: JSON.stringify(envelope) });
  assert.equal(ingest.statusCode, 403);
  assert.equal(JSON.parse(ingest.body).error, "deployment_revoked");
  await app.close();
});

test("rotation still succeeds when revocation has not won, with no lock-order deadlock", async () => {
  const app = buildFleetService(pool, config);
  const ws = deploymentIdFrom("w27-rotate-ok-" + RUN);
  const registration = await app.inject({ method: "POST", url: "/deployments", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { workspace_deployment_id: ws } });
  const deployment = registration.json().id;
  const issued = await app.inject({ method: "POST", url: `/deployments/${deployment}/credentials`, headers: { authorization: `Bearer ${TOKEN}` } });
  const credentialId = issued.json().credential_id;
  const oldSecret = issued.json().secret;
  const rotated = await app.inject({ method: "POST", url: `/deployments/${deployment}/credentials/${credentialId}/rotate`, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(rotated.statusCode, 200, rotated.body);
  const newSecret = rotated.json().secret;
  assert.notEqual(newSecret, oldSecret, "rotation produces a new secret");
  // Concurrent rotation and issuance both complete, which proves the shared deployment-first
  // lock order does not deadlock.
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: `/deployments/${deployment}/credentials/${credentialId}/rotate`, headers: { authorization: `Bearer ${TOKEN}` } }),
    app.inject({ method: "POST", url: `/deployments/${deployment}/credentials`, headers: { authorization: `Bearer ${TOKEN}` } }),
  ]);
  assert.equal(a.statusCode, 200, "concurrent rotation completes");
  assert.equal(b.statusCode, 201, "concurrent issuance completes");
  await app.close();
});

// ---------------------------------------------------------------------------
// B2 abuse protection
// ---------------------------------------------------------------------------
// Small budgets expressed through configuration, which is the path operators use.
const tinyEnv = {
  FLEET_RATE_LIMIT_AUTH_FAILURE: "2",
  FLEET_RATE_LIMIT_AUTH_FAILURE_GLOBAL: "10",
  FLEET_RATE_LIMIT_READ: "10",
  FLEET_RATE_LIMIT_MUTATION: "10",
  FLEET_RATE_LIMIT_INGEST: "10",
  FLEET_RATE_LIMIT_LOGIN_FAILURE: "10",
  FLEET_RATE_LIMIT_LOGIN: "10",
};
const tinyConfig = fleetConfig({
  FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
  FLEET_OPERATOR_TOKEN: TOKEN,
  FLEET_ENCRYPTION_KEY: KEY,
  FLEET_STALE_MS: "60000",
  FLEET_OFFLINE_MS: "120000",
  ...tinyEnv,
  FLEET_RATE_LIMIT_READ: "3",
  FLEET_RATE_LIMIT_MUTATION: "2",
  FLEET_RATE_LIMIT_INGEST: "2",
});
const tinyRules = {
  operatorAuthFailure: { limit: 2, windowMs: 60_000 },
  operatorAuthFailureGlobal: { limit: 5, windowMs: 60_000 },
  operatorRead: { limit: 3, windowMs: 60_000 },
  operatorMutation: { limit: 2, windowMs: 60_000 },
  ingestion: { limit: 2, windowMs: 60_000 },
  consoleLoginFailure: { limit: 2, windowMs: 60_000 },
  consoleLogin: { limit: 3, windowMs: 60_000 },
} as any;

let deploymentW27 = "";
// An explicit small-budget configuration used by the abuse tests, so the budgets under test
// are the ones configured here and cannot silently fall back to production defaults.
const abuseConfig = () =>
  fleetConfig({
    FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
    FLEET_OPERATOR_TOKEN: TOKEN,
    FLEET_ENCRYPTION_KEY: KEY,
    FLEET_RATE_LIMIT_AUTH_FAILURE: "2",
    FLEET_RATE_LIMIT_AUTH_FAILURE_GLOBAL: "10",
    FLEET_RATE_LIMIT_READ: "3",
    FLEET_RATE_LIMIT_MUTATION: "2",
    FLEET_RATE_LIMIT_INGEST: "2",
  });
const wsW27 = deploymentIdFrom("w27-abuse-" + RUN);
const credW27 = "cred-w27-abuse";

before(async () => {
  await ensureFleetSchema(pool);
  await pool.query("DELETE FROM fleet_audit");
  await pool.query("DELETE FROM deployment_credentials WHERE id=$1", [credW27]);
  await pool.query("DELETE FROM deployments WHERE workspace_deployment_id=$1", [wsW27]);
  deploymentW27 = randomUUID();
  await pool.query("INSERT INTO deployments(id,workspace_deployment_id,state) VALUES($1,$2,'active')", [deploymentW27, wsW27]);
  await pool.query("INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')", [
    credW27,
    deploymentW27,
    sealCredentialSecret(SECRET, credW27, config.encryptionKey),
  ]);
});

after(async () => {
  await pool.end();
});

test("repeated invalid operator credentials are bounded, and clients are isolated", async () => {
  const appW27 = buildFleetService(pool, abuseConfig());
  const bad = (ip: string) =>
    appW27.inject({ method: "GET", url: "/deployments", headers: { authorization: "Bearer wrong-credential-value" }, remoteAddress: ip });
  const statuses: number[] = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await bad("10.9.9.1")).statusCode);
  assert.equal(statuses[0], 401, "the first failures are ordinary rejections");
  assert.ok(statuses.includes(429), `the failure budget closes: ${statuses.join(",")}`);
  assert.equal(statuses.at(-1), 429, "a client that keeps failing stays limited");
  // A different client is not starved by another client's failures.
  const other = await appW27.inject({ method: "GET", url: "/deployments", headers: { authorization: `Bearer ${TOKEN}` }, remoteAddress: "10.9.9.3" });
  assert.equal(other.statusCode, 200, "a valid operator from another client is unaffected by another client's failures");
  // The 429 body carries no request detail.
  const limited = await bad("10.9.9.1");
  assert.ok(!limited.body.includes("wrong-credential-value"), "no credential material appears in the limited response");
  await appW27.close();
});

test("read, mutation and ingestion budgets are enforced and recover after the window", async () => {
  // Each surface gets its own app instance, so this proves enforcement and recovery without
  // depending on bucket state from another test. Exact per-request accounting is pinned by
  // the limiter unit test below; here the property under test is that abuse is bounded.
  const collect = async (call: () => Promise<any>, count: number): Promise<number[]> => {
    const seen: number[] = [];
    for (let i = 0; i < count; i += 1) seen.push((await call()).statusCode);
    return seen;
  };

  const readApp = buildFleetService(pool, abuseConfig());
  const read = () => readApp.inject({ method: "GET", url: "/deployments", headers: { authorization: `Bearer ${TOKEN}` }, remoteAddress: "10.9.8.1" });
  const reads = await collect(read, 6);
  assert.equal(reads[0], 200, "a legitimate read is served");
  assert.ok(reads.includes(429), `read volume is bounded: ${reads.join(",")}`);
  assert.ok((await read()).headers["retry-after"], "a retry-after hint is returned");
  await readApp.close();

  const mutateApp = buildFleetService(pool, abuseConfig());
  const mutate = () => mutateApp.inject({ method: "POST", url: `/deployments/${deploymentW27}/lifecycle`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { state: "enabled" }, remoteAddress: "10.9.8.2" });
  const mutations = await collect(mutate, 6);
  assert.equal(mutations[0], 200, "a legitimate lifecycle mutation is served");
  assert.ok(mutations.includes(429), `mutation volume is bounded: ${mutations.join(",")}`);
  await mutateApp.close();

  const ingestApp = buildFleetService(pool, abuseConfig());
  const freshEnvelope = () =>
    JSON.stringify(
      buildEnvelope({
        deploymentId: wsW27,
        credentialId: credW27,
        secret: SECRET,
        payload: serializeOperatorTelemetry(composeOperatorTelemetry({ application: "workspace", version: "1.0.0", deploymentIdSeed: "w27-abuse-" + RUN, dependencies: { database: true }, now: new Date() })),
        now: new Date(),
      }),
    );
  const ingest = () => ingestApp.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: freshEnvelope(), remoteAddress: "10.9.8.3" });
  const accepted = await ingest();
  assert.equal(accepted.statusCode, 202, "an allowed envelope is still accepted and fully verified");
  const ingests = await collect(ingest, 4);
  assert.ok(ingests.includes(429), `ingestion volume is bounded: ${ingests.join(",")}`);
  // Rate limiting is not a shortcut around verification: a hostile envelope from a fresh
  // client is rejected by the verification chain, not by the limiter.
  const hostile = await ingestApp.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: JSON.stringify({ envelope: "openjm.workspace.telemetry-envelope.v1" }), remoteAddress: "10.9.8.9" });
  assert.ok([400, 401, 403, 413, 415].includes(hostile.statusCode), `verification still governs payload validity: ${hostile.statusCode}`);
  assert.notEqual(hostile.statusCode, 429, "a fresh client is not limited before it is verified");
  await ingestApp.close();

  // Recovery is proven deterministically by the limiter unit test below, where the clock is
  // supplied explicitly, rather than by a process-level sleep in this test.
});

test("client attribution ignores spoofed forwarding headers unless a trusted proxy is configured", () => {
  // Without an explicitly trusted header, forwarding headers change nothing.
  const a = clientKey({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.7", null, false);
  const b = clientKey({ "x-forwarded-for": "9.9.9.9" }, "10.0.0.7", null, false);
  assert.equal(a, b, "spoofed forwarding headers do not change the client key");
  assert.match(a, /^socket:/);
  // With a trusted proxy header named explicitly, the last hop is used.
  assert.equal(clientKey({ "x-real-ip": "203.0.113.5" }, "10.0.0.7", "x-real-ip", true), clientKey({ "x-real-ip": "203.0.113.5" }, "10.0.0.8", "x-real-ip", true));
  assert.notEqual(clientKey({ "x-real-ip": "203.0.113.5" }, "10.0.0.7", "x-real-ip", true), clientKey({ "x-real-ip": "198.51.100.9" }, "10.0.0.7", "x-real-ip", true));
  // A multi-hop value uses the last entry, which is the one the trusted proxy appended.
  assert.equal(clientKey({ "x-real-ip": "1.1.1.1, 203.0.113.5" }, "10.0.0.7", "x-real-ip", true), clientKey({ "x-real-ip": "203.0.113.5" }, "10.0.0.7", "x-real-ip", true));
  // A non-address value falls back to the socket peer rather than becoming a key.
  assert.match(clientKey({ "x-real-ip": "not-an-address" }, "10.0.0.7", "x-real-ip", true), /^socket:/);
  // IPv6 clients are normalised to a /64 identity so interface churn cannot evade a budget.
  assert.equal(clientKey({}, "2001:db8:1:2:3:4:5:6", null, false), clientKey({}, "2001:db8:1:2:9:9:9:9", null, false));
  assert.match(clientKey({}, "::ffff:10.0.0.7", null, false), /10\.0\.0\.7$/);
  // The policy is bounded and defaults to enabling protection.
  assert.equal(rateLimitPolicy({}).enabled, true);
  assert.equal(rateLimitPolicy({ FLEET_RATE_LIMIT_ENABLED: "false" }).enabled, false);
  assert.equal(rateLimitPolicy({ FLEET_RATE_LIMIT_MAX_KEYS: "1" }).maxKeys, 100, "the key space is clamped");
});

test("the limiter key space is bounded so distinct keys cannot grow memory without limit", () => {
  const limiter = new RateLimiter(50);
  for (let i = 0; i < 500; i += 1) limiter.check(`key-${i}`, { limit: 5, windowMs: 60_000 }, 1_000);
  assert.ok(limiter.size() <= 50, "the bucket map stays within its configured bound");
});

test("fleet console sign-in is bounded and does not leak the credential", async () => {
  const consoleApp = buildFleetConsole(
    fleetConsoleConfig({
      FLEET_API_BASE_URL: "https://fleet.example.com",
      FLEET_OPERATOR_TOKEN: TOKEN,
      FLEET_CONSOLE_SESSION_SECRET: "w27-console-session-secret-0123456789",
      FLEET_RATE_LIMIT_LOGIN: "3",
      FLEET_RATE_LIMIT_LOGIN_FAILURE: "2",
    }),
    {
      client: { listDeployments: async () => ({ ok: true, data: { deployments: [] } }) } as any,
      verifier: async (t: string) => (t === TOKEN ? { ok: true } : { ok: false, error: "unauthorized" }),
    },
  );
  const attempt = (token: string, ip: string) =>
    consoleApp.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${encodeURIComponent(token)}`, remoteAddress: ip });
  assert.equal((await attempt("guess-one", "10.7.7.1")).statusCode, 401);
  assert.equal((await attempt("guess-two", "10.7.7.1")).statusCode, 401);
  const throttled = await attempt("guess-three", "10.7.7.1");
  assert.equal(throttled.statusCode, 429, "repeated sign-in failures are bounded");
  assert.ok(!throttled.body.includes("guess-three"), "the rejected credential is never echoed");
  // Another client can still sign in successfully.
  const ok = await attempt(TOKEN, "10.7.7.2");
  assert.equal(ok.statusCode, 303, "a legitimate operator from another client is unaffected");
  await consoleApp.close();
});

test("the limiter admits exactly its limit per window and then recovers after it elapses", () => {
  const limiter = new RateLimiter(100);
  const rule = { limit: 2, windowMs: 100 };
  const now = 1_000_000;
  assert.deepEqual(limiter.check("client", rule, now), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check("client", rule, now), { allowed: true, retryAfterSeconds: 0 });
  const denied = limiter.check("client", rule, now);
  assert.equal(denied.allowed, false, "the third request in the window is refused");
  assert.equal(denied.retryAfterSeconds, 1, "a bounded retry hint is returned");
  // A different key has its own budget.
  assert.equal(limiter.check("other-client", rule, now).allowed, true, "budgets are per key");
  // The window elapses and the same key is served again.
  assert.equal(limiter.check("client", rule, now + 101).allowed, true, "the budget recovers after the window");
});

test("rate-limit configuration is bounded and cannot disable protection accidentally", () => {
  const policy = rateLimitPolicy({ FLEET_RATE_LIMIT_READ: "0", FLEET_RATE_LIMIT_AUTH_FAILURE: "0", FLEET_RATE_LIMIT_WINDOW_MS: "1" });
  assert.ok(policy.rules.operatorRead.limit >= 1, "a zero read limit is clamped up rather than disabling reads");
  assert.equal(policy.rules.operatorRead.limit, 1, "and a deliberately small budget is honoured rather than silently raised");
  assert.ok(policy.rules.operatorAuthFailure.limit >= 1, "the failure budget cannot be clamped to zero");
  assert.ok(policy.rules.operatorAuthFailure.windowMs >= 100, "the window cannot be reduced to nothing");
  const normal = rateLimitPolicy({});
  assert.equal(normal.rules.operatorRead.limit, 600);
  assert.equal(normal.rules.operatorAuthFailure.limit, 10);
  assert.equal(normal.rules.consoleLoginFailure.limit, 5);
  assert.equal(normal.enabled, true);
});

// ---------------------------------------------------------------------------
// B4 encryption-key rotation contract
// ---------------------------------------------------------------------------
test("a fleet encryption key change requires controlled credential re-provisioning", async () => {
  const newKey = "rotated-fleet-encryption-key-0123456789";
  const seed = "w27-key-rotation-" + RUN;
  const ws = deploymentIdFrom(seed);
  const firstApp = buildFleetService(pool, config);
  const registration = await firstApp.inject({ method: "POST", url: "/deployments", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, payload: { workspace_deployment_id: ws } });
  assert.equal(registration.statusCode, 201);
  const deployment = registration.json().id;
  const issued = await firstApp.inject({ method: "POST", url: `/deployments/${deployment}/credentials`, headers: { authorization: `Bearer ${TOKEN}` } });
  const oldCredential = issued.json().credential_id;
  const oldSecret = issued.json().secret;
  const envelope = (credentialId: string, secret: string) =>
    JSON.stringify(
      buildEnvelope({
        deploymentId: ws,
        credentialId,
        secret,
        payload: serializeOperatorTelemetry(composeOperatorTelemetry({ application: "workspace", version: "1.0.0", deploymentIdSeed: seed, dependencies: { database: true }, now: new Date() })),
        now: new Date(),
      }),
    );
  // Under the original key the credential works.
  assert.equal((await firstApp.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: envelope(oldCredential, oldSecret) })).statusCode, 202);
  await firstApp.close();

  // The service comes up under a NEW encryption key while the old credential is still active.
  const rotatedKeyConfig = fleetConfig({
    FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
    FLEET_OPERATOR_TOKEN: TOKEN,
    FLEET_ENCRYPTION_KEY: newKey,
    FLEET_STALE_MS: "60000",
    FLEET_OFFLINE_MS: "120000",
  });
  const rotatedApp = buildFleetService(pool, rotatedKeyConfig);
  // An active credential sealed under the old key must fail closed, not silently succeed and
  // not be accepted with the wrong secret: this is why re-provisioning is required.
  const stale = await rotatedApp.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: envelope(oldCredential, oldSecret) });
  assert.equal(stale.statusCode, 401, `an old-key credential must fail closed: ${stale.body}`);
  assert.equal(JSON.parse(stale.body).error, "unknown_credential");
  // Re-provisioning under the new key works, and the old credential can be revoked first in
  // the documented ordering.
  const revoke = await rotatedApp.inject({ method: "POST", url: `/deployments/${deployment}/credentials/${oldCredential}/revoke`, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(revoke.statusCode, 200);
  const reissued = await rotatedApp.inject({ method: "POST", url: `/deployments/${deployment}/credentials`, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(reissued.statusCode, 201);
  const fresh = reissued.json();
  assert.equal((await rotatedApp.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: envelope(fresh.credential_id, fresh.secret) })).statusCode, 202, "a credential issued under the new key works");
  await rotatedApp.close();
});
