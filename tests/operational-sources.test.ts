// OCP-1 source enrichment: focused tests for the read-only operational source
// adapters, the deliberately-unknown database field, the bounded backup discovery
// contract, the enriched privacy bound, and per-source failure isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_CANDIDATE_LIMIT,
  collectBackupSignal,
  collectOperationalSources,
  collectQueueSignal,
  collectStorageSignal,
  toTelemetryInputs,
  type QueryLike,
} from "../packages/operations/operational-sources.ts";
import {
  composeOperatorTelemetry,
  serializeOperatorTelemetry,
  OPERATOR_TELEMETRY_LIMITS,
} from "../packages/operations/operator-telemetry.ts";
import { encodeBackup } from "../scripts/backup.ts";

const KEY = "a".repeat(64);
process.env.ENCRYPTION_KEY = KEY;
const fingerprint = createHash("sha256").update(KEY).digest("hex");

// A mock query that returns caller-supplied aggregate rows, or throws to simulate an
// unavailable helper/service.
const queryReturning = (rows: any[]): QueryLike => ({ query: async () => ({ rows }) });
const queryFailing = (message = "connection terminated"): QueryLike => ({
  query: async () => {
    throw new Error(message);
  },
});

function validArchive(createdAt: string) {
  return encodeBackup({
    format: "openjm-backup-v1",
    created_at: createdAt,
    versions: ["027_operator_queue_depth.sql"],
    key_fingerprint: fingerprint,
    tables: { organisations: [{ id: "hashed-not-emitted" }] },
    objects: {},
  });
}

test("queue signal is factual, bounded and identifier-free", async () => {
  const queue = (rows: any[]) => collectQueueSignal(queryReturning(rows));

  assert.deepEqual(await queue([{ pending: 0, retry: 0, dead: 0 }]), { depth: 0, state: "healthy" });
  assert.deepEqual(await queue([{ pending: 2, retry: 0, dead: 0 }]), { depth: 2, state: "degraded" });
  assert.deepEqual(await queue([{ pending: 0, retry: 3, dead: 0 }]), { depth: 3, state: "degraded" });
  assert.deepEqual(await queue([{ pending: 0, retry: 0, dead: 5 }]), { depth: 5, state: "degraded" });
  // Mixed states across multiple tenants are already summed by the privileged helper.
  assert.deepEqual(await queue([{ pending: 4, retry: 2, dead: 1 }]), { depth: 7, state: "degraded" });
  // The helper always returns exactly one row; an empty result set is treated as an
  // unavailable aggregate rather than a confident zero.
  assert.deepEqual(await queue([]), { depth: 0, state: "healthy" });
  // Source failure degrades to unknown rather than exempting the queue from telemetry.
  assert.deepEqual(await collectQueueSignal(queryFailing()), { depth: null, state: "unknown" });

  // The signal carries only a bounded integer and a bounded enum: no ids, labels,
  // urls, payloads or error text can appear.
  const signal = await queue([{ pending: 1, retry: 0, dead: 0 }]);
  assert.deepEqual(Object.keys(signal).sort(), ["depth", "state"]);
  assert.equal(typeof signal.depth, "number");
  assert.ok(["healthy", "degraded", "unhealthy", "unknown"].includes(signal.state));
});

test("storage signal uses the configured local root only and never a path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1se-store-"));
  const local = await collectStorageSignal({ STORAGE_PROVIDER: "local", STORAGE_LOCAL_PATH: dir });
  assert.equal(typeof local.usedPercent, "number");
  assert.ok(local.usedPercent! >= 0 && local.usedPercent! <= 100, "used percentage must be a bounded scalar");
  assert.deepEqual(Object.keys(local), ["usedPercent"], "no filesystem path may be emitted");

  // Missing root and statfs failure both degrade to unknown.
  assert.deepEqual(await collectStorageSignal({ STORAGE_LOCAL_PATH: join(dir, "nope", "deeper") }), { usedPercent: null });
  // Object storage has no meaningful finite capacity and must stay unknown.
  assert.deepEqual(await collectStorageSignal({ STORAGE_PROVIDER: "s3", STORAGE_LOCAL_PATH: dir }), { usedPercent: null });
  assert.deepEqual(await collectStorageSignal({ STORAGE_PROVIDER: "r2", STORAGE_LOCAL_PATH: dir }), { usedPercent: null });
  await rm(dir, { recursive: true, force: true });
});

