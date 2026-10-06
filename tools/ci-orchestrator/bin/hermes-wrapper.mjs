#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_ENVELOPE_BYTES = 1_000_000;
const EXPECTED_REPOSITORY = "sjevans1/Workspace-Platform";

// Bridge-only secrets that must never reach the autonomous agent or anything
// it spawns. Hermes keeps its own provider/config variables untouched.
const STRIPPED_ENV_KEYS = [
  "CI_AGENT_BRIDGE_TOKEN",
  "AGENT_DISPATCH_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
];

function agentEnvironment() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

function fail(message, code = 2) {
  process.stderr.write(`Hermes wrapper: ${message}\n`);
  process.exit(code);
}

// Optional model pin for autonomous CI runs. Left unset, Hermes uses its own
// configured model/fallback chain. Set, it forces a specific provider+model so
// event-driven runs do not silently fall back to a rate-limited free tier.
function modelSelection() {
  const flags = [];
  const model = (process.env.CI_HERMES_MODEL || "").trim();
  const provider = (process.env.CI_HERMES_PROVIDER || "").trim();
  if (model) flags.push("--model", model);
  if (provider) flags.push("--provider", provider);
  return flags;
}

async function readEnvelope() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_ENVELOPE_BYTES) fail("envelope exceeds size limit");
    chunks.push(chunk);
  }

  let envelope;
  try {
    envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("stdin must contain one valid single JSON envelope");
  }
  if (
    envelope?.version !== 1 ||
    typeof envelope?.instruction !== "string" ||
    !envelope.instruction.trim() ||
    envelope?.ci_event?.version !== 1 ||
    envelope?.ci_event?.kind !== "ci.workflow.completed" ||
    envelope?.ci_event?.repository !== EXPECTED_REPOSITORY ||
    typeof envelope?.ci_event?.delivery_id !== "string"
  ) {
    fail("stdin must contain one valid single JSON envelope");
  }
  return envelope;
}

function verifiedRepository() {
  const configured = process.env.WORKSPACE_PLATFORM_REPO;
  const repository = resolve(configured || new URL("../../..", import.meta.url).pathname);
  const topLevel = spawnSync("git", ["-C", repository, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (topLevel.status !== 0 || resolve(topLevel.stdout.trim()) !== repository)
    fail("WORKSPACE_PLATFORM_REPO is not a Git repository root");

  const remote = spawnSync("git", ["-C", repository, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  const origin = remote.stdout.trim();
  const canonicalHttps = /^https:\/\/github\.com\/sjevans1\/Workspace-Platform(?:\.git)?$/;
  const canonicalSsh = /^git@github\.com:sjevans1\/Workspace-Platform(?:\.git)?$/;
  if (
    remote.status !== 0 ||
    (!canonicalHttps.test(origin) && !canonicalSsh.test(origin))
  ) {
    fail("repository origin is not sjevans1/Workspace-Platform");
  }
  const branch = spawnSync("git", ["-C", repository, "symbolic-ref", "--quiet", "--short", "HEAD"], {
    encoding: "utf8",
  });
  const expectedBranch = (process.env.CI_AGENT_CANONICAL_BRANCH || "main").trim();
  if (branch.status !== 0 || branch.stdout.trim() !== expectedBranch)
    fail(`deployment checkout must stay on canonical branch ${expectedBranch}`);

  return repository;
}

function worktreeRoot() {
  return resolve(
    process.env.CI_AGENT_WORKTREE_ROOT ||
      join(tmpdir(), "workspace-ci-agent-worktrees"),
  );
}

function pathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function removeWorktree(repository, path) {
  const removed = spawnSync(
    "git",
    ["-C", repository, "worktree", "remove", "--force", path],
    { encoding: "utf8" },
  );
  if (removed.status !== 0) {
    // If git no longer knows about it, filesystem cleanup is still safe
    // because paths are constrained beneath CI_AGENT_WORKTREE_ROOT.
    const stderr = removed.stderr || "";
    if (!/not a working tree|is not a working tree|does not exist/i.test(stderr))
      throw new Error(`could not remove agent worktree: ${stderr.trim()}`);
  }
  await rm(path, { recursive: true, force: true });
}

async function recoverScratchWorktrees(repository, root) {
  await mkdir(root, { recursive: true });
  const listed = spawnSync(
    "git",
    ["-C", repository, "worktree", "list", "--porcelain"],
    { encoding: "utf8" },
  );
  if (listed.status !== 0)
    throw new Error(`could not list agent worktrees: ${listed.stderr.trim()}`);

  const paths = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()))
    .filter((path) => path !== repository && pathWithin(root, path));

  for (const path of paths) await removeWorktree(repository, path);

  const pruned = spawnSync("git", ["-C", repository, "worktree", "prune"], {
    encoding: "utf8",
  });
  if (pruned.status !== 0)
    throw new Error(`could not prune agent worktrees: ${pruned.stderr.trim()}`);
}

async function createScratchWorktree(repository, deliveryId) {
  const root = worktreeRoot();
  await recoverScratchWorktrees(repository, root);
  const safeId = String(deliveryId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const path = join(root, `${safeId || "event"}-${randomUUID()}`);
  const added = spawnSync(
    "git",
    ["-C", repository, "worktree", "add", "--detach", path, "HEAD"],
    { encoding: "utf8" },
  );
  if (added.status !== 0)
    throw new Error(`could not create agent worktree: ${added.stderr.trim()}`);
  return path;
}

async function main() {
  const envelope = await readEnvelope();
  const repository = verifiedRepository();
  let worktree;
  try {
    worktree = await createScratchWorktree(
      repository,
      envelope.ci_event.delivery_id,
    );
  } catch (error) {
    fail(error.message);
  }
  const prompt = [
    envelope.instruction.trim(),
    "",
    "Authenticated normalized CI event metadata:",
    JSON.stringify(envelope.ci_event),
  ].join("\n");
  const command = process.env.HERMES_BIN || "hermes";
  const args = [
    "chat",
    "--query-file", "-",
    "--oneshot",
    "-Q",
    "--source", "tool",
    "--in", worktree,
    "--run-budget", process.env.CI_HERMES_RUN_BUDGET_SECONDS || "1800",
    ...modelSelection(),
    "--yolo",
  ];

  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: worktree,
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
      env: agentEnvironment(),
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) resolveExit(1);
      else resolveExit(exitCode ?? 1);
    });
    child.stdin.end(prompt);
  }).catch((error) => {
    process.stderr.write(`Hermes wrapper: ${error.message}\n`);
    return 1;
  });

  try {
    await removeWorktree(repository, worktree);
  } catch (error) {
    process.stderr.write(`Hermes wrapper: cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code;
}

await main();
