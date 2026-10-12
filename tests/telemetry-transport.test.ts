// OCP-1B: transport envelope, replay protection, bounded spool, retry
// classification, failure isolation and privacy over the actual outbound bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundedSpool,
  TELEMETRY_ENVELOPE_VERSION,
  TestTelemetryReceiver,
  backoffDelay,
  buildEnvelope,
  classifyFailure,
  classifyResponse,
  payloadDigest,
  signingInput,
  startTelemetryExporter,
  telemetryTransportConfig,
  verifyEnvelopeSignature,
} from "../packages/operations/telemetry-transport.ts";
import {
  composeOperatorTelemetry,
  serializeOperatorTelemetry,
} from "../packages/operations/operator-telemetry.ts";

const SECRET = "s".repeat(48);
const OTHER_SECRET = "t".repeat(48);
const GHOST = "ghost-secret-value-012345678901234567890123";

const hostilePayload = () =>
  serializeOperatorTelemetry(
    composeOperatorTelemetry({
      application: "workspace",
      version: "1.0.0",
      buildSha: "abc1234",
      deploymentIdSeed: "seed-1",
      alias: "cfo@acme-customer.example",
      environment: `Bearer ${"x".repeat(40)}`,
      region: "https://idp.example.com/realms/acme?tenant=11111111-2222-3333-4444-555555555555",
      services: { worker: { configured: true, healthy: true, values: { claims: 1 } } },
      http: [{ method: "GET", statusClass: "2xx", count: 3, durationSeconds: 0.1 }],
      antivirus: { clean: 1, infected: 0, error: 0 },
      schemaVersion: "client_secret=supersecretvalue",
      identityProfile: "postgres://workspace_runtime:sekretpw@10.0.0.5:5432/tenant_acme",
      events: [{ category: "Confidential merger discussion minutes", count: 1 }],
      now: new Date("2026-10-12T00:00:00Z"),
    }),
  );

test("transport configuration fails closed", () => {
  const disabled = telemetryTransportConfig({});
  assert.equal(disabled.config.enabled, false);
  assert.equal(disabled.config.endpoint, null);
  assert.equal(disabled.ok, true, "a disabled deployment needs no endpoint or credential");

  assert.ok(telemetryTransportConfig({ OPERATOR_TELEMETRY_ENABLED: "true" }).issues.length > 0);
  assert.ok(
    telemetryTransportConfig({
      OPERATOR_TELEMETRY_ENABLED: "true",
      OPERATOR_TELEMETRY_ENDPOINT: "http://fleet.example.com/ingest",
      OPERATOR_TELEMETRY_CREDENTIAL_ID: "dep-1",
      OPERATOR_TELEMETRY_SECRET: SECRET,
    }).issues.some((i) => i.problem.includes("https")),
    "insecure HTTP must be rejected",
  );
  for (const bad of [
    "https://user:pw@fleet.example.com/ingest",
    "https://fleet.example.com/ingest?token=abc",
    "https://fleet.example.com/ingest#frag",
  ])
    assert.ok(
      telemetryTransportConfig({
        OPERATOR_TELEMETRY_ENABLED: "true",
        OPERATOR_TELEMETRY_ENDPOINT: bad,
        OPERATOR_TELEMETRY_CREDENTIAL_ID: "dep-1",
        OPERATOR_TELEMETRY_SECRET: SECRET,
      }).issues.length > 0,
      `must reject ${bad}`,
    );
  assert.ok(
    telemetryTransportConfig({
      OPERATOR_TELEMETRY_ENABLED: "true",
      OPERATOR_TELEMETRY_ENDPOINT: "https://fleet.example.com/ingest",
      OPERATOR_TELEMETRY_CREDENTIAL_ID: "dep-1",
      OPERATOR_TELEMETRY_SECRET: "short",
    }).issues.some((i) => i.setting === "OPERATOR_TELEMETRY_SECRET"),
  );
  const good = telemetryTransportConfig({
    OPERATOR_TELEMETRY_ENABLED: "true",
    OPERATOR_TELEMETRY_ENDPOINT: "https://fleet.example.com/ingest",
    OPERATOR_TELEMETRY_CREDENTIAL_ID: "dep-1",
    OPERATOR_TELEMETRY_SECRET: SECRET,
  });
  assert.equal(good.ok, true);
  assert.equal(good.config.endpointOrigin, "https://fleet.example.com");
  assert.ok(good.config.backoffMaxMs >= good.config.backoffBaseMs);
});