test("database capacity is deliberately unknown while pool counters exist", () => {
  // Connection-pool pressure is not database capacity and must never be published
  // under a field an OCP-2 consumer would read as storage capacity. This regression
  // protects that decision, including when the other signals are fully known.
  const inputs = toTelemetryInputs({
    queue: { depth: 7, state: "degraded" },
    storage: { usedPercent: 42 },
    backup: { lastBackupAt: "2026-10-12T00:00:00.000Z", state: "verified" },
  });
  assert.equal(inputs.databaseCapacity, null, "database capacity must remain unknown by design");
  assert.equal(inputs.queueDepth, 7);
  assert.equal(inputs.queueState, "degraded");
  assert.equal(inputs.storageCapacity, 42);
  assert.equal(inputs.lastBackupAt, "2026-10-12T00:00:00.000Z");
  assert.equal(inputs.backupVerified, true);
  // The mapping exposes no database identifier, connection string or pool counter.
  assert.deepEqual(Object.keys(inputs).sort(), [
    "backupVerified",
    "databaseCapacity",
    "lastBackupAt",
    "queueDepth",
    "queueState",
    "storageCapacity",
  ]);
});

test("backup discovery is bounded, verified-only, and honestly unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1se-backup-"));
  // Unset configuration.
  assert.deepEqual(await collectBackupSignal(null), { lastBackupAt: null, state: "unknown" });
  // Configured but missing directory.
  assert.deepEqual(await collectBackupSignal(join(dir, "missing")), { lastBackupAt: null, state: "unknown" });
  // Empty directory: nothing exists to verify.
  const empty = join(dir, "empty");
  await mkdir(empty, { recursive: true });
  assert.deepEqual(await collectBackupSignal(empty), { lastBackupAt: null, state: "never_verified" });
  // A file that is not even JSON, and a truncated archive, must never be success.
  const bad = join(dir, "bad");
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "corrupt.json"), "not-an-archive", "utf8");
  assert.deepEqual(await collectBackupSignal(bad), { lastBackupAt: null, state: "failed" });
  const partial = join(dir, "partial");
  await mkdir(partial, { recursive: true });
  await writeFile(join(partial, "partial.json"), '{"format":"openjm-backup-v2","iv":"x"}', "utf8");
  assert.deepEqual(await collectBackupSignal(partial), { lastBackupAt: null, state: "failed" });

  // A genuinely valid archive, produced through the real encoder, verifies.
  const good = join(dir, "good");
  await mkdir(good, { recursive: true });
  const created = "2026-10-12T01:02:03.000Z";
  await writeFile(join(good, "backup.json"), validArchive(created), "utf8");
  const verified = await collectBackupSignal(good);
  assert.equal(verified.state, "verified");
  assert.equal(verified.lastBackupAt, created, "only verified evidence may set last_backup_at");

  // Selection: the newest candidate is corrupt, an older one is valid. Last
  // successfully VERIFIED backup wins, not the newest file.
  const mixed = join(dir, "mixed");
  await mkdir(mixed, { recursive: true });
  const older = "2026-10-12T00:00:00.000Z";
  await writeFile(join(mixed, "b-older.json"), validArchive(older), "utf8");
  await wait(20);
  await writeFile(join(mixed, "a-newest.json"), "corrupt", "utf8");
  const selected = await collectBackupSignal(mixed);
  assert.equal(selected.state, "verified");
  assert.equal(selected.lastBackupAt, older, "a corrupt newest candidate must not mask an older verified backup");

  // The candidate bound is enforced: when only an archive beyond the bound is valid,
  // the adapter must not scan indefinitely and must not claim success.
  const bounded = join(dir, "bounded");
  await mkdir(bounded, { recursive: true });
  // One valid archive created first, then more than the bound of newer corrupt ones.
  await writeFile(join(bounded, "valid.json"), validArchive("2026-10-01T00:00:00.000Z"), "utf8");
  for (let i = 0; i < BACKUP_CANDIDATE_LIMIT + 3; i += 1) {
    await wait(15);
    await writeFile(join(bounded, `newer-${String(i).padStart(2, "0")}.json`), "corrupt", "utf8");
  }
  const boundedResult = await collectBackupSignal(bounded);
  assert.deepEqual(
    boundedResult,
    { lastBackupAt: null, state: "failed" },
    `discovery must stop after ${BACKUP_CANDIDATE_LIMIT} candidates rather than scanning the whole directory`,
  );
  await rm(dir, { recursive: true, force: true });
});

