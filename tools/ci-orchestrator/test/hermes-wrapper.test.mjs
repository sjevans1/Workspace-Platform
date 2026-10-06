import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../../..");
const wrapper = join(repoRoot, "tools/ci-orchestrator/bin/hermes-wrapper.mjs");

function git(repository, args) {
  return spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
}

async function canonicalRepo(root, origin = "https://github.com/sjevans1/Workspace-Platform.git") {
  const repository = join(root, "deployment");
  assert.equal(spawnSync("git", ["init", "-q", "-b", "main", repository]).status, 0);
  assert.equal(git(repository, ["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(repository, ["config", "user.name", "CI Test"]).status, 0);
  await writeFile(join(repository, "README.md"), "canonical deployment checkout\n");
  assert.equal(git(repository, ["add", "README.md"]).status, 0);
  assert.equal(git(repository, ["commit", "-q", "-m", "fixture"]).status, 0);
  assert.equal(git(repository, ["remote", "add", "origin", origin]).status, 0);
  return repository;
}

async function runWrapper({ envelope, exitCode = 0, repository, extraEnv = {} }) {
  const root = await mkdtemp(join(tmpdir(), "workspace-hermes-wrapper-"));
  const deployment = repository || await canonicalRepo(root);
  const worktreeRoot = join(root, "worktrees");
  const beforeHead = git(deployment, ["rev-parse", "HEAD"]).stdout.trim();
  const beforeBranch = git(deployment, ["branch", "--show-current"]).stdout.trim();
  const capture = join(root, "capture.json");
  const fakeHermes = join(root, "fake-hermes.mjs");
  await writeFile(fakeHermes, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nlet body = "";\nfor await (const chunk of process.stdin) body += chunk;\nwriteFileSync(process.env.HERMES_FAKE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), body, env: { bridgeToken: process.env.CI_AGENT_BRIDGE_TOKEN ?? null, dispatchToken: process.env.AGENT_DISPATCH_TOKEN ?? null, hasPath: Boolean(process.env.PATH) } }));\nprocess.exit(Number(process.env.HERMES_FAKE_EXIT || 0));\n`, { mode: 0o700 });
  await chmod(fakeHermes, 0o700);

  const result = await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [wrapper], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERMES_BIN: fakeHermes,
        HERMES_FAKE_CAPTURE: capture,
        HERMES_FAKE_EXIT: String(exitCode),
        WORKSPACE_PLATFORM_REPO: deployment,
        CI_AGENT_WORKTREE_ROOT: worktreeRoot,
        CI_AGENT_CANONICAL_BRANCH: "main",
        CI_AGENT_BRIDGE_TOKEN: "must-not-reach-agent",
        AGENT_DISPATCH_TOKEN: "must-not-reach-agent",
        CI_HERMES_MODEL: "",
        CI_HERMES_PROVIDER: "",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolveResult({ code, signal, stderr }));
    child.stdin.end(envelope);
  });
  const captured = await readFile(capture, "utf8").then(JSON.parse).catch(() => null);
  const afterHead = git(deployment, ["rev-parse", "HEAD"]).stdout.trim();
  const afterBranch = git(deployment, ["branch", "--show-current"]).stdout.trim();
  const remainingWorktrees = await readdir(worktreeRoot).catch(() => []);
  const response = {
    ...result,
    captured,
    deployment,
    beforeHead,
    afterHead,
    beforeBranch,
    afterBranch,
    remainingWorktrees,
    worktreeRoot,
  };
  await rm(root, { recursive: true, force: true });
  return response;
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
  assert.notEqual(result.captured.cwd, result.deployment);
  assert.equal(result.captured.cwd.startsWith(result.worktreeRoot), true);
  assert.equal(result.beforeBranch, "main");
  assert.equal(result.afterBranch, "main");
  assert.equal(result.beforeHead, result.afterHead);
  assert.deepEqual(result.remainingWorktrees, []);
  assert.deepEqual(result.captured.args, [
    "chat", "--query-file", "-", "--oneshot", "-Q", "--source", "tool",
    "--in", result.captured.cwd, "--run-budget", "1800", "--yolo",
  ]);
  assert.match(result.captured.body, /Inspect \$\(touch \/tmp\/must-not-exist\) `uname`/);
  assert.match(result.captured.body, /"delivery_id":"wrapper-test"/);
  assert.equal(result.captured.env.bridgeToken, null);
  assert.equal(result.captured.env.dispatchToken, null);
  assert.equal(result.captured.env.hasPath, true);
});

test("failed Hermes run still leaves canonical deployment checkout untouched", async () => {
  const result = await runWrapper({
    exitCode: 7,
    envelope: JSON.stringify({
      version: 1,
      instruction: "Fail deliberately.",
      ci_event: {
        version: 1,
        kind: "ci.workflow.completed",
        delivery_id: "failed-isolation-test",
        repository: "sjevans1/Workspace-Platform",
        workflow: { run_id: 2, head_sha: "e".repeat(40), conclusion: "failure" },
      },
    }),
  });
  assert.equal(result.code, 7);
  assert.equal(result.beforeBranch, "main");
  assert.equal(result.afterBranch, "main");
  assert.equal(result.beforeHead, result.afterHead);
  assert.deepEqual(result.remainingWorktrees, []);
});

test("wrapper refuses to launch if deployment checkout is not canonical main", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-non-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await canonicalRepo(root);
  assert.equal(git(repository, ["checkout", "-q", "-b", "feature/drift"]).status, 0);
  const result = await runWrapper({
    repository,
    envelope: JSON.stringify({
      version: 1,
      instruction: "Do not run.",
      ci_event: {
        version: 1,
        kind: "ci.workflow.completed",
        delivery_id: "non-main-test",
        repository: "sjevans1/Workspace-Platform",
        workflow: { run_id: 3, head_sha: "f".repeat(40), conclusion: "success" },
      },
    }),
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.captured, null);
  assert.match(result.stderr, /deployment checkout must stay on canonical branch main/);
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

test("Hermes wrapper pins model/provider only when explicitly configured", async () => {
  const envelope = JSON.stringify({
    version: 1,
    instruction: "Report only.",
    ci_event: {
      version: 1,
      kind: "ci.workflow.completed",
      delivery_id: "wrapper-model-test",
      repository: "sjevans1/Workspace-Platform",
      workflow: { run_id: 1, head_sha: "d".repeat(40), conclusion: "success" },
    },
  });

  const pinned = await runWrapper({
    envelope,
    extraEnv: { CI_HERMES_MODEL: "z-ai/glm-5.3-flash", CI_HERMES_PROVIDER: "openrouter" },
  });
  assert.equal(pinned.code, 0, pinned.stderr);
  const at = pinned.captured.args.indexOf("--model");
  assert.notEqual(at, -1);
  assert.deepEqual(pinned.captured.args.slice(at, at + 4), [
    "--model", "z-ai/glm-5.3-flash", "--provider", "openrouter",
  ]);
  assert.equal(pinned.captured.args.at(-1), "--yolo");

  const unpinned = await runWrapper({
    envelope,
    extraEnv: { CI_HERMES_MODEL: "", CI_HERMES_PROVIDER: "" },
  });
  assert.equal(unpinned.code, 0, unpinned.stderr);
  assert.equal(unpinned.captured.args.includes("--model"), false);
  assert.equal(unpinned.captured.args.includes("--provider"), false);
});