test("the signing input is deterministic and every mutation invalidates it", () => {
  const envelope = buildEnvelope({
    deploymentId: "ws-abc",
    credentialId: "dep-1",
    secret: SECRET,
    payload: hostilePayload(),
    now: new Date("2026-10-12T00:00:00Z"),
    nonce: "nonce-1",
  });
  assert.equal(envelope.envelope, TELEMETRY_ENVELOPE_VERSION);
  assert.equal(envelope.payload_digest, payloadDigest(envelope.payload));
  assert.ok(verifyEnvelopeSignature(envelope, SECRET));
  assert.equal(verifyEnvelopeSignature(envelope, OTHER_SECRET), false, "another deployment's secret must not verify");
  const again = buildEnvelope({
    deploymentId: "ws-abc",
    credentialId: "dep-1",
    secret: SECRET,
    payload: envelope.payload,
    now: new Date("2026-10-12T00:00:00Z"),
    nonce: "nonce-1",
  });
  assert.equal(signingInput(again), signingInput(envelope), "signing input must be deterministic");

  const mutations: [string, (e: any) => void][] = [
    ["timestamp", (e) => (e.generated_at = "2026-10-12T00:00:01Z")],
    ["nonce", (e) => (e.nonce = "nonce-2")],
    ["deployment id", (e) => (e.deployment_id = "ws-other")],
    ["credential id", (e) => (e.credential_id = "dep-2")],
    ["payload", (e) => (e.payload = e.payload.replace('"sequence":0', '"sequence":9'))],
    ["payload digest", (e) => (e.payload_digest = "0".repeat(64))],
    ["envelope version", (e) => (e.envelope = "openjm.workspace.telemetry-envelope.v2")],
  ];
  for (const [label, mutate] of mutations) {
    const copy = JSON.parse(JSON.stringify(envelope));
    mutate(copy);
    assert.equal(verifyEnvelopeSignature(copy, SECRET), false, `changed ${label} must invalidate the signature`);
    assert.equal(new TestTelemetryReceiver({ secrets: { "dep-1": SECRET } }).handle(JSON.stringify(copy)).status >= 400, true);
  }
});

