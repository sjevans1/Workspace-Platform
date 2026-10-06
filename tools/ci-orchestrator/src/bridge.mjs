import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function eventKey(deliveryId) {
  return createHash("sha256").update(String(deliveryId)).digest("hex");
}

export function buildAgentInstruction(event) {
  const conclusion = event?.workflow?.conclusion || "unknown";
  const runId = event?.workflow?.run_id;
  const sha = event?.workflow?.head_sha;
  return [
    "Continue the standalone Workspace Platform development workflow from the current repository state.",
    `CI event: ${conclusion} for workflow run ${runId}, exact head ${sha}.`,
    "Verify that this event is still relevant before changing anything.",
    conclusion === "success"
      ? "If all required exact-head acceptance gates are green, take only the next permitted roadmap action."
      : "Inspect failed jobs first, then only the failing steps/log excerpts needed to diagnose the failure. Make the smallest safe correction.",
    "Do not weaken tests, security, permissions, or acceptance criteria.",
    "Avoid broad log reads, duplicate tests, and unrelated work.",
    "Keep Workspace standalone; do not introduce an OpenJM Enterprise AI dependency.",
    "After a push, stop and let the next CI completion event resume the loop.",
  ].join(" ");
}

export function createSpool(root) {
  const pending = join(root, "pending");
  const running = join(root, "running");
  const done = join(root, "done");

  async function init() {
    await Promise.all([
      mkdir(pending, { recursive: true }),
      mkdir(running, { recursive: true }),
      mkdir(done, { recursive: true }),
    ]);
  }

  async function recover() {
    await init();
    const files = (await readdir(running))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of files) {
      const from = join(running, name);
      const to = join(pending, name);
      try {
        await link(from, to);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await rm(from, { force: true });
    }
  }

  async function put(event) {
    await init();
    const key = eventKey(event.delivery_id);
    const complete = join(done, key + ".json");
    const active = join(running, key + ".json");
    const queued = join(pending, key + ".json");
    for (const path of [complete, active, queued]) {
      try {
        await readFile(path);
        return { accepted: false, duplicate: true, key };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const temp = join(
      pending,
      `.${key}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    await writeFile(temp, JSON.stringify(event) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    try {
      // link(2) fails with EEXIST instead of replacing another concurrent
      // delivery claim; the final name therefore acts as an atomic spool key.
      await link(temp, queued);
    } catch (error) {
      if (error?.code === "EEXIST")
        return { accepted: false, duplicate: true, key };
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
    return { accepted: true, duplicate: false, key };
  }

  async function claimNext() {
    await init();
    const files = (await readdir(pending))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of files) {
      const from = join(pending, name);
      const to = join(running, name);
      try {
        await rename(from, to);
        return {
          name,
          event: JSON.parse(await readFile(to, "utf8")),
        };
      } catch (error) {
        if (["ENOENT", "EEXIST"].includes(error?.code)) continue;
        throw error;
      }
    }
    return null;
  }

  async function complete(job) {
    await rename(join(running, job.name), join(done, job.name));
  }

  async function retry(job) {
    await rename(join(running, job.name), join(pending, job.name));
  }

  return { init, recover, put, claimNext, complete, retry };
}

export function executableRunner(command, args = []) {
  if (!command) throw new Error("CI_AGENT_COMMAND is required");
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string"))
    throw new Error("CI_AGENT_ARGS_JSON must be a JSON array of strings");

  return async (event) => {
    const envelope = JSON.stringify({
      version: 1,
      instruction: buildAgentInstruction(event),
      ci_event: event,
    });
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env, CI_EVENT_ID: String(event.delivery_id) },
      });
      child.once("error", reject);
      child.stdin.on("error", (error) => {
        // A successful command may exit before consuming the entire envelope.
        // Its exit status remains authoritative; this prevents an uncaught
        // EPIPE from terminating the bridge process.
        if (error?.code !== "EPIPE") reject(error);
      });
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Agent command exited code=${code} signal=${signal || ""}`));
      });
      child.stdin.end(envelope + "\n");
    });
  };
}

export async function runOne(spool, runner) {
  const job = await spool.claimNext();
  if (!job) return false;
  try {
    await runner(job.event);
    await spool.complete(job);
  } catch (error) {
    await spool.retry(job);
    throw error;
  }
  return true;
}

export function createBridge({ token, spool }) {
  if (!token) throw new Error("CI_AGENT_BRIDGE_TOKEN is required");
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      if (request.method !== "POST" || request.url !== "/events") {
        response.writeHead(404).end();
        return;
      }
      const authorization = request.headers.authorization || "";
      const supplied = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
      if (!safeEqual(supplied, token)) {
        response.writeHead(401).end();
        return;
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256_000) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        event?.version !== 1 ||
        event?.kind !== "ci.workflow.completed" ||
        typeof event?.delivery_id !== "string" ||
        typeof event?.repository !== "string"
      ) {
        response.writeHead(400).end();
        return;
      }

      const stored = await spool.put(event);
      response.writeHead(stored.duplicate ? 200 : 202, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({
        ok: true,
        queued: stored.accepted,
        duplicate: stored.duplicate,
      }));
    } catch (error) {
      console.error("Agent bridge request failed", error);
      response.writeHead(400).end();
    }
  });
}

export async function startFromEnv(env = process.env) {
  const spool = createSpool(env.CI_AGENT_SPOOL_DIR || ".data/ci-agent-bridge");
  await spool.recover();
  const args = env.CI_AGENT_ARGS_JSON ? JSON.parse(env.CI_AGENT_ARGS_JSON) : [];
  const runner = executableRunner(env.CI_AGENT_COMMAND, args);
  const server = createBridge({
    token: env.CI_AGENT_BRIDGE_TOKEN,
    spool,
  });
  const host = env.CI_AGENT_BRIDGE_HOST || "127.0.0.1";
  const port = Number(env.CI_AGENT_BRIDGE_PORT || 8788);
  server.listen(port, host);

  let stopped = false;
  const work = async () => {
    if (stopped) return;
    try {
      while (await runOne(spool, runner)) {}
    } catch (error) {
      console.error("Agent bridge runner failed; event returned to spool", error);
    } finally {
      if (!stopped) setTimeout(work, 1000).unref();
    }
  };
  work();

  return async () => {
    stopped = true;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
}

if (import.meta.url === `file://${process.argv[1]}`)
  startFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
