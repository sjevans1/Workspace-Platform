// OCP-1 source enrichment: composition-path equivalence.
//
// Both the API operator telemetry inspection and the worker/exporter telemetry
// generation must consume the same operational-source adapter and the same mapping.
// This regression fails if either path is re-wired to its own logic, or if a second
// collector appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { toTelemetryInputs } from "../packages/operations/operational-sources.ts";

const API = "apps/api/src/app.ts";
const WORKER = "apps/worker/src/main.ts";

test("both composition paths use the shared operational-source adapter", async () => {
  for (const path of [API, WORKER]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /collectOperationalSources\(/, `${path} must use the shared adapter`);
    assert.match(source, /\.\.\.toTelemetryInputs\(sources\)/, `${path} must use the shared mapping`);
    // No path may re-declare its own operational collection.
    assert.ok(
      !/workspace_queue_depth\(/.test(source),
      `${path} must not query the queue helper directly; the adapter owns that`,
    );
  }
});

test("no duplicate source logic exists outside the adapter", async () => {
  const packages = await readdir("packages/operations");
  const offenders: string[] = [];
  for (const name of packages) {
    if (name === "operational-sources.ts") continue;
    const source = await readFile(join("packages/operations", name), "utf8");
    if (/workspace_queue_depth\(|statfs\(|verifyBackup\(/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "operational source logic must live only in operational-sources.ts");
  // And there is exactly one telemetry contract version.
  const ot = await readFile("packages/operations/operator-telemetry.ts", "utf8");
  assert.equal((ot.match(/openjm\.workspace\.operator-telemetry\.v/g) || []).length, 1, "no v2 contract may be introduced");
});

test("identical sources map identically regardless of caller", () => {
  const sources = {
    queue: { depth: 9, state: "degraded" as const },
    storage: { usedPercent: 61 },
    backup: { lastBackupAt: "2026-10-12T02:00:00.000Z", state: "verified" as const },
  };
  const a = toTelemetryInputs(sources);
  const b = toTelemetryInputs({ ...sources, queue: { ...sources.queue } });
  assert.deepEqual(a, b, "the mapping must be pure and caller-independent");
  assert.equal(a.databaseCapacity, null);
  assert.equal(a.backupVerified, true);
});
