// OCP-1A: privacy, bounding and version behaviour for the operator telemetry
// contract. These tests assert on the SERIALIZED payload, not only the in-memory
// model, so a leak cannot hide behind object identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPERATOR_TELEMETRY_LIMITS,
  OPERATOR_TELEMETRY_SCHEMA,
  composeOperatorTelemetry,
  deploymentIdFrom,
  operatorTelemetryConfig,
  sanitizeText,
  scanForProhibited,
  serializeOperatorTelemetry,
} from "../packages/operations/operator-telemetry.ts";

// Obvious sentinels that must never survive composition.
const SENTINELS = {
  email: "cfo@acme-customer.example",
  bearer: "Bearer abcdefghijklmnop123456",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnQiOiJhY21lIn0.c2lnbmF0dXJl",
  cookie: "workspace_session=deadbeefdeadbeefdeadbeef",
  connection: "postgres://workspace_runtime:sekretpw@10.0.0.5:5432/tenant_acme",
  tenantId: "11111111-2222-3333-4444-555555555555",
  attachment: "Q3-acquisition-nda-signed.pdf",
  pageText: "Confidential merger discussion minutes",
  apiKey: "AKIAIOSFODNN7EXAMPLE",
  password: "client_secret=supersecretvalue",
};

test("hostile fixtures never survive serialization", () => {
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    buildSha: "abc1234",
    deploymentIdSeed: SENTINELS.connection,
    alias: SENTINELS.email,
    releaseChannel: SENTINELS.jwt,
    environment: SENTINELS.bearer,
    region: `https://idp.example.com/realms/acme?tenant=${SENTINELS.tenantId}`,
    now: new Date("2026-10-11T00:00:00Z"),
    startedAt: Date.parse("2026-10-11T00:00:00Z") - 90_000,
    dependencies: { database: true, redis: false, storage: true, [SENTINELS.connection]: false },
    services: {
      worker: { configured: true, healthy: true, values: { queued: 3 } },
      [SENTINELS.attachment]: { configured: true, healthy: true },
    },
    http: [{ method: "GET", statusClass: "2xx", count: 10, durationSeconds: 0.5 }],
    antivirus: { clean: 4, infected: 0, error: 0 },
    schemaVersion: SENTINELS.password,
    identityProfile: SENTINELS.connection,
    storageProfile: SENTINELS.attachment,
    events: [
      { category: SENTINELS.pageText, count: 2 },
      { category: "job.retry", count: 1 },
      { category: SENTINELS.email, count: 1 },
    ],
  });
  const serialized = serializeOperatorTelemetry(payload);

  for (const [name, sentinel] of Object.entries(SENTINELS)) {
    assert.ok(
      !serialized.includes(sentinel),
      `prohibited ${name} survived serialization`,
    );
  }
  // Sanity: the payload is still a usable contract, not an empty string.
  assert.ok(serialized.length > 100);
  assert.equal(scanForProhibited(serialized).length, 0);
});

test("the privacy scan is machine-enforced on the payload, not merely by convention", () => {
  const clean = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: "seed",
  });
  // Inject a prohibited value directly, bypassing the sanitizers, and prove that
  // serialization refuses to emit it.
  (clean as any).deployment.alias = SENTINELS.email;
  assert.throws(() => serializeOperatorTelemetry(clean), /privacy violation/);
  assert.deepEqual(scanForProhibited(`{"a":"${SENTINELS.bearer}"}`), ["bearer_token"]);
  assert.deepEqual(scanForProhibited(`{"a":"${SENTINELS.connection}"}`), ["connection_string"]);
});

test("payload is deterministically bounded", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    category: `job.retry.${i}`,
    count: i,
  }));
  const services = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`svc-${i}`, { configured: true, healthy: true }]),
  );
  const long = "x".repeat(500);
  const fixedNow = new Date("2026-10-11T00:00:00Z");
  const payload = composeOperatorTelemetry({
    now: fixedNow,
    application: long,
    version: long,
    deploymentIdSeed: "seed",
    alias: long,
    releaseChannel: long,
    environment: long,
    region: long,
    services,
    events: many,
    schemaVersion: long,
  });
  const serialized = serializeOperatorTelemetry(payload);
  assert.ok(payload.events.length <= OPERATOR_TELEMETRY_LIMITS.maxEvents);
  assert.ok(Object.keys(payload.signals.services).length <= OPERATOR_TELEMETRY_LIMITS.maxServices);
  assert.ok((payload.deployment.alias ?? "").length <= OPERATOR_TELEMETRY_LIMITS.maxAliasLength);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes,
  );
  // Deterministic: identical input produces byte-identical output.
  const again = serializeOperatorTelemetry(
    composeOperatorTelemetry({
      now: fixedNow,
      application: long,
      version: long,
      deploymentIdSeed: "seed",
      alias: long,
      releaseChannel: long,
      environment: long,
      region: long,
      services,
      events: many,
      schemaVersion: long,
    }),
  );
  assert.equal(serialized, again);
  // Fixed field order freezes the public serialized shape.
  assert.equal(
    serialized.slice(0, 40),
    '{"schema":"openjm.workspace.operator-tel',
  );
});