test("the receiver contract accepts valid envelopes and rejects every hostile case", () => {
  const now = () => Date.parse("2026-10-12T00:00:30Z");
  const receiver = new TestTelemetryReceiver({
    secrets: { "dep-1": SECRET, "dep-2": OTHER_SECRET },
    revoked: ["dep-2"],
    skewMs: 60_000,
    maxTracked: 3,
    now,
  });
  const make = (nonce: string, over: any = {}) =>
    buildEnvelope({
      deploymentId: "ws-abc",
      credentialId: "dep-1",
      secret: SECRET,
      payload: hostilePayload(),
      now: new Date("2026-10-12T00:00:00Z"),
      nonce,
      ...over,
    });

  const ok = make("n1");
  assert.deepEqual(receiver.handle(JSON.stringify(ok)), { status: 200, code: "accepted" });
  assert.equal(receiver.handle(JSON.stringify(ok)).code, "replayed", "same envelope must not be accepted twice");
  const ok2 = make("n2");
  assert.equal(receiver.handle(JSON.stringify(ok2)).code, "accepted");
  assert.equal(receiver.handle(JSON.stringify(make("n2"))).code, "replayed", "same nonce must be rejected");
  assert.equal(receiver.handle("not-json").code, "malformed");
  assert.equal(receiver.handle(JSON.stringify({ ...ok2, envelope: "x" })).code, "unsupported_version");
  assert.equal(
    receiver.handle(JSON.stringify(buildEnvelope({ deploymentId: "ws-abc", credentialId: "nobody", secret: SECRET, payload: ok2.payload, now: new Date("2026-10-12T00:00:00Z"), nonce: "n3" }))).code,
    "unknown_credential",
  );
  const revoked = buildEnvelope({ deploymentId: "ws-abc", credentialId: "dep-2", secret: OTHER_SECRET, payload: ok2.payload, now: new Date("2026-10-12T00:00:00Z"), nonce: "n4" });
  assert.equal(receiver.handle(JSON.stringify(revoked)).code, "revoked_credential");
  const stale = buildEnvelope({ deploymentId: "ws-abc", credentialId: "dep-1", secret: SECRET, payload: ok2.payload, now: new Date("2026-10-11T20:00:00Z"), nonce: "n5" });
  assert.equal(receiver.handle(JSON.stringify(stale)).code, "timestamp_out_of_window");
  const future = buildEnvelope({ deploymentId: "ws-abc", credentialId: "dep-1", secret: SECRET, payload: ok2.payload, now: new Date("2026-10-12T06:00:00Z"), nonce: "n6" });
  assert.equal(receiver.handle(JSON.stringify(future)).code, "timestamp_out_of_window");
  const tampered = { ...make("n7"), payload: make("n7").payload.replace('"sequence":0', '"sequence":1') };
  assert.equal(receiver.handle(JSON.stringify(tampered)).code, "invalid_signature");
  assert.equal(receiver.handle("{\"pad\":\"" + "x".repeat(200_000) + "\"}").code, "payload_too_large");
  // Bounded nonce state: the cache never grows without limit.
  for (let i = 0; i < 10; i += 1)
    receiver.handle(JSON.stringify(buildEnvelope({ deploymentId: "ws-abc", credentialId: "dep-1", secret: SECRET, payload: hostilePayload(), now: new Date("2026-10-12T00:00:00Z"), nonce: `bulk-${i}` })));
  assert.ok(receiver.accepted.length <= 12);
});

test("retry classification and backoff stay bounded", () => {
  assert.equal(classifyResponse(200), "delivered");
  assert.equal(classifyResponse(204), "delivered");
  for (const s of [408, 429, 500, 503]) assert.equal(classifyResponse(s), "retryable", `status ${s}`);
  for (const s of [400, 401, 403, 404, 409, 413, 422]) assert.equal(classifyResponse(s), "permanent", `status ${s}`);
  assert.equal(classifyFailure(undefined, 429), "rate_limited");
  assert.equal(classifyFailure(undefined, 401), "authentication");
  assert.equal(classifyFailure(undefined, 503), "retryable_response");
  assert.equal(classifyFailure(new Error("self-signed certificate in certificate chain")), "tls");
  assert.equal(classifyFailure(new Error("The operation was aborted due to timeout")), "timeout");
  assert.equal(classifyFailure(new Error("fetch failed: ECONNREFUSED")), "network");
  const options = { baseMs: 1_000, maxMs: 60_000, jitter: () => 1 };
  assert.equal(backoffDelay(1, options), 1_000);
  assert.equal(backoffDelay(20, options), 60_000, "backoff must cap at the maximum");
  assert.ok(backoffDelay(3, { baseMs: 1_000, maxMs: 60_000, jitter: () => 0 }) < backoffDelay(3, options));
});