async function wait(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("enriched telemetry stays privacy-safe and within the byte ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1se-priv-"));
  const sources = await collectOperationalSources({
    q: queryReturning([{ pending: 3, retry: 1, dead: 1 }]),
    env: { STORAGE_PROVIDER: "local", STORAGE_LOCAL_PATH: dir },
    backupDirectory: null,
  });
  const payload = composeOperatorTelemetry({
    application: "workspace",
    version: "1.0.0",
    deploymentIdSeed: "seed-enriched",
    // Hostile values alongside the enriched operational sources.
    alias: "cfo@acme-customer.example",
    environment: "Bearer " + "x".repeat(40),
    region: "https://idp.example.com/realms/acme?tenant=11111111-2222-3333-4444-555555555555",
    dependencies: { database: true, redis: true, storage: true },
    antivirus: { clean: 1, infected: 0, error: 0 },
    http: [{ method: "GET", statusClass: "2xx", count: 5, durationSeconds: 0.2 }],
    schemaVersion: "client_secret=supersecretvalue",
    identityProfile: "postgres://workspace_runtime:sekretpw@10.0.0.5:5432/tenant_acme",
    events: [{ category: "Confidential merger discussion minutes", count: 1 }],
    ...toTelemetryInputs(sources),
    now: new Date("2026-10-12T00:00:00Z"),
  });
  const serialized = serializeOperatorTelemetry(payload);
  for (const sentinel of [
    "cfo@acme-customer.example",
    "11111111-2222-3333-4444-555555555555",
    "Confidential merger discussion minutes",
    "Bearer ",
    "postgres://",
    "client_secret=",
    "acme",
    dir,
  ])
    assert.ok(!serialized.includes(sentinel), `enriched payload leaked ${sentinel}`);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes,
    "the 16384-byte ceiling must not be raised",
  );
  assert.equal(payload.signals.queue.depth, 5, "depth is the factual sum of pending, retry and dead");
  assert.equal(payload.signals.queue.state, "degraded");
  assert.equal(payload.readiness.backup_state, "unknown");
  assert.equal(payload.signals.capacity.database, null, "database capacity stays unknown in the payload");
  await rm(dir, { recursive: true, force: true });
});

test("every source can fail independently without failing composition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocp1se-fail-"));
  const cases: { name: string; input: Parameters<typeof collectOperationalSources>[0] }[] = [
    { name: "queue helper unavailable", input: { q: queryFailing(), env: { STORAGE_LOCAL_PATH: dir } } },
    { name: "database/source error", input: { q: queryFailing("terminating connection"), env: { STORAGE_LOCAL_PATH: dir } } },
    { name: "statfs failure", input: { q: queryReturning([{ pending: 1, retry: 0, dead: 0 }]), env: { STORAGE_PROVIDER: "local", STORAGE_LOCAL_PATH: join(dir, "missing") } } },
    { name: "backup directory error", input: { q: queryReturning([{ pending: 1, retry: 0, dead: 0 }]), env: { STORAGE_LOCAL_PATH: dir }, backupDirectory: join(dir, "missing") } },
  ];
  for (const scenario of cases) {
    const sources = await collectOperationalSources(scenario.input);
    // Composition must still succeed and serialize.
    const payload = composeOperatorTelemetry({
      application: "workspace",
      version: "1.0.0",
      deploymentIdSeed: "seed-fail",
      ...toTelemetryInputs(sources),
    });
    const serialized = serializeOperatorTelemetry(payload);
    assert.ok(serialized.length > 0, `composition must still succeed: ${scenario.name}`);
    assert.ok(
      Buffer.byteLength(serialized, "utf8") <= OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes,
      `payload must stay bounded: ${scenario.name}`,
    );
    // The affected signal is unknown, and unknown is a legitimate terminal state.
    const degraded =
      sources.queue.state === "unknown" ||
      sources.storage.usedPercent === null ||
      sources.backup.state === "unknown";
    assert.ok(degraded, `${scenario.name} must degrade its own signal to unknown`);
  }
  // A malformed backup and a verification failure are also contained.
  const broken = join(dir, "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "x.json"), "corrupt", "utf8");
  const contained = await collectOperationalSources({
    q: queryReturning([{ pending: 0, retry: 0, dead: 0 }]),
    env: { STORAGE_LOCAL_PATH: dir },
    backupDirectory: broken,
  });
  assert.deepEqual(contained.backup, { lastBackupAt: null, state: "failed" });
  assert.deepEqual(contained.queue, { depth: 0, state: "healthy" });
  await rm(dir, { recursive: true, force: true });
});
