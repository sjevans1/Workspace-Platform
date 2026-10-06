#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const MAX_ENVELOPE_BYTES = 1_000_000;
const EXPECTED_REPOSITORY = "sjevans1/Workspace-Platform";

function fail(message, code = 2) {
  process.stderr.write(`Hermes wrapper: ${message}\n`);
  process.exit(code);
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
  return repository;
}

async function main() {
  const envelope = await readEnvelope();
  const repository = verifiedRepository();
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
    "--in", repository,
    "--run-budget", process.env.CI_HERMES_RUN_BUDGET_SECONDS || "1800",
    "--yolo",
  ];

  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
      env: process.env,
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

  process.exitCode = code;
}

await main();