test("the spool is bounded, deterministic, restart-safe and fail-soft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1b-spool-"));
  const path = join(dir, "spool.jsonl");
  let clock = Date.parse("2026-10-12T00:00:00Z");
  const spool = new BoundedSpool({
    path,
    maxItems: 3,
    maxBytes: 4_096,
    maxAgeMs: 60_000,
    now: () => clock,
  });
  await spool.load();
  for (let i = 1; i <= 5; i += 1) await spool.add(`payload-${i}`);
  assert.deepEqual(spool.stats().items, 3, "item count is bounded");
  assert.equal(spool.peek()?.body, "payload-3", "deterministic FIFO eviction keeps the newest state");
  assert.ok(spool.stats().evicted >= 2);

  // Restart safety: a fresh instance sees the persisted bounded set.
  const restarted = new BoundedSpool({ path, maxItems: 3, maxBytes: 4_096, maxAgeMs: 60_000, now: () => clock });
  await restarted.load();
  assert.equal(restarted.peek()?.body, "payload-3");

  // Age expiry.
  clock += 120_000;
  assert.equal(restarted.expire(), 3);

  // Byte ceiling.
  const small = new BoundedSpool({ path: join(dir, "bytes.jsonl"), maxItems: 100, maxBytes: 4_096, maxAgeMs: 60_000, now: () => clock });
  await small.load();
  for (let i = 0; i < 40; i += 1) await small.add("b".repeat(500));
  assert.ok(small.stats().bytes <= 4_096, "byte ceiling is enforced");
  assert.ok(small.stats().items >= 1, "the newest item is never evicted away");

  // Corruption is fail-soft and counted, not fatal.
  const corrupt = join(dir, "corrupt.jsonl");
  await writeFile(
    corrupt,
    `not json\n{"id":"a","at":${Date.now()},"body":"ok"}\n`,
    "utf8",
  );
  const recovered = new BoundedSpool({ path: corrupt, maxItems: 5, maxBytes: 4_096, maxAgeMs: 10_000_000, now: () => clock });
  await recovered.load();
  assert.equal(recovered.stats().items, 1);
  assert.equal(recovered.stats().droppedCorrupt, 1);

  // Unwritable path is fail-soft: the parent is a regular file, so every write
  // fails with ENOTDIR and the call must still return rather than throw or block.
  const notADir = join(dir, "blocker.txt");
  await writeFile(notADir, "x", "utf8");
  const broken = new BoundedSpool({ path: join(notADir, "spool.jsonl"), maxItems: 2, maxBytes: 1_024, maxAgeMs: 60_000, now: () => clock });
  await broken.add("x");
  assert.equal(broken.stats().items, 1);
  await rm(dir, { recursive: true, force: true });
});

