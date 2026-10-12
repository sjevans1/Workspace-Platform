import { Database } from "../../../packages/database/index.ts";
import { assertDeploymentValid } from "../../../packages/deployment/index.ts";
import { startInternalHealthServer } from "../../../packages/operations/health.ts";
import { startWorker, workerHealthState } from "./worker.ts";
import {
  BoundedSpool,
  startTelemetryExporter,
  telemetryTransportConfig,
} from "../../../packages/operations/telemetry-transport.ts";
import {
  composeOperatorTelemetry,
  operatorTelemetryConfig,
  serializeOperatorTelemetry,
} from "../../../packages/operations/operator-telemetry.ts";
import {
  collectOperationalSources,
  toTelemetryInputs,
} from "../../../packages/operations/operational-sources.ts";

// Wave X / X3 (W26): fail closed on invalid deployment configuration before the
// service starts. Service scope, so only settings this service receives.
assertDeploymentValid(process.env, "worker");
const db = new Database(),
  stopWorker = startWorker(db),
  // OCP-1B: the telemetry exporter is an isolated optional loop. It has its own
  // timer and failure counter, never participates in tick(), and is never part of
  // worker health, so telemetry pressure cannot starve or terminate product jobs
  // and a transport failure cannot flip worker readiness.
  telemetryExporter = (() => {
    const settings = telemetryTransportConfig(process.env);
    if (!settings.config.enabled) return null;
    const otel = operatorTelemetryConfig(process.env);
    const spool = new BoundedSpool({
      path: settings.config.spoolPath,
      maxItems: settings.config.spoolMaxItems,
      maxBytes: settings.config.spoolMaxBytes,
      maxAgeMs: settings.config.spoolMaxAgeMs,
    });
    const exporter = startTelemetryExporter({
      config: settings.config,
      deploymentId: otel.deploymentIdSeed ?? process.env.ENCRYPTION_KEY ?? "workspace-unidentified",
      spool,
      statusPath: settings.config.spoolPath.replace(/spool\.jsonl$/, "status.json"),
      payloadProvider: async () => {
        // Consume the canonical OCP-1A serialization; never reconstruct telemetry
        // and never bypass the OCP-1A prohibition scan.
        // OCP-1 source enrichment: read-only, bounded, fail-soft adapters feeding the
        // existing contract. databaseCapacity is deliberately left unknown.
        const sources = await collectOperationalSources({
        q: { query: (sql: string, params?: any[]) => db.system((inner) => inner.query(sql, params)) },
        env: process.env,
        backupDirectory: process.env.OPERATOR_TELEMETRY_BACKUP_DIR ?? null,
        });
        const dependencies: Record<string, boolean> = {};
        try {
          await db.system((q) => q.query("SELECT 1"));
          dependencies.database = true;
        } catch {
          dependencies.database = false;
        }
        return serializeOperatorTelemetry(
          composeOperatorTelemetry({
            application: "workspace",
            version: process.env.WORKSPACE_VERSION ?? "unknown",
            buildSha: process.env.WORKSPACE_BUILD_SHA ?? null,
            deploymentIdSeed: otel.deploymentIdSeed ?? process.env.ENCRYPTION_KEY ?? "workspace-unidentified",
            releaseChannel: otel.releaseChannel,
            environment: otel.environment,
            region: otel.region,
            dependencies,
            overallHealthy: true,
            services: {},
            http: [],
            antivirus: null,
            ...toTelemetryInputs(sources),
            schemaVersion: null,
            upgradeReady: null,
            tlsHealthy: null,
          }),
        );
      },
    });
    void spool.load().catch(() => undefined);
    return exporter;
  })(),
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
        // OCP-1B: bounded, secret-free transport status. Never the credential secret,
        // never an authorization header, never a raw remote error body.
        telemetry_transport: telemetryExporter
          ? telemetryExporter.status()
          : { enabled: false },
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
    if (telemetryExporter) await telemetryExporter.stop().catch(() => undefined);
    await stopWorker();
    await db.close();
    process.exit(0);
  });
