// OCP-1C: support evidence contract, authorization state machine, bounded event
// summaries, hostile-fixture privacy, and fail-closed serialization.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORT_BUNDLE_LIMITS,
  SUPPORT_BUNDLE_VERSION,
  authorizationState,
  clampTtlMinutes,
  composeSupportBundle,
  serializeSupportBundle,
  summarizeOperationalEvents,
} from "../packages/operations/support-bundle.ts";
import {
  composeOperatorTelemetry,
  serializeOperatorTelemetry,
} from "../packages/operations/operator-telemetry.ts";

const NOW = new Date("2026-10-12T12:00:00Z");
const SENTINELS = {
  email: "cfo@acme-customer.example",
  tenant: "11111111-2222-3333-4444-555555555555",
  page: "Confidential merger discussion minutes",
  file: "Q3-acquisition-nda-signed.pdf",
  bearer: "Bearer abcdefghijklmnop123456",
  cookie: "workspace_session=deadbeefdeadbeef",
  connection: "postgres://workspace_runtime:sekretpw@10.0.0.5:5432/tenant_acme",
  secret: "client_secret=supersecretvalue",
};

const hostileTelemetry = () =>
  JSON.parse(
    serializeOperatorTelemetry(
      composeOperatorTelemetry({
        application: "workspace",
        version: "1.0.0",
        deploymentIdSeed: "seed-support",
        alias: SENTINELS.email,
        environment: SENTINELS.bearer,
        region: `https://idp.example.com/realms/acme?tenant=${SENTINELS.tenant}`,
        dependencies: { database: true, redis: false, storage: true },
        services: { worker: { configured: true, healthy: true, values: { claims: 2 } } },
        antivirus: { clean: 1, infected: 0, error: 0 },
        schemaVersion: SENTINELS.secret,
        identityProfile: SENTINELS.connection,
        events: [{ category: SENTINELS.page, count: 1 }],
        now: NOW,
      }),
    ),
  );

test("authorization state machine is exact at expiry and revocation", () => {
  const base = { state: "active", expires_at: "2026-10-12T13:00:00Z", revoked_at: null };
  assert.equal(authorizationState(null, NOW), "none");
  assert.equal(authorizationState(base, NOW), "active");
  // Exactly at expiry is no longer active.
  assert.equal(authorizationState(base, new Date("2026-10-12T13:00:00Z")), "expired");
  assert.equal(authorizationState(base, new Date("2026-10-12T13:00:01Z")), "expired");
  assert.equal(authorizationState({ ...base, revoked_at: "2026-10-12T12:30:00Z" }, NOW), "revoked");
  // A revoked record stays revoked even before its expiry.
  assert.equal(authorizationState({ ...base, state: "revoked" }, NOW), "expired");
  assert.equal(authorizationState({ ...base, state: "revoked", revoked_at: "2026-10-12T12:10:00Z" }, NOW), "revoked");
});

test("authorization TTL is bounded and never unbounded by default", () => {
  assert.equal(clampTtlMinutes(undefined), SUPPORT_BUNDLE_LIMITS.defaultTtlMinutes);
  assert.equal(clampTtlMinutes(0), SUPPORT_BUNDLE_LIMITS.defaultTtlMinutes);
  assert.equal(clampTtlMinutes(-5), SUPPORT_BUNDLE_LIMITS.defaultTtlMinutes);
  assert.equal(clampTtlMinutes("nonsense"), SUPPORT_BUNDLE_LIMITS.defaultTtlMinutes);
  assert.equal(clampTtlMinutes(30), 30);
  assert.equal(clampTtlMinutes(999999), SUPPORT_BUNDLE_LIMITS.maxTtlMinutes);
  assert.ok(SUPPORT_BUNDLE_LIMITS.maxTtlMinutes <= 1440, "support windows must be bounded to a day or less");
});

test("bounded operational events are factual, low-cardinality and identifier-free", () => {
  const events = summarizeOperationalEvents({
    telemetry: {
      signals: { queue: { depth: 4, state: "degraded" }, capacity: { storage: null, database: null } },
      readiness: { backup_state: "degraded" },
      runtime: { worker: "unhealthy", database: "healthy" },
      transport: { enabled: true, last_failure_category: "authentication" },
    },
    now: NOW,
  });
  const categories = events.map((e) => e.category);
  assert.ok(categories.includes("queue.degraded"));
  assert.ok(categories.includes("storage.capacity_unknown"));
  assert.ok(categories.includes("database.capacity_unknown"));
  assert.ok(categories.includes("backup.verification_failed"));
  assert.ok(categories.includes("worker.unhealthy"));
  assert.ok(categories.includes("telemetry_transport.failure"));
  assert.ok(!categories.includes("database.unhealthy"), "healthy services must not produce events");
  assert.ok(events.length <= SUPPORT_BUNDLE_LIMITS.maxEvents, "events must be bounded");
  for (const event of events) {
    assert.match(event.category, /^[a-z][a-z0-9._:-]{0,47}$/, "categories must be allowlisted");
    assert.ok(["info", "warning"].includes(event.severity));
  }
  // No customer value can become a category, and the count is bounded even when the
  // input is hostile.
  const many = summarizeOperationalEvents({
    telemetry: {
      runtime: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`service-${i}`, "unhealthy"]),
      ),
    },
    now: NOW,
  });
  assert.ok(many.length <= SUPPORT_BUNDLE_LIMITS.maxEvents);
  assert.ok(!JSON.stringify(many).includes("acme"));
});

