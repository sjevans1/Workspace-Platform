import { Database } from "../../../packages/database/index.ts";
import { assertDeploymentValid } from "../../../packages/deployment/index.ts";
import { startInternalHealthServer } from "../../../packages/operations/health.ts";
import { startWorker, workerHealthState } from "./worker.ts";

// Wave X / X3 (W26): fail closed on invalid deployment configuration before the
// service starts. Service scope, so only settings this service receives.
assertDeploymentValid(process.env, "worker");
const db = new Database(),
  stopWorker = startWorker(db),
  maxTickMs = Math.max(
    5000,
    Number(process.env.WORKER_HEALTH_MAX_TICK_MS || 60000),
  ),
  graceMs = Math.max(
    2000,
    Number(process.env.WORKER_HEALTH_GRACE_MS || 10000),
  ),
  stopHealth = await startInternalHealthServer(
    Number(process.env.WORKER_HEALTH_PORT || 4001),
    async () => {
      await db.system((q) => q.query("SELECT 1"));
      const state = workerHealthState(),
        now = Date.now(),
        runningFor =
          state.running && state.lastStartedAt ? now - state.lastStartedAt : 0,
        successful =
          state.lastCompletedAt !== null || now - state.startedAt <= graceMs,
        healthy =
          successful &&
          state.consecutiveFailures < 3 &&
          (!state.running || runningFor <= maxTickMs);
      return {
        healthy,
        running: state.running,
        running_for_ms: runningFor,
        last_completed_at: state.lastCompletedAt
          ? new Date(state.lastCompletedAt).toISOString()
          : null,
        consecutive_failures: state.consecutiveFailures,
        last_error: state.lastError,
      };
    },
    process.env.WORKER_HEALTH_HOST || "127.0.0.1",
  );

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await stopHealth();
    await stopWorker();
    await db.close();
    process.exit(0);
  });
