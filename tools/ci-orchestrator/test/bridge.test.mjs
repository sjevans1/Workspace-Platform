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

async function tempSpool() {
  const root = await mkdtemp(join(tmpdir(), "workspace-ci-bridge-"));
  return { root, spool: createSpool(root) };
}

test("bridge spool deduplicates delivery ids durably", async (t) => {
  const { root, spool } = await tempSpool();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await spool.put(event())).accepted, true);
  const second = await spool.put(event());
  assert.equal(second.accepted, false);
  assert.equal(second.duplicate, true);
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
  const { root, spool } = await tempSpool();
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
