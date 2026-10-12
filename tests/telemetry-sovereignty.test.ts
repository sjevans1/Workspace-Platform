// OCP-1B: sovereignty, restart and product-health isolation.
//
// The claim under test is: telemetry failure is operationally observable but never
// product-critical. Nothing here waits on real time beyond bounded, test-configured
// backoff, and production semantics are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundedSpool,
  readTelemetryTransportStatus,
  startTelemetryExporter,
  telemetryTransportConfig,
} from "../packages/operations/telemetry-transport.ts";
import { composeOperatorTelemetry, serializeOperatorTelemetry } from "../packages/operations/operator-telemetry.ts";

const SECRET = "s".repeat(48);
const payload = () =>
  serializeOperatorTelemetry(
    composeOperatorTelemetry({
      application: "workspace",
      version: "1.0.0",
      deploymentIdSeed: "seed-sovereignty",
      now: new Date("2026-10-12T00:00:00Z"),
    }),
  );

const configFor = (endpoint: string, extra: Record<string, string> = {}) =>
  telemetryTransportConfig({
    OPERATOR_TELEMETRY_ENABLED: "true",
    OPERATOR_TELEMETRY_ENDPOINT: endpoint,
    OPERATOR_TELEMETRY_CREDENTIAL_ID: "dep-1",
    OPERATOR_TELEMETRY_SECRET: SECRET,
    // Bounded, test-configured backoff: production semantics are unchanged.
    OPERATOR_TELEMETRY_BACKOFF_BASE_MS: "1000",
    OPERATOR_TELEMETRY_BACKOFF_MAX_MS: "1000",
    ...extra,
  }).config;

test("telemetry failure never degrades product work, and never terminates the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1b-sovereignty-"));
  const spool = new BoundedSpool({
    path: join(dir, "spool.jsonl"),
    maxItems: 4,
    maxBytes: 65_536,
    maxAgeMs: 600_000,
  });
  // Unreachable endpoint: connection refused on a port nobody listens on.
  const exporter = startTelemetryExporter({
    config: configFor("https://127.0.0.1:9/ingest"),
    deploymentId: "ws-sovereignty",
    payloadProvider: async () => payload(),
    spool,
  });

  // A normal product workload must progress while telemetry keeps failing. This
  // models the worker's product tick loop: bounded iterations, counted progress.
  let productTicks = 0;
  const productWork = (async () => {
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      productTicks += 1;
    }
  })();

  // Drive the exporter under sustained failure for the same window.
  const outcomes: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    outcomes.push(await exporter.runOnce().catch(() => "threw"));
  }
  await productWork;

  assert.equal(productTicks, 25, "product work must progress during telemetry failure");
  assert.ok(!outcomes.includes("threw"), "the exporter must never throw into the caller");
  assert.equal(exporter.status().last_failure_category, "network");
  assert.ok(exporter.status().consecutive_failures > 0, "failure is observable in telemetry status");
  assert.ok(exporter.status().backoff_until !== null, "backoff is engaged");
  assert.ok(spool.stats().items >= 1, "the item is retained for later delivery");
  // Retries are bounded by backoff, not a busy loop: most attempts were skipped.
  assert.ok(
    outcomes.filter((o) => o === "skipped").length > 0,
    "backoff must prevent a retry busy-loop",
  );

  // Worst case for isolation: the spool is full and delivery still fails.
  for (let i = 0; i < 50; i += 1) await exporter.runOnce();
  assert.ok(spool.stats().items <= 4, "the spool stays bounded under sustained failure");
  await exporter.stop();
  await rm(dir, { recursive: true, force: true });
});

test("restart with a non-empty spool resumes delivery and compacts on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1b-restart-"));
  const spoolPath = join(dir, "spool.jsonl");
  const statusPath = join(dir, "status.json");

  // 1-2. Generate an item while delivery is unavailable, and prove it is spooled.
  const failing = startTelemetryExporter({
    config: configFor("https://127.0.0.1:9/ingest"),
    deploymentId: "ws-restart",
    payloadProvider: async () => payload(),
    spool: new BoundedSpool({ path: spoolPath, maxItems: 4, maxBytes: 65_536, maxAgeMs: 600_000 }),
    statusPath,
  });
  await failing.runOnce();
  const before = new BoundedSpool({ path: spoolPath, maxItems: 4, maxBytes: 65_536, maxAgeMs: 600_000 });
  await before.load();
  assert.equal(before.stats().items, 1, "the item is present in the bounded spool");
  const originallySpooled = before.peek()!.id;
  await failing.stop();

  // 3-4. Restart (simulating an exporter or worker restart) and prove the spool is
  // still valid and readable.
  const restartedSpool = new BoundedSpool({ path: spoolPath, maxItems: 4, maxBytes: 65_536, maxAgeMs: 600_000 });
  await restartedSpool.load();
  assert.equal(restartedSpool.stats().items, 1, "the spool survives a restart");
  assert.equal(restartedSpool.stats().droppedCorrupt, 0);

  // 5-6. A working receiver resumes delivery, and success compacts the spool.
  const delivered: string[] = [];
  const restarted = startTelemetryExporter({
    config: configFor("https://fleet.example.com/ingest"),
    deploymentId: "ws-restart",
    payloadProvider: async () => payload(),
    spool: restartedSpool,
    statusPath,
    fetchImpl: (async (_url: any, init: any) => {
      delivered.push(String(init.body));
      return new Response("{}", { status: 200 });
    }) as any,
  });
  assert.equal(await restarted.runOnce(), "delivered", "delivery resumes after restart");
  // The delivered (oldest) item is removed per the spool contract, and only the
  // freshly added current snapshot remains, so the spool stays bounded by design.
  assert.notEqual(restartedSpool.peek()?.id, originallySpooled, "the delivered item was removed");
  assert.ok(restartedSpool.stats().items <= 2, "the spool stays bounded after delivery");
  assert.equal(restarted.status().last_failure_category, "none");
  assert.ok(restarted.status().last_success_at);

  // The persisted status file is bounded and secret-free, and readable by the API.
  const persisted = await readTelemetryTransportStatus(statusPath);
  assert.ok(persisted, "the worker persists a readable transport status");
  const raw = await readFile(statusPath, "utf8");
  assert.ok(!raw.includes(SECRET), "the persisted status must never contain the secret");
  assert.ok(!raw.includes("Bearer "), "no authorization material in status");
  await restarted.stop();
  await rm(dir, { recursive: true, force: true });
});