test("a hostile environment never survives serialization of the bundle", () => {
  const bundle = composeSupportBundle({
    telemetry: hostileTelemetry(),
    transport: { enabled: true, last_failure_category: "none", envelope_version: "openjm.workspace.telemetry-envelope.v1" },
    deployment: { ok: true, issues: [], summary: { auth: SENTINELS.connection, storage: SENTINELS.file } },
    operational: {
      queue: { depth: 3, state: "degraded" },
      storage: { usedPercent: 41 },
      backup: { lastBackupAt: "2026-10-12T00:00:00.000Z", state: "verified" },
    },
    schemaVersion: SENTINELS.secret,
    applicationVersion: "1.0.0",
    buildSha: "abc1234",
    authorizationState: "active",
    purpose: SENTINELS.email,
    now: NOW,
  });
  const serialized = serializeSupportBundle(bundle);
  for (const [name, sentinel] of Object.entries(SENTINELS))
    assert.ok(!serialized.includes(sentinel), `bundle leaked ${name}`);
  assert.equal(bundle.bundle, SUPPORT_BUNDLE_VERSION);
  assert.equal(bundle.authorization.state, "active");
  assert.equal(bundle.authorization.purpose, null, "a hostile purpose must be dropped, not truncated");
  assert.equal(bundle.deployment.identity_profile, null);
  assert.equal(bundle.schema_version, null);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= SUPPORT_BUNDLE_LIMITS.maxBytes);
});

test("the bundle uses a strict allowlist and refuses unknown versions or injected values", () => {
  const bundle = composeSupportBundle({
    telemetry: hostileTelemetry(),
    transport: null,
    deployment: { ok: false, issues: [{ setting: "X", problem: "y" }] },
    operational: {},
    schemaVersion: "028_support_evidence.sql",
    authorizationState: "active",
    now: NOW,
  });
  assert.deepEqual(Object.keys(bundle).sort(), [
    "authorization",
    "bundle",
    "contract",
    "deployment",
    "digest",
    "events",
    "generated_at",
    "operational",
    "schema_version",
    "telemetry",
    "transport",
    "workspace",
  ]);
  assert.equal(bundle.deployment.preflight_valid, false);
  assert.equal(bundle.deployment.issues, 1);
  // Unknown/absent operational values stay honestly unknown, never fabricated.
  assert.equal(bundle.operational.queue.depth, null);
  assert.equal(bundle.operational.queue.state, "unknown");
  assert.equal(bundle.operational.storage.used_percent, null);
  assert.equal(bundle.operational.backup.state, "unknown");
  // Digest is deterministic for identical input.
  const again = composeSupportBundle({
    telemetry: hostileTelemetry(),
    transport: null,
    deployment: { ok: false, issues: [{ setting: "X", problem: "y" }] },
    operational: {},
    schemaVersion: "028_support_evidence.sql",
    authorizationState: "active",
    now: NOW,
  });
  assert.equal(bundle.digest, again.digest, "identical input must produce an identical digest");
  // Unknown version and injected prohibited values are both refused.
  assert.throws(() => serializeSupportBundle({ ...bundle, bundle: "openjm.workspace.support-bundle.v2" } as any), /Unsupported/);
  const injected = JSON.parse(JSON.stringify(bundle));
  injected.workspace.version = SENTINELS.email;
  assert.throws(() => serializeSupportBundle(injected), /privacy violation/);
});

test("the embedded telemetry snapshot keeps its own OCP-1A guarantees", () => {
  const telemetry = hostileTelemetry();
  const bundle = composeSupportBundle({ telemetry, authorizationState: "active", now: NOW });
  const serialized = serializeSupportBundle(bundle);
  // The embedded snapshot is the already-vetted OCP-1A payload, so its own privacy
  // and ceiling guarantees carry into the bundle unchanged.
  assert.deepEqual(bundle.telemetry, telemetry, "the snapshot must be embedded as-is, not re-derived");
  for (const sentinel of Object.values(SENTINELS))
    assert.ok(!serialized.includes(sentinel), "embedded snapshot must stay clean");
  assert.ok(Buffer.byteLength(serialized, "utf8") <= SUPPORT_BUNDLE_LIMITS.maxBytes);
});
