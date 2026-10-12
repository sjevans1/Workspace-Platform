// OCP-2A: fleet registry, credential lifecycle, ingestion, replay, deployment
// isolation, current state, stale/offline semantics, alerts, audit and operator
// authorization. Includes the adversarial ingestion matrix and the cross-deployment
// negatives.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  alertsFor,
  buildFleetService,
  ensureFleetSchema,
  FLEET_DEPLOYMENT_STATES,
  fleetConfig,
  onlineStateFor,
  openCredentialSecret,
  operatorTokenMatches,
  sealCredentialSecret,
  verifyIngestion,
} from "../apps/fleet/src/fleet.ts";
import {
  buildEnvelope,
  payloadDigest,
  signingInput,
  verifyEnvelopeSignature,
} from "../packages/operations/telemetry-transport.ts";
import { signature } from "../packages/events/index.ts";
import { composeOperatorTelemetry, serializeOperatorTelemetry } from "../packages/operations/operator-telemetry.ts";

const TOKEN = "fleet-operator-token-0123456789";
const KEY = "fleet-encryption-key-0123456789abcdef";
const SECRET_A = "a".repeat(48);
const SECRET_B = "b".repeat(48);

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
let app: any;
const config = fleetConfig({
  FLEET_DATABASE_URL: process.env.TEST_DATABASE_URL,
  FLEET_OPERATOR_TOKEN: TOKEN,
  FLEET_ENCRYPTION_KEY: KEY,
  FLEET_STALE_MS: "60000",
  FLEET_OFFLINE_MS: "120000",
});

const payloadFor = (seed: string) =>
  serializeOperatorTelemetry(
    composeOperatorTelemetry({
      application: "workspace",
      version: "1.0.0",
      deploymentIdSeed: seed,
      dependencies: { database: true, redis: true, storage: true },
      services: { worker: { configured: true, healthy: true } },
      antivirus: { clean: 1, infected: 0, error: 0 },
      now: new Date(),
    }),
  );

async function registerDeployment(input: {
  workspaceId: string;
  credentialId: string;
  secret: string;
  state?: string;
  deploymentState?: string;
}) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO deployments(id,workspace_deployment_id,alias,state) VALUES($1,$2,$3,$4)",
    [id, input.workspaceId, `alias-${input.workspaceId.slice(-4)}`, input.deploymentState ?? "active"],
  );
  await pool.query(
    "INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,$4)",
    [input.credentialId, id, sealCredentialSecret(input.secret, input.credentialId, config.encryptionKey), input.state ?? "active"],
  );
  return id;
}

before(async () => {
  await ensureFleetSchema(pool);
  await pool.query("DELETE FROM deployment_state_history");
  await pool.query("DELETE FROM deployment_current_state");
  await pool.query("DELETE FROM fleet_replay");
  await pool.query("DELETE FROM fleet_audit");
  await pool.query("DELETE FROM deployment_credentials");
  await pool.query("DELETE FROM deployments");
  app = buildFleetService(pool, config);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool.end();
});

