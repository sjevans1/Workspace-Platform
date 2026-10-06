import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export function createSpool(root, options = {}) {
  const claims = join(root, "claims");
  const pending = join(root, "pending");
  const running = join(root, "running");
  const done = join(root, "done");
  const failed = join(root, "failed");
  const retries = join(root, "retries");
  const superseded = join(root, "superseded");
  const retryBaseMs = options.retryBaseMs ?? 5_000;
  const retryMaxMs = options.retryMaxMs ?? 300_000;
  const maxAttempts = options.maxAttempts ?? 10;
  const now = options.now || Date.now;

  async function syncPath(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function exists(path) {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function init() {
    await Promise.all([
      mkdir(claims, { recursive: true }),
      mkdir(pending, { recursive: true }),
      mkdir(running, { recursive: true }),
      mkdir(done, { recursive: true }),
      mkdir(failed, { recursive: true }),
      mkdir(retries, { recursive: true }),
      mkdir(superseded, { recursive: true }),
    ]);
    await syncPath(root);
  }

  async function recover() {
    await init();
    const active = (await readdir(running))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of active) {
      const from = join(running, name);
      const state = await retryState(name);
      const targetDir = Number(state.attempts || 0) >= maxAttempts ? failed : pending;
      const to = join(targetDir, name);
      try {
        await link(from, to);
        await syncPath(targetDir);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await rm(from, { force: true });
      await syncPath(running);
    }

    for (const stateDir of [pending, running, done, failed, superseded]) {
      const legacy = (await readdir(stateDir))
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of legacy) {
        try {
          await link(join(stateDir, name), join(claims, name));
          await syncPath(claims);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
    }

    const claimed = (await readdir(claims))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of claimed) {
      const locations = [pending, running, done, failed, superseded].map((dir) => join(dir, name));
      if ((await Promise.all(locations.map(exists))).some(Boolean)) continue;
      await link(join(claims, name), join(pending, name));
      await syncPath(pending);
    }
  }

  async function put(event) {
    await init();
    const key = eventKey(event.delivery_id);
    const name = key + ".json";
    const claim = join(claims, name);
    try {
      await writeFile(claim, JSON.stringify(event) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code === "EEXIST")
        return { accepted: false, duplicate: true, key };
      throw error;
    }

    await syncPath(claim);
    await syncPath(claims);
    await link(claim, join(pending, name));
    await syncPath(pending);
    return { accepted: true, duplicate: false, key };
  }

  async function retryState(name) {
    try {
      return JSON.parse(await readFile(join(retries, name), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { attempts: 0, next_attempt_at: 0 };
      throw error;
    }
  }

  async function writeRetryState(name, state) {
    const temp = join(retries, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
    await syncPath(temp);
    await rename(temp, join(retries, name));
    await syncPath(retries);
  }

  async function pendingEntries() {
    const files = (await readdir(pending))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const entries = [];
    for (const name of files) {
      try {
        const event = JSON.parse(await readFile(join(pending, name), "utf8"));
        entries.push({ name, event });
      } catch {
        // A partially written or unreadable pending file is left untouched.
      }
    }
    return entries;
  }

  function supersedeKey(event) {
    const workflow = event?.workflow || {};
    return [
      event?.repository || "",
      workflow.head_branch || "",
      workflow.name || workflow.path || "",
    ].join("\u0000");
  }

  // Only the newest completion for a given repository/branch/workflow is still
  // relevant; older queued completions are stale by definition and must not
  // consume a run. Move them to superseded/ without deleting their claims.
  async function supersede() {
    await init();
    const groups = new Map();
    for (const entry of await pendingEntries()) {
      const key = supersedeKey(entry.event);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    let moved = 0;
    for (const entries of groups.values()) {
      if (entries.length < 2) continue;
      entries.sort((a, b) =>
        String(b.event.received_at || "").localeCompare(String(a.event.received_at || "")),
      );
      for (const stale of entries.slice(1)) {
        try {
          await rename(join(pending, stale.name), join(superseded, stale.name));
          await Promise.all([syncPath(pending), syncPath(superseded)]);
          moved++;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    return moved;
  }

  async function claimNext() {
    await init();
    // Newest first: the current head must be handled before stale completions.
    const entries = (await pendingEntries()).sort((a, b) =>
      String(b.event.received_at || "").localeCompare(String(a.event.received_at || "")),
    );
    for (const { name, event } of entries) {
      const state = await retryState(name);
      if (Number(state.next_attempt_at || 0) > now()) continue;
      const from = join(pending, name);
      const to = join(running, name);
      try {
        await rename(from, to);
        await Promise.all([syncPath(pending), syncPath(running)]);
        return { name, event };
      } catch (error) {
        if (["ENOENT", "EEXIST"].includes(error?.code)) continue;
        throw error;
      }
    }
    return null;
  }

  async function complete(job) {
    await rename(join(running, job.name), join(done, job.name));
    await Promise.all([syncPath(running), syncPath(done)]);
    await rm(join(retries, job.name), { force: true });
    await syncPath(retries);
  }

  async function retry(job) {
    const previous = await retryState(job.name);
    const attempts = Number(previous.attempts || 0) + 1;
    const delay = Math.min(retryBaseMs * (2 ** Math.max(0, attempts - 1)), retryMaxMs);
    await writeRetryState(job.name, {
      attempts,
      last_failed_at: new Date(now()).toISOString(),
      next_attempt_at: now() + delay,
    });
    if (attempts >= maxAttempts) {
      await rename(join(running, job.name), join(failed, job.name));
      await Promise.all([syncPath(running), syncPath(failed)]);
      return { attempts, quarantined: true };
    }
    await rename(join(running, job.name), join(pending, job.name));
    await Promise.all([syncPath(running), syncPath(pending)]);
    return { attempts, quarantined: false };
  }

  return { init, recover, put, claimNext, complete, retry, supersede };
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
    const outcome = await spool.retry(job);
    if (error && typeof error === "object") {
      error.bridgeRetry = {
        ...outcome,
        delivery_id: job.event.delivery_id,
      };
    }
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
      const collapsed = await spool.supersede();
      if (collapsed) console.log("Superseded stale queued CI events", { count: collapsed });
      while (await runOne(spool, runner)) {}
    } catch (error) {
      const status = error?.bridgeRetry;
      console.error(
        status?.quarantined
          ? "Agent bridge runner failed; event quarantined"
          : "Agent bridge runner failed; event returned to spool",
        status || { error: error?.message || String(error) },
      );
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