test("version behaviour is explicit and rejects unknown schemas", () => {
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: "seed",
  });
  assert.equal(payload.schema, OPERATOR_TELEMETRY_SCHEMA);
  assert.match(OPERATOR_TELEMETRY_SCHEMA, /\.v1$/);
  const tampered = { ...payload, schema: "openjm.workspace.operator-telemetry.v2" } as any;
  assert.throws(() => serializeOperatorTelemetry(tampered), /Unsupported/);
});

test("absent configuration and unavailable sources fail soft to unknown", () => {
  const config = operatorTelemetryConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.deploymentIdSeed, null);
  assert.equal(config.alias, null);
  assert.equal(config.environment, null);
  assert.equal(config.region, null);
  assert.equal(config.schema, OPERATOR_TELEMETRY_SCHEMA);

  // No sources at all: composition still succeeds and reports unknown.
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: "seed",
  });
  const serialized = serializeOperatorTelemetry(payload);
  assert.equal(payload.runtime.database, "unknown");
  assert.equal(payload.runtime.redis, "unknown");
  assert.equal(payload.runtime.storage, "unknown");
  assert.equal(payload.runtime.antivirus, "unknown");
  assert.equal(payload.readiness.backup_state, "unknown");
  assert.equal(payload.readiness.schema_version, null);
  assert.equal(payload.signals.queue.state, "unknown");
  assert.ok(serialized.includes('"unknown"'));
});

test("deployment identity is opaque, stable and free of customer content", () => {
  const seed = SENTINELS.email;
  const first = deploymentIdFrom(seed);
  assert.equal(first, deploymentIdFrom(seed));
  assert.notEqual(first, deploymentIdFrom("other-seed"));
  assert.ok(!first.includes("@"));
  assert.ok(!first.includes("acme"));
  assert.ok(first.length <= OPERATOR_TELEMETRY_LIMITS.maxDeploymentIdLength);
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: seed,
  });
  assert.equal(payload.deployment.deployment_id, first);
  assert.ok(!JSON.stringify(payload).includes(seed));
});

test("URLs are reduced to scheme and host, and categories are allowlisted", () => {
  assert.equal(
    sanitizeText("https://idp.example.com/realms/acme?tenant=secret#frag"),
    "https://idp.example.com",
  );
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: "seed",
    events: [
      { category: "upper case and spaces", count: 1 },
      { category: "job.retry", count: 4 },
    ],
  });
  assert.deepEqual(payload.events, [{ category: "job.retry", count: 4 }]);
});

test("health vocabulary is bounded and derived from existing primitives", () => {
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: "seed",
    dependencies: { database: true, redis: false, storage: true },
    services: {
      worker: { configured: true, healthy: true, values: { claims: 2 } },
      collaboration: { configured: false },
    },
    http: [
      { method: "GET", statusClass: "2xx", count: 8, durationSeconds: 0.2 },
      { method: "POST", statusClass: "5xx", count: 2, durationSeconds: 1.5 },
    ],
    antivirus: { clean: 1, infected: 1, error: 0 },
  });
  const allowed = new Set(["healthy", "degraded", "unhealthy", "unknown"]);
  for (const value of Object.values(payload.runtime)) {
    if (typeof value === "string") assert.ok(allowed.has(value), `unbounded state: ${value}`);
    else assert.equal(typeof value, "number");
  }
  assert.equal(payload.runtime.database, "healthy");
  assert.equal(payload.runtime.redis, "unhealthy");
  assert.equal(payload.runtime.collaboration, "unknown");
  assert.equal(payload.runtime.antivirus, "degraded");
  assert.equal(payload.signals.requests.total, 10);
  assert.equal(payload.signals.errors.total, 2);
  const workerEntry = payload.signals.services.find((s) => s.name === "worker")!;
  assert.deepEqual(workerEntry.values, [{ name: "claims", value: 2 }]);
});
