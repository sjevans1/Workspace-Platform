import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentInstruction,
  createBridge,
  createSpool,
  executableRunner,
  runOne,
} from "../src/bridge.mjs";

function event(id = "delivery-1", conclusion = "failure") {
  return {
    version: 1,
    source: "github",
    kind: "ci.workflow.completed",
    delivery_id: id,
    repository: "sjevans1/Workspace-Platform",
    workflow: {
      run_id: 123,
      head_sha: "a".repeat(40),
      conclusion,
    },
  };
}

async function tempSpool(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "workspace-ci-bridge-"));
  return { root, spool: createSpool(root, options) };
}

test("bridge spool deduplicates delivery ids durably", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await spool.put(event())).accepted, true);
  const second = await spool.put(event());
  assert.equal(second.accepted, false);
  assert.equal(second.duplicate, true);
});

test("bridge spool atomically admits one concurrent delivery claim", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.all(
    Array.from({ length: 20 }, () => spool.put(event("concurrent-delivery"))),
  );
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 19);
});

test("successful runner moves event from pending to done", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(event("done-event", "success"));
  const seen = [];
  assert.equal(await runOne(spool, async (value) => seen.push(value)), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].delivery_id, "done-event");
  assert.equal(await runOne(spool, async () => {}), false);
  const doneFiles = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(root, "done")),
  );
  assert.equal(doneFiles.length, 1);
});

test("failed runner returns event to pending for a later attempt", async (t) => {
  const { root, spool } = await tempSpool({ retryBaseMs: 0 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(event("retry-event"));
  await assert.rejects(
    runOne(spool, async () => {
      throw new Error("agent unavailable");
    }),
    /agent unavailable/,
  );
  let calls = 0;
  await runOne(spool, async () => calls++);
  assert.equal(calls, 1);
});

test("backed-off failure does not starve a later event", async (t) => {
  const { root, spool } = await tempSpool({ retryBaseMs: 60_000 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(event("poison-event"));
  await assert.rejects(runOne(spool, async () => {
    throw new Error("persistent failure");
  }));
  await spool.put(event("healthy-after-poison"));
  let processed;
  assert.equal(await runOne(spool, async (value) => { processed = value; }), true);
  assert.equal(processed.delivery_id, "healthy-after-poison");
});

test("repeated failure moves an event to local quarantine", async (t) => {
  const { root, spool } = await tempSpool({ retryBaseMs: 0, maxAttempts: 2 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(event("quarantined-event"));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runOne(spool, async () => {
      throw new Error("persistent failure");
    }));
  }
  const failed = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(root, "failed")),
  );
  assert.equal(failed.length, 1);
  assert.equal(await runOne(spool, async () => {}), false);
});

test("startup recovery returns orphaned running events to pending", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(event("orphaned-event"));
  assert.equal((await spool.claimNext()).event.delivery_id, "orphaned-event");

  const restarted = createSpool(root);
  await restarted.recover();
  let recovered;
  await runOne(restarted, async (value) => { recovered = value; });
  assert.equal(recovered.delivery_id, "orphaned-event");
});

test("runner tolerates a successful child closing stdin early", async () => {
  await executableRunner("/usr/bin/true")(event("early-close-event"));
});

test("agent instruction keeps failure work narrow and exact-head aware", () => {
  const instruction = buildAgentInstruction(event("focused-event", "failure"));
  assert.match(instruction, /exact head/);
  assert.match(instruction, /failed jobs first/);
  assert.match(instruction, /smallest safe correction/);
  assert.match(instruction, /Do not weaken tests/);
  assert.match(instruction, /standalone/);
  assert.match(instruction, /After a push, stop/);
});

test("agent instruction gates merges behind explicit authorization, for any conclusion", () => {
  for (const conclusion of ["success", "failure"]) {
    const instruction = buildAgentInstruction(event(`${conclusion}-merge-gate`, conclusion));
    assert.match(instruction, /Never merge a pull request merely because CI is green/);
    assert.match(instruction, /explicitly authorized that specific pull request/);
    assert.match(instruction, /pre-authorized a defined roadmap acceptance boundary/);
    assert.match(instruction, /exact head is still current/);
    assert.match(instruction, /do not reinterpret that as authorization to merge/);
    assert.match(instruction, /requires user approval/);
    assert.match(instruction, /remains autonomous/);
  }
});

test("agent instruction still permits autonomous branch work and recovery", () => {
  const instruction = buildAgentInstruction(event("autonomy-scope"));
  assert.match(instruction, /create and update branches, open pull requests/);
  assert.match(instruction, /make bounded corrections/);
  assert.match(instruction, /inside an already-authorized work package/);
  assert.match(instruction, /restarting the supervised bridge/);
  assert.match(instruction, /superseding stale CI events/);
});

test("HTTP bridge authenticates, validates and durably accepts events", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createBridge({ token: "bridge-secret", spool });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(base + "/events", {
    method: "POST",
    body: JSON.stringify(event()),
  });
  assert.equal(unauthorized.status, 401);

  const accepted = await fetch(base + "/events", {
    method: "POST",
    headers: {
      authorization: "Bearer bridge-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(event()),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).queued, true);

  const duplicate = await fetch(base + "/events", {
    method: "POST",
    headers: {
      authorization: "Bearer bridge-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(event()),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const queuedFiles = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(root, "pending")),
  );
  assert.equal(queuedFiles.length, 1);
  const queued = JSON.parse(
    await readFile(join(root, "pending", queuedFiles[0]), "utf8"),
  );
  assert.equal(queued.delivery_id, "delivery-1");
});

function eventAt(id, receivedAt, branch = "main") {
  const value = event(id);
  value.received_at = receivedAt;
  value.workflow.head_branch = branch;
  value.workflow.name = "Workspace verification";
  return value;
}

test("claiming prefers the newest pending completion, not the oldest", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(eventAt("oldest", "2026-10-06T01:00:00.000Z", "branch-a"));
  await spool.put(eventAt("middle", "2026-10-06T02:00:00.000Z", "branch-b"));
  await spool.put(eventAt("newest", "2026-10-06T03:00:00.000Z", "branch-c"));
  const job = await spool.claimNext();
  assert.equal(job.event.delivery_id, "newest");
});

test("supersede collapses stale completions for the same branch", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  await spool.put(eventAt("stale-old", "2026-10-06T01:00:00.000Z"));
  await spool.put(eventAt("stale-mid", "2026-10-06T02:00:00.000Z"));
  await spool.put(eventAt("current", "2026-10-06T03:00:00.000Z"));
  await spool.put(eventAt("other-branch", "2026-10-06T03:30:00.000Z", "branch-z"));

  assert.equal(await spool.supersede(), 2);

  const listed = (dir) =>
    import("node:fs/promises").then((fs) => fs.readdir(join(root, dir)));
  assert.equal((await listed("superseded")).length, 2);
  assert.equal((await listed("pending")).length, 2);

  // The newest event for the shared branch and the other branch remain eligible.
  const first = await spool.claimNext();
  assert.equal(first.event.delivery_id, "other-branch");
  const second = await spool.claimNext();
  assert.equal(second.event.delivery_id, "current");
  assert.equal(await spool.claimNext(), null);
});