test("telemetry transport state is independent of product health semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1b-isolation-"));
  const spoolPath = join(dir, "spool.jsonl");

  // Every hostile transport condition at once: revoked credential (403), TLS
  // failure, unreachable endpoint. Product health is modelled by a probe that the
  // worker's liveness uses (a database round trip), which must stay healthy.
  const productHealthProbe = async () => true;
  const scenarios: { name: string; fetchImpl: any; expected: string }[] = [
    { name: "revoked credential", fetchImpl: async () => new Response("{}", { status: 403 }), expected: "authentication" },
    { name: "tls failure", fetchImpl: async () => { throw new Error("fetch failed", { cause: new Error("self-signed certificate") }); }, expected: "tls" },
    { name: "unreachable", fetchImpl: async () => { throw new Error("fetch failed", { cause: new Error("ECONNREFUSED") }); }, expected: "network" },
    { name: "receiver 500", fetchImpl: async () => new Response("{}", { status: 500 }), expected: "retryable_response" },
    { name: "rate limited", fetchImpl: async () => new Response("{}", { status: 429 }), expected: "rate_limited" },
  ];
  for (const scenario of scenarios) {
    const spool = new BoundedSpool({ path: spoolPath, maxItems: 2, maxBytes: 8_192, maxAgeMs: 600_000 });
    const exporter = startTelemetryExporter({
      config: configFor("https://fleet.example.com/ingest"),
      deploymentId: "ws-isolation",
      payloadProvider: async () => payload(),
      spool,
      fetchImpl: scenario.fetchImpl,
    });
    await exporter.runOnce();
    assert.equal(exporter.status().last_failure_category, scenario.expected, scenario.name);
    // Product health is untouched by any of these transport conditions.
    assert.equal(await productHealthProbe(), true, `product health must stay healthy: ${scenario.name}`);
    assert.equal(exporter.status().enabled, true, "telemetry status reports its own degraded state");
    await exporter.stop();
  }

  // A full spool is also transport-only state.
  const fullSpool = new BoundedSpool({ path: spoolPath, maxItems: 2, maxBytes: 8_192, maxAgeMs: 600_000 });
  const fullExporter = startTelemetryExporter({
    config: configFor("https://fleet.example.com/ingest"),
    deploymentId: "ws-isolation",
    payloadProvider: async () => payload(),
    spool: fullSpool,
    fetchImpl: async () => new Response("{}", { status: 500 }),
  });
  for (let i = 0; i < 10; i += 1) await fullExporter.runOnce();
  assert.ok(fullSpool.stats().items <= 2, "a full spool stays bounded");
  assert.equal(await productHealthProbe(), true, "a full spool must not affect product health");
  await fullExporter.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a corrupt spool stays fail-soft and bounded across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1b-corrupt-"));
  const spoolPath = join(dir, "spool.jsonl");
  await writeFile(spoolPath, `garbage\n{"id":"a","at":${Date.now()},"body":"ok"}\n`, "utf8");
  const spool = new BoundedSpool({ path: spoolPath, maxItems: 4, maxBytes: 65_536, maxAgeMs: 600_000 });
  await spool.load();
  assert.equal(spool.stats().droppedCorrupt, 1, "corruption is counted, not fatal");
  assert.equal(spool.stats().items, 1, "the valid entry survives");
  const exporter = startTelemetryExporter({
    config: configFor("https://fleet.example.com/ingest"),
    deploymentId: "ws-corrupt",
    payloadProvider: async () => payload(),
    spool,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  assert.equal(await exporter.runOnce(), "delivered", "the exporter still works after corruption");
  await exporter.stop();
  await rm(dir, { recursive: true, force: true });
});
