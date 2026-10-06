#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const WRANGLER_PACKAGE = "wrangler@4.147.0";

export function parseQuickTunnelUrl(line) {
  return line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0] || null;
}

export function supervisedExitCode({ requested, code }) {
  if (requested) return code ?? 0;
  return code && code !== 0 ? code : 1;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runCommand(command, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
      env: process.env,
    });
    child.once("error", reject);
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited code=${code} signal=${signal || ""}`));
    });
    child.stdin.end(input || "");
  });
}

async function waitForHealth(url) {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const response = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // The edge hostname may need a few seconds to become reachable.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("quick tunnel health check did not become ready");
}

async function publishDispatchUrl(url) {
  await waitForHealth(url);
  const config = required("CI_ORCHESTRATOR_WRANGLER_CONFIG");
  const npx = process.env.NPX_BIN || "npx";
  process.env.CLOUDFLARE_API_TOKEN ||= process.env.CF_API_TOKEN;
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error("CLOUDFLARE_API_TOKEN or CF_API_TOKEN is required");
  await runCommand(npx, [
    "--yes", WRANGLER_PACKAGE, "secret", "put", "AGENT_DISPATCH_URL",
    "--config", config,
  ], `${url}/events`);
  await runCommand(npx, [
    "--yes", WRANGLER_PACKAGE, "deploy", "--config", config,
  ]);
  const urlFile = required("CI_AGENT_TUNNEL_URL_FILE");
  await writeFile(urlFile, `${url}\n`, { mode: 0o600 });
  await chmod(urlFile, 0o600);
  process.stderr.write(`Published current quick tunnel URL: ${url}\n`);
}

async function main() {
  const cloudflared = process.env.CLOUDFLARED_BIN || "cloudflared";
  const origin = process.env.CI_AGENT_BRIDGE_ORIGIN || "http://127.0.0.1:8788";
  const tunnel = spawn(cloudflared, [
    "tunnel", "--no-autoupdate", "--url", origin,
  ], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let publishing = false;
  let failed = false;
  let requestedStop = false;
  const consume = (stream) => {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => {
      process.stderr.write(`${line}\n`);
      const url = parseQuickTunnelUrl(line);
      if (!url || publishing) return;
      publishing = true;
      publishDispatchUrl(url).catch((error) => {
        failed = true;
        process.stderr.write(`Quick tunnel publication failed: ${error.message}\n`);
        tunnel.kill("SIGTERM");
      });
    });
  };
  consume(tunnel.stdout);
  consume(tunnel.stderr);

  const forward = (signal) => {
    requestedStop = true;
    tunnel.kill(signal);
  };
  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGINT", () => forward("SIGINT"));
  const code = await new Promise((resolve, reject) => {
    tunnel.once("error", reject);
    tunnel.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = failed ? 1 : supervisedExitCode({
    requested: requestedStop,
    code,
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    process.stderr.write(`Quick tunnel supervisor failed: ${error.message}\n`);
    process.exitCode = 1;
  });