test("the exporter delivers, retries and never leaks or throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1b-exporter-"));
  const sent: string[] = [];
  const responder = (status: number) => async (_url: any, init: any) => {
    sent.push(String(init.body));
    return new Response(status === 204 ? null : "{}", { status });
  };
  const config = telemetryTransportConfig({
    OPERATOR_TELEMETRY_ENABLED: "true",
    OPERATOR_TELEMETRY_ENDPOINT: "https://fleet.example.com/ingest",
    OPERATOR_TELEMETRY_CREDENTIAL_ID: "dep-1",
    OPERATOR_TELEMETRY_SECRET: SECRET,
    OPERATOR_TELEMETRY_SPOOL_PATH: join(dir, "spool.jsonl"),
  }).config;

  // Disabled exporter does nothing at all.
  const disabledSpool = new BoundedSpool({ path: join(dir, "disabled.jsonl"), maxItems: 4, maxBytes: 4_096, maxAgeMs: 60_000 });
  const disabled = startTelemetryExporter({
    config: { ...config, enabled: false },
    deploymentId: "ws-abc",
    payloadProvider: async () => hostilePayload(),
    spool: disabledSpool,
    fetchImpl: responder(200) as any,
  });
  assert.equal(await disabled.runOnce(), "skipped");
  assert.equal(sent.length, 0, "a disabled exporter must not send");
  await disabled.stop();

  // Happy path.
  const spool = new BoundedSpool({ path: join(dir, "spool.jsonl"), maxItems: 4, maxBytes: 65_536, maxAgeMs: 60_000 });
  const exporter = startTelemetryExporter({
    config,
    deploymentId: "ws-abc",
    payloadProvider: async () => hostilePayload(),
    spool,
    fetchImpl: responder(200) as any,
  });
  assert.equal(await exporter.runOnce(), "delivered");
  assert.equal(spool.stats().items, 0, "a delivered item is acknowledged");
  assert.equal(exporter.status().last_failure_category, "none");
  assert.ok(exporter.status().last_success_at);

  // Privacy over the ACTUAL outbound body.
  const body = sent[sent.length - 1];
  for (const sentinel of [
    "cfo@acme-customer.example",
    "Bearer ",
    "workspace_session=",
    "postgres://",
    "client_secret=",
    "11111111-2222-3333-4444-555555555555",
    "Confidential merger discussion minutes",
    SECRET,
    GHOST,
  ])
    assert.ok(!body.includes(sentinel), `outbound body leaked ${sentinel}`);
  const parsed = JSON.parse(body);
  assert.equal(parsed.envelope, TELEMETRY_ENVELOPE_VERSION);
  assert.equal(parsed.credential_id, "dep-1");
  assert.ok(!JSON.stringify(exporter.status()).includes(SECRET), "status must never contain the secret");
  assert.equal(parsed.signature, buildEnvelope({ deploymentId: "ws-abc", credentialId: "dep-1", secret: SECRET, payload: parsed.payload, now: new Date(parsed.generated_at), nonce: parsed.nonce }).signature);

  // Retryable: item retained, bounded backoff applied, no throw.
  const spool429 = new BoundedSpool({ path: join(dir, "s429.jsonl"), maxItems: 4, maxBytes: 65_536, maxAgeMs: 60_000 });
  const e429 = startTelemetryExporter({ config, deploymentId: "ws-abc", payloadProvider: async () => hostilePayload(), spool: spool429, fetchImpl: responder(429) as any });
  assert.equal(await e429.runOnce(), "retryable");
  assert.equal(spool429.stats().items, 1, "a retryable failure retains the item");
  assert.equal(e429.status().last_failure_category, "rate_limited");
  assert.ok(e429.status().backoff_until, "backoff must be recorded");
  assert.equal(await e429.runOnce(), "skipped", "backoff prevents a busy loop");

  // Permanent authentication failure: dropped, not retried forever.
  const spool401 = new BoundedSpool({ path: join(dir, "s401.jsonl"), maxItems: 4, maxBytes: 65_536, maxAgeMs: 60_000 });
  const e401 = startTelemetryExporter({ config, deploymentId: "ws-abc", payloadProvider: async () => hostilePayload(), spool: spool401, fetchImpl: responder(401) as any });
  await e401.runOnce();
  assert.equal(spool401.stats().items, 0, "a revoked or invalid credential must not be retried forever");
  assert.equal(e401.status().last_failure_category, "authentication");

  // 5xx, network error and TLS failure are all survivable.
  for (const impl of [
    responder(503),
    async () => { throw new Error("fetch failed: ECONNREFUSED"); },
    async () => { throw new Error("self-signed certificate in certificate chain"); },
    async () => { throw new Error("The operation was aborted due to timeout"); },
  ]) {
    const s = new BoundedSpool({ path: join(dir, `s${sent.length}${Math.random()}.jsonl`), maxItems: 4, maxBytes: 65_536, maxAgeMs: 60_000 });
    const exp = startTelemetryExporter({ config, deploymentId: "ws-abc", payloadProvider: async () => hostilePayload(), spool: s, fetchImpl: impl as any });
    const outcome = await exp.runOnce();
    assert.ok(outcome === "retryable" || outcome === "delivered", `unexpected outcome ${outcome}`);
    assert.ok(["retryable_response", "network", "tls", "timeout"].includes(exp.status().last_failure_category));
    await exp.stop();
  }
  // A payload provider that throws must not propagate.
  const sThrow = new BoundedSpool({ path: join(dir, "sthrow.jsonl"), maxItems: 4, maxBytes: 65_536, maxAgeMs: 60_000 });
  const eThrow = startTelemetryExporter({ config, deploymentId: "ws-abc", payloadProvider: async () => { throw new Error("composition failed"); }, spool: sThrow, fetchImpl: responder(200) as any });
  assert.equal(await eThrow.runOnce(), "skipped");
  await exporter.stop();
  await rm(dir, { recursive: true, force: true });
});