const operator = (path: string) =>
  app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${TOKEN}` } });

const ingest = (body: string) =>
  app.inject({ method: "POST", url: "/ingest", headers: { "content-type": "application/json" }, payload: body });

test("fleet configuration fails closed on missing security settings", () => {
  assert.throws(() => fleetConfig({ FLEET_DATABASE_URL: "postgres://x", FLEET_ENCRYPTION_KEY: KEY }), /FLEET_OPERATOR_TOKEN/);
  assert.throws(() => fleetConfig({ FLEET_DATABASE_URL: "postgres://x", FLEET_OPERATOR_TOKEN: TOKEN }), /FLEET_ENCRYPTION_KEY/);
  assert.throws(() => fleetConfig({ FLEET_OPERATOR_TOKEN: TOKEN, FLEET_ENCRYPTION_KEY: KEY }), /FLEET_DATABASE_URL/);
  const ok = fleetConfig({ FLEET_DATABASE_URL: "postgres://x", FLEET_OPERATOR_TOKEN: TOKEN, FLEET_ENCRYPTION_KEY: KEY });
  assert.deepEqual(FLEET_DEPLOYMENT_STATES, ["active", "disabled", "revoked"]);
  assert.ok(ok.skewMs > 0 && ok.staleMs > 0 && ok.offlineMs > ok.staleMs);
  assert.equal(ok.operatorTokenHash, createHash("sha256").update(TOKEN).digest("hex"));
  assert.equal(operatorTokenMatches(TOKEN, ok.operatorTokenHash), true);
  assert.equal(operatorTokenMatches(`${TOKEN}x`, ok.operatorTokenHash), false);
});

test("credential secrets are sealed with a credential-bound AAD", () => {
  const sealed = sealCredentialSecret(SECRET_A, "cred-1", config.encryptionKey);
  assert.ok(!sealed.includes(SECRET_A), "the sealed value must not contain the plaintext");
  assert.equal(openCredentialSecret(sealed, "cred-1", config.encryptionKey), SECRET_A);
  // Moving a ciphertext to another credential id must fail, not silently decrypt.
  assert.throws(() => openCredentialSecret(sealed, "cred-2", config.encryptionKey));
  assert.throws(() => openCredentialSecret(sealed, "cred-1", createHash("sha256").update("other-key").digest()));
});

test("stale and offline semantics are factual and never inferred from registry state", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const cfg = { staleMs: 60_000, offlineMs: 120_000 };
  assert.equal(onlineStateFor({ state: "active", last_seen: null }, now, cfg), "never_seen");
  assert.equal(onlineStateFor({ state: "active", last_seen: "2026-10-12T11:59:30Z" }, now, cfg), "online");
  assert.equal(onlineStateFor({ state: "active", last_seen: "2026-10-12T11:58:00Z" }, now, cfg), "stale");
  assert.equal(onlineStateFor({ state: "active", last_seen: "2026-10-12T11:00:00Z" }, now, cfg), "offline");
  // A revoked or disabled deployment is a registry fact and never a telemetry-age guess.
  assert.equal(onlineStateFor({ state: "revoked", last_seen: "2026-10-12T11:59:59Z" }, now, cfg), "revoked");
  assert.equal(onlineStateFor({ state: "disabled", last_seen: null }, now, cfg), "disabled");
  // Boundary: exactly at the threshold is still online.
  assert.equal(onlineStateFor({ state: "active", last_seen: "2026-10-12T11:59:00Z" }, now, cfg), "online");
});

test("alerts are deterministic, bounded and derived only from factual state", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const cfg = { staleMs: 60_000, offlineMs: 120_000 };
  const stale = alertsFor(
    { id: "d1", alias: "a", state: "active", last_seen: "2026-10-12T11:58:00Z" },
    { telemetry: { readiness: { backup_state: "degraded" }, signals: { queue: { state: "degraded" } }, runtime: { worker: "unhealthy" } } },
    now,
    cfg,
  );
  const categories = stale.map((a) => a.category);
  assert.ok(categories.includes("deployment.stale"));
  assert.ok(categories.includes("backup.verification_failed"));
  assert.ok(categories.includes("queue.degraded"));
  assert.ok(categories.includes("worker.unhealthy"));
  assert.ok(stale.length <= 12, "alerts are bounded");
  const revoked = alertsFor({ id: "d2", alias: null, state: "revoked", last_seen: "2026-10-12T11:59:59Z" }, null, now, cfg);
  assert.deepEqual(revoked.map((a) => a.category), ["credential.revoked"]);
  const neverSeen = alertsFor({ id: "d3", alias: null, state: "active", last_seen: null }, null, now, cfg);
  assert.deepEqual(neverSeen.map((a) => a.category), ["deployment.never_seen"]);
});

test("ingestion rejects every hostile case fail closed", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const cfg = { skewMs: 120_000, maxEnvelopeBytes: 4_096 };
  const credential = { id: "cred-a", deployment_id: "ws-a", internal_id: "internal-a", state: "active", deployment_state: "active", secret: SECRET_A };
  const valid = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: payloadFor("ws-a"), now });
  const check = (over: Partial<Parameters<typeof verifyIngestion>[0]>) =>
    verifyIngestion({ rawBody: JSON.stringify(valid), envelope: valid, credential, now, config: cfg, ...over });

  assert.equal(check({}).ok, true, "the valid envelope must be accepted");
  assert.equal((check({ rawBody: "x".repeat(5000) }) as any).code, "payload_too_large");
  assert.equal((check({ envelope: null }) as any).code, "malformed");
  assert.equal((check({ envelope: { ...valid, envelope: "openjm.workspace.telemetry-envelope.v9" } as any }) as any).code, "unsupported_envelope_version");
  assert.equal((check({ credential: null }) as any).code, "unknown_credential");
  assert.equal((check({ credential: { ...credential, state: "revoked" , deployment_state: "active" } }) as any).code, "credential_inactive");
  // Credential/deployment binding: A's credential cannot speak for B.
  assert.equal((check({ credential: { ...credential, deployment_id: "ws-b" , deployment_state: "active" } }) as any).code, "credential_deployment_mismatch");
  const stale = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: valid.payload, now: new Date("2026-10-12T10:00:00Z"), nonce: "n-stale" });
  assert.equal((check({ envelope: stale }) as any).code, "timestamp_out_of_window");
  const future = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: valid.payload, now: new Date("2026-10-12T16:00:00Z"), nonce: "n-future" });
  assert.equal((check({ envelope: future }) as any).code, "timestamp_out_of_window");
  assert.equal((check({ envelope: { ...valid, payload: valid.payload.replace(/"sequence":0/, '"sequence":5') } as any }) as any).code, "payload_digest_mismatch");
  assert.equal((check({ envelope: { ...valid, signature: "0".repeat(64) } as any }) as any).code, "invalid_signature");
  assert.equal((check({ credential: { ...credential, secret: SECRET_B , deployment_state: "active" } }) as any).code, "invalid_signature");
  // An unsupported contract is rejected with a precise code before crypto runs.
  assert.equal(
    (check({ envelope: { ...valid, contract: "openjm.workspace.operator-telemetry.v9" } as any }) as any).code,
    "unsupported_contract_version",
  );
  assert.equal((check({ envelope: { ...valid, payload: "not-json" } as any }) as any).code, "payload_digest_mismatch");
  // A well-formed envelope whose payload is valid JSON but not the declared contract.
  // OCP-2A corrections: the payload is now strictly validated against the accepted
  // canonical shape, not merely parsed.
  const wrongContract = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: JSON.stringify({ schema: "other" }), now, nonce: "n-wrong" });
  assert.equal((check({ envelope: wrongContract }) as any).code, "canonical_unsupported_schema");
});

test("end to end: ingestion, current state, isolation, replay, reads and audit", async () => {
  const deploymentA = await registerDeployment({ workspaceId: "ws-a", credentialId: "cred-a", secret: SECRET_A });
  const deploymentB = await registerDeployment({ workspaceId: "ws-b", credentialId: "cred-b", secret: SECRET_B });

  // Unauthenticated operator access is refused, and no registry enumeration leaks.
  const anon = await app.inject({ method: "GET", url: "/deployments" });
  assert.equal(anon.statusCode, 401);
  const wrong = await app.inject({ method: "GET", url: "/deployments", headers: { authorization: "Bearer wrong-token-value-000000000" } });
  assert.equal(wrong.statusCode, 401);

  // Valid ingestion for A.
  const envelopeA = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: payloadFor("ws-a"), now: new Date() });
  const accepted = await ingest(JSON.stringify(envelopeA));
  assert.equal(accepted.statusCode, 202, accepted.body);

  // Replay of the same envelope and of a reused nonce are both refused.
  assert.equal((await ingest(JSON.stringify(envelopeA))).statusCode, 409, "replayed envelope must be refused");
  const replayedNonce = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: payloadFor("ws-a"), now: new Date(), nonce: envelopeA.nonce });
  assert.equal((await ingest(JSON.stringify(replayedNonce))).statusCode, 409, "replayed nonce must be refused");

  // B's credential cannot submit for A: the binding is rejected.
  const crossCredential = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-b", secret: SECRET_B, payload: payloadFor("ws-a"), now: new Date() });
  const cross = await ingest(JSON.stringify(crossCredential));
  assert.equal(cross.statusCode, 403, cross.body);
  assert.equal(JSON.parse(cross.body).error, "credential_deployment_mismatch");

  // B has never reported telemetry, so it stays never_seen while A is online.
  const list = await operator("/deployments");
  assert.equal(list.statusCode, 200);
  const stateA = list.json().deployments.find((d: any) => d.id === deploymentA);
  const stateB = list.json().deployments.find((d: any) => d.id === deploymentB);
  assert.equal(stateA.online_state, "online");
  assert.equal(stateB.online_state, "never_seen");
  assert.equal(stateA.contract_version, "openjm.workspace.operator-telemetry.v1");
  // The fleet preserves what Workspace reported: queue state is unknown when no
  // source fed queue depth, and it is never coerced to healthy.
  assert.equal(stateA.queue.state, "unknown");
  // Unknown database capacity is preserved as unknown, never coerced.
  assert.equal(stateA.database_capacity, null);

  // Detail view: B's record is independent of A's, with no secret material exposed.
  const detailA = await operator(`/deployments/${deploymentA}`);
  const detailB = await operator(`/deployments/${deploymentB}`);
  assert.equal(detailA.statusCode, 200);
  assert.equal(detailA.json().deployment.id, deploymentA);
  assert.equal(detailB.json().deployment.id, deploymentB);
  assert.equal(detailB.json().telemetry, null, "B has no telemetry yet");
  const rawA = JSON.stringify(detailA.json());
  assert.ok(!rawA.includes(SECRET_A), "credential secret must never be returned");
  assert.ok(!rawA.includes("secret_encrypted"));
  assert.equal(detailA.json().credentials[0].state, "active");
  // A's credential cannot read or alter B: the API has no per-credential surface at
  // all, and operator reads are registry-wide by explicit authorization only.
  assert.equal((await operator(`/deployments/${randomUUID()}`)).statusCode, 404, "no enumeration of unknown ids");

  // Alerts and audit are operator-scoped and bounded.
  const alerts = await operator("/alerts");
  assert.equal(alerts.statusCode, 200);
  assert.ok(Array.isArray(alerts.json().alerts));
  assert.ok(alerts.json().alerts.some((a: any) => a.category === "deployment.never_seen"), "B must alert as never_seen");
  const audit = await operator("/audit");
  assert.equal(audit.statusCode, 200);
  const actions = audit.json().audit.map((a: any) => a.action);
  assert.ok(actions.includes("ingestion.rejected"), "security rejections are audited");
  assert.ok(!JSON.stringify(audit.json()).includes(SECRET_A), "audit must never contain secret material");
  assert.ok(!JSON.stringify(audit.json()).includes(SECRET_B));

  // Credential revocation stops ingestion for that deployment only.
  await pool.query("UPDATE deployment_credentials SET state='revoked', revoked_at=now() WHERE id='cred-a'");
  const afterRevoke = buildEnvelope({ deploymentId: "ws-a", credentialId: "cred-a", secret: SECRET_A, payload: payloadFor("ws-a"), now: new Date() });
  const rejected = await ingest(JSON.stringify(afterRevoke));
  assert.equal(rejected.statusCode, 403);
  assert.equal(JSON.parse(rejected.body).error, "credential_inactive");
  // B remains untouched by A's revocation.
  assert.equal((await operator(`/deployments/${deploymentB}`)).json().deployment.state, "active");
});
