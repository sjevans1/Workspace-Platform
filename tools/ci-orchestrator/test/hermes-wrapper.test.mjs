import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../../..");
const wrapper = join(repoRoot, "tools/ci-orchestrator/bin/hermes-wrapper.mjs");

async function runWrapper({ envelope, exitCode = 0, repository = repoRoot }) {
  const root = await mkdtemp(join(tmpdir(), "workspace-hermes-wrapper-"));
  const capture = join(root, "capture.json");
  const fakeHermes = join(root, "fake-hermes.mjs");
  await writeFile(fakeHermes, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nlet body = "";\nfor await (const chunk of process.stdin) body += chunk;\nwriteFileSync(process.env.HERMES_FAKE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), body }));\nprocess.exit(Number(process.env.HERMES_FAKE_EXIT || 0));\n`, { mode: 0o700 });
  await chmod(fakeHermes, 0o700);

  const result = await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [wrapper], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMES_BIN: fakeHermes,
        HERMES_FAKE_CAPTURE: capture,
        HERMES_FAKE_EXIT: String(exitCode),
        WORKSPACE_PLATFORM_REPO: repository,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolveResult({ code, signal, stderr }));
    child.stdin.end(envelope);
  });
  const captured = await readFile(capture, "utf8").then(JSON.parse).catch(() => null);
  await rm(root, { recursive: true, force: true });
  return { ...result, captured };
}

test("Hermes wrapper passes one validated envelope without shell interpolation", async () => {
  const marker = "$(touch /tmp/must-not-exist) `uname`";
  const event = {
    version: 1,
    kind: "ci.workflow.completed",
    delivery_id: "wrapper-test",
    repository: "sjevans1/Workspace-Platform",
    workflow: { run_id: 123, head_sha: "a".repeat(40), conclusion: "success" },
  };
  const result = await runWrapper({
    envelope: JSON.stringify({ version: 1, instruction: `Inspect ${marker}`, ci_event: event }) + "\n",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.captured.cwd, repoRoot);
  assert.deepEqual(result.captured.args, [
    "chat", "--query-file", "-", "--oneshot", "-Q", "--source", "tool",
    "--in", repoRoot, "--run-budget", "1800", "--yolo",
  ]);
  assert.match(result.captured.body, /Inspect \$\(touch \/tmp\/must-not-exist\) `uname`/);
  assert.match(result.captured.body, /"delivery_id":"wrapper-test"/);
});

test("Hermes wrapper returns Hermes actual nonzero exit code", async () => {
  const result = await runWrapper({
    exitCode: 7,
    envelope: JSON.stringify({
      version: 1,
      instruction: "Report and exit.",
      ci_event: {
        version: 1,
        kind: "ci.workflow.completed",
        delivery_id: "wrapper-exit-test",
        repository: "sjevans1/Workspace-Platform",
        workflow: { run_id: 1, head_sha: "b".repeat(40), conclusion: "success" },
      },
    }),
  });
  assert.equal(result.code, 7);
});

test("Hermes wrapper rejects trailing or malformed envelope data", async () => {
  const result = await runWrapper({ envelope: "{}\n{}\n" });
  assert.notEqual(result.code, 0);
  assert.equal(result.captured, null);
  assert.match(result.stderr, /valid single JSON envelope/);
});

test("Hermes wrapper rejects deceptive GitHub origin URLs", async (t) => {
  const fakeRepo = await mkdtemp(join(tmpdir(), "workspace-deceptive-origin-"));
  t.after(() => rm(fakeRepo, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", fakeRepo]).status, 0);
  assert.equal(spawnSync("git", [
    "-C", fakeRepo, "remote", "add", "origin",
    "https://evilgithub.com/sjevans1/Workspace-Platform.git",
  ]).status, 0);
  const result = await runWrapper({
    repository: fakeRepo,
    envelope: JSON.stringify({
      version: 1,
      instruction: "Report only.",
      ci_event: {
        version: 1,
        kind: "ci.workflow.completed",
        delivery_id: "deceptive-origin",
        repository: "sjevans1/Workspace-Platform",
        workflow: { run_id: 1, head_sha: "c".repeat(40), conclusion: "success" },
      },
    }),
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.captured, null);
  assert.match(result.stderr, /repository origin is not/);
});
