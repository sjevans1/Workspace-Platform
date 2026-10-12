// OCP-1B test support: runs ONE real export from the production exporter path in a
// child process, so the ephemeral test CA can be trusted through
// NODE_EXTRA_CA_CERTS without weakening TLS verification anywhere.
// Invoked only by tests/telemetry-transport-https.test.ts.
import { BoundedSpool, startTelemetryExporter, telemetryTransportConfig } from "../../packages/operations/telemetry-transport.ts";
import { composeOperatorTelemetry, serializeOperatorTelemetry } from "../../packages/operations/operator-telemetry.ts";

const [url, credentialId, secret, timeoutMs, spoolPath] = process.argv.slice(2);

const config = telemetryTransportConfig({
  OPERATOR_TELEMETRY_ENABLED: "true",
  OPERATOR_TELEMETRY_ENDPOINT: url,
  OPERATOR_TELEMETRY_CREDENTIAL_ID: credentialId,
  OPERATOR_TELEMETRY_SECRET: secret,
  OPERATOR_TELEMETRY_TIMEOUT_MS: timeoutMs,
  OPERATOR_TELEMETRY_SPOOL_PATH: spoolPath,
}).config;

const spool = new BoundedSpool({
  path: spoolPath,
  maxItems: 4,
  maxBytes: 65536,
  maxAgeMs: 600000,
});

const exporter = startTelemetryExporter({
  config,
  deploymentId: "ws-probe",
  spool,
  payloadProvider: async () =>
    serializeOperatorTelemetry(
      composeOperatorTelemetry({
        application: "workspace",
        version: "1.0.0",
        buildSha: "abc1234",
        deploymentIdSeed: "seed-https",
        alias: "cfo@acme-customer.example",
        environment: "Bearer " + "x".repeat(40),
        region: "https://idp.example.com/realms/acme?tenant=11111111-2222-3333-4444-555555555555",
        services: { worker: { configured: true, healthy: true, values: { claims: 1 } } },
        http: [{ method: "GET", statusClass: "2xx", count: 3, durationSeconds: 0.1 }],
        antivirus: { clean: 1, infected: 0, error: 0 },
        schemaVersion: "client_secret=supersecretvalue",
        identityProfile: "postgres://workspace_runtime:sekretpw@10.0.0.5:5432/tenant_acme",
        events: [{ category: "Confidential merger discussion minutes", count: 1 }],
        now: new Date("2026-10-12T00:00:00Z"),
      }),
    ),
});

const outcome = await exporter.runOnce();
const status = exporter.status();
await exporter.stop();
// Diagnostic only: the raw cause of a direct fetch attempt against the same target,
// so the harness can assert on real client behaviour rather than guessing.
let probeCause: string | null = null;
try {
  await fetch(url, { method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(2_000) });
} catch (error) {
  probeCause = String((error as any)?.cause ?? error).slice(0, 300);
}
process.stdout.write(
  JSON.stringify({
    outcome,
    category: status.last_failure_category,
    delivered: !!status.last_success_at,
    probeCause,
  }) + "\n",
);
process.exit(0);
