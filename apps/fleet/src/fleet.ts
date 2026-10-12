// OCP-2A: the OpenJM fleet/operator plane.
//
// This is a separate service boundary, deliberately NOT customer Workspace routes.
// It owns the deployment registry, per-deployment credentials, telemetry ingestion,
// current state, bounded history, fleet operator authorization, fleet audit and
// read APIs for the later fleet view.
//
// Boundaries that must not blur:
// - Workspace does not depend on this service at runtime; a fleet outage leaves
//   Workspace fully functional and OCP-1B spools and retries boundedly.
// - Fleet operator authorization is independent of any customer Workspace role.
// - No customer content, tenant data or Workspace secrets are copied here.
//
// The wire contract is the already-accepted OCP-1B envelope, verified with the same
// pure helpers Workspace uses, so the envelope is never redesigned.

import { createHash, createHmac, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import {
  TELEMETRY_ENVELOPE_SUPPORTED,
  payloadDigest,
  signingInput,
  verifyEnvelopeSignature,
  type TelemetryEnvelope,
} from "../../../packages/operations/telemetry-transport.ts";
import { OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS } from "../../../packages/operations/operator-telemetry.ts";

export const FLEET_SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export type FleetConfig = {
  databaseUrl: string;
  port: number;
  operatorTokenHash: string;
  encryptionKey: Buffer;
  skewMs: number;
  staleMs: number;
  offlineMs: number;
  historyLimit: number;
  maxEnvelopeBytes: number;
  replayRetentionMs: number;
};

// Fail closed on security-sensitive misconfiguration. Workspace never needs to
// supply any of this.
export function fleetConfig(env: Record<string, string | undefined>): FleetConfig {
  const token = env.FLEET_OPERATOR_TOKEN ?? "";
  const key = env.FLEET_ENCRYPTION_KEY ?? "";
  if (token.length < 24) throw new Error("FLEET_OPERATOR_TOKEN must be at least 24 characters");
  if (key.length < 32) throw new Error("FLEET_ENCRYPTION_KEY must be at least 32 characters");
  const url = env.FLEET_DATABASE_URL ?? env.DATABASE_URL ?? "";
  if (!url) throw new Error("FLEET_DATABASE_URL is required");
  return {
    databaseUrl: url,
    port: Number(env.FLEET_PORT) || 4100,
    operatorTokenHash: createHash("sha256").update(token).digest("hex"),
    encryptionKey: createHash("sha256").update(key).digest(),
    skewMs: bounded(env.FLEET_SKEW_MS, 120_000, 1_000, 3_600_000),
    staleMs: bounded(env.FLEET_STALE_MS, 900_000, 60_000, 86_400_000),
    offlineMs: bounded(env.FLEET_OFFLINE_MS, 3_600_000, 60_000, 604_800_000),
    historyLimit: bounded(env.FLEET_HISTORY_LIMIT, 50, 1, 500),
    maxEnvelopeBytes: bounded(env.FLEET_MAX_ENVELOPE_BYTES, 131_072, 4_096, 1_048_576),
    // Bounded replay retention: state is pruned deterministically on each accept.
    replayRetentionMs: bounded(env.FLEET_REPLAY_RETENTION_MS, 86_400_000, 60_000, 2_592_000_000),
  };
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// Credential secret protection at rest (AES-256-GCM, AAD bound to the credential id
// so a ciphertext cannot be moved between credentials).
export function sealCredentialSecret(secret: string, credentialId: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(credentialId));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["fleet-v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function openCredentialSecret(sealed: string, credentialId: string, key: Buffer): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "fleet-v1") throw new Error("Unsupported fleet credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(credentialId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString();
}

export const FLEET_DEPLOYMENT_STATES = ["active", "disabled", "revoked"] as const;

export function operatorTokenMatches(supplied: string, expectedHash: string): boolean {
  const got = createHash("sha256").update(supplied).digest("hex");
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Factual telemetry-age states. Revoked and disabled are registry facts and are NEVER
// inferred from missing telemetry.
export type FleetOnlineState = "never_seen" | "online" | "stale" | "offline" | "disabled" | "revoked";

export function onlineStateFor(
  record: { state: string; last_seen: string | null },
  now: Date,
  config: { staleMs: number; offlineMs: number },
): FleetOnlineState {
  if (record.state === "revoked") return "revoked";
  if (record.state === "disabled") return "disabled";
  if (!record.last_seen) return "never_seen";
  const age = now.getTime() - Date.parse(record.last_seen);
  if (!Number.isFinite(age)) return "never_seen";
  if (age <= config.staleMs) return "online";
  return age <= config.offlineMs ? "stale" : "offline";
}

// Rule-based, bounded, read-mostly alerts derived from state. No automation engine
// and no notification platform.
export type FleetAlert = { deployment_id: string; category: string; severity: "info" | "warning" };

export function alertsFor(
  deployment: { id: string; alias: string | null; state: string; last_seen: string | null },
  current: any,
  now: Date,
  config: { staleMs: number; offlineMs: number },
): FleetAlert[] {
  const alerts: FleetAlert[] = [];
  const online = onlineStateFor(deployment as any, now, config);
  const push = (category: string, severity: FleetAlert["severity"]) =>
    alerts.push({ deployment_id: deployment.id, category, severity });
  if (online === "stale") push("deployment.stale", "warning");
  if (online === "offline") push("deployment.offline", "warning");
  if (online === "never_seen") push("deployment.never_seen", "info");
  if (deployment.state === "revoked") push("credential.revoked", "warning");
  if (deployment.state === "disabled") push("deployment.disabled", "info");
  const telemetry = current?.telemetry ?? null;
  if (telemetry?.readiness?.backup_state === "degraded") push("backup.verification_failed", "warning");
  if (telemetry?.signals?.queue?.state === "degraded") push("queue.degraded", "warning");
  for (const [name, value] of Object.entries(telemetry?.runtime ?? {})) {
    if (value === "unhealthy") push(`${name}.unhealthy`, "warning");
    else if (value === "degraded") push(`${name}.degraded`, "info");
  }
  return alerts.slice(0, 12);
}

// Bounded, allowlisted audit. Secret material never enters an audit row.
export async function fleetAudit(
  q: { query: (sql: string, params?: any[]) => Promise<any> },
  action: string,
  deploymentId: string | null,
  detail?: string | null,
): Promise<void> {
  const boundedAction = /^[a-z][a-z0-9._:-]{0,63}$/.test(action) ? action : "fleet.unknown";
  const boundedDetail = detail ? String(detail).slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, "") : null;
  try {
    await q.query(
      "INSERT INTO fleet_audit(id,action,deployment_id,detail) VALUES(gen_random_uuid(),$1,$2,$3)",
      [boundedAction, deploymentId, boundedDetail],
    );
  } catch {
    // Audit must never break ingestion or reads.
  }
}

export async function ensureFleetSchema(pool: pg.Pool): Promise<void> {
  await pool.query(FLEET_SCHEMA);
}

export type VerifiedIngestion =
  | { ok: true; deploymentId: string; internalId: string; credentialId: string; envelope: TelemetryEnvelope }
  | { ok: false; status: number; code: string };

// The ingestion decision, kept pure so the adversarial matrix is provable without a
// network round trip. Order is deliberate: cheap rejections first, cryptographic
// verification before any persistence.
export function verifyIngestion(input: {
  rawBody: string;
  envelope: TelemetryEnvelope | null;
  // deployment_id is the registry's opaque Workspace deployment id, which is what the
  // envelope carries; internal_id is the registry row used for persistence.
  credential: { id: string; deployment_id: string; internal_id: string; state: string; secret: string } | null;
  now: Date;
  config: { skewMs: number; maxEnvelopeBytes: number };
}): VerifiedIngestion {
  const { rawBody, envelope, credential, now, config } = input;
  if (rawBody.length > config.maxEnvelopeBytes) return { ok: false, status: 413, code: "payload_too_large" };
  if (!envelope) return { ok: false, status: 400, code: "malformed" };
  if (!TELEMETRY_ENVELOPE_SUPPORTED.includes(envelope.envelope))
    return { ok: false, status: 400, code: "unsupported_envelope_version" };
  if (!credential) return { ok: false, status: 401, code: "unknown_credential" };
  if (credential.state !== "active") return { ok: false, status: 403, code: "credential_inactive" };
  // Deployment binding: a credential may only ever speak for its own deployment.
  if (credential.deployment_id !== envelope.deployment_id)
    return { ok: false, status: 403, code: "credential_deployment_mismatch" };
  const skew = Math.abs(now.getTime() - Date.parse(envelope.generated_at));
  if (!Number.isFinite(skew) || skew > config.skewMs)
    return { ok: false, status: 408, code: "timestamp_out_of_window" };
  if (payloadDigest(envelope.payload) !== envelope.payload_digest)
    return { ok: false, status: 400, code: "payload_digest_mismatch" };
  // Version support is checked before cryptographic verification so a deployment
  // speaking an unsupported contract is rejected with a precise code. The signature
  // helper re-validates versions internally, so this stays fail closed either way.
  if (!OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS.includes(envelope.contract))
    return { ok: false, status: 415, code: "unsupported_contract_version" };
  if (!verifyEnvelopeSignature(envelope, credential.secret))
    return { ok: false, status: 401, code: "invalid_signature" };
  try {
    const parsed = JSON.parse(envelope.payload);
    if (parsed?.schema !== envelope.contract) return { ok: false, status: 400, code: "payload_contract_mismatch" };
  } catch {
    return { ok: false, status: 400, code: "payload_unparseable" };
  }
  return { ok: true, deploymentId: envelope.deployment_id, internalId: credential.internal_id, credentialId: credential.id, envelope };
}

export function buildFleetService(pool: pg.Pool, config: FleetConfig): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: config.maxEnvelopeBytes + 1024 });

  const operator = async (r: any, reply: any) => {
    const header = String(r.headers.authorization ?? "");
    if (!header.startsWith("Bearer ") || !operatorTokenMatches(header.slice(7), config.operatorTokenHash)) {
      reply.code(401).send({ error: "Fleet operator credential required" });
      return false;
    }
    return true;
  };

  // Ingestion: the production OCP-1B receiver.
  app.post("/ingest", async (r, reply) => {
    const rawBody = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
    let envelope: TelemetryEnvelope | null = null;
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      envelope = null;
    }
    const credentialId = typeof (envelope as any)?.credential_id === "string" ? (envelope as any).credential_id : null;
    let credential: { id: string; deployment_id: string; internal_id: string; state: string; secret: string } | null = null;
    if (credentialId) {
      const found = await pool.query(
        "SELECT c.id,c.deployment_id AS internal_id,c.state,c.secret_encrypted,d.workspace_deployment_id,d.state AS deployment_state FROM deployment_credentials c JOIN deployments d ON d.id=c.deployment_id WHERE c.id=$1",
        [credentialId],
      );
      if (found.rowCount) {
        const row = found.rows[0];
        try {
          credential = {
            id: row.id,
            deployment_id: row.workspace_deployment_id,
            internal_id: row.internal_id,
            state: row.deployment_state === "revoked" ? "revoked" : row.state,
            secret: openCredentialSecret(row.secret_encrypted, row.id, config.encryptionKey),
          };
        } catch {
          credential = null;
        }
      }
    }
    const verdict = verifyIngestion({ rawBody, envelope, credential, now: new Date(), config });
    if (!verdict.ok) {
      await fleetAudit(pool, "ingestion.rejected", credential?.internal_id ?? null, verdict.code);
      reply.code(verdict.status).send({ error: verdict.code });
      return { error: verdict.code };
    }
    // Replay protection: unique on (credential_id, nonce) and on signature, so both a
    // replayed nonce and a replayed envelope are rejected. State is pruned to a
    // bounded retention window on every accept.
    try {
      await pool.query(
        "INSERT INTO fleet_replay(credential_id,nonce,signature,seen_at) VALUES($1,$2,$3,now())",
        [verdict.credentialId, verdict.envelope.nonce, verdict.envelope.signature],
      );
    } catch {
      await fleetAudit(pool, "ingestion.rejected", verdict.internalId, "replayed");
      reply.code(409).send({ error: "replayed" });
      return { error: "replayed" };
    }
    await pool.query("DELETE FROM fleet_replay WHERE seen_at < now() - ($1||' milliseconds')::interval", [
      String(config.replayRetentionMs),
    ]);
    let telemetry: any = null;
    try {
      telemetry = JSON.parse(verdict.envelope.payload);
    } catch {
      telemetry = null;
    }
    // Current state is upserted and bounded history is appended, preserving the
    // telemetry's own unknown semantics (nulls are never coerced to healthy/zero).
    await pool.query(
      `INSERT INTO deployment_current_state(deployment_id,updated_at,contract_version,envelope_version,telemetry)
       VALUES($1,now(),$2,$3,$4)
       ON CONFLICT (deployment_id) DO UPDATE SET updated_at=now(), contract_version=EXCLUDED.contract_version, envelope_version=EXCLUDED.envelope_version, telemetry=EXCLUDED.telemetry`,
      [verdict.internalId, verdict.envelope.contract, verdict.envelope.envelope, JSON.stringify(telemetry)],
    );
    await pool.query(
      `UPDATE deployments SET last_seen=now(), app_version=COALESCE($2,app_version), build_sha=COALESCE($3,build_sha),
         schema_version=COALESCE($4,schema_version), contract_version=$5 WHERE id=$1`,
      [
        verdict.internalId,
        telemetry?.source?.version ?? null,
        telemetry?.source?.build_sha ?? null,
        telemetry?.readiness?.schema_version ?? null,
        verdict.envelope.contract,
      ],
    );
    await pool.query(
      "INSERT INTO deployment_state_history(id,deployment_id,observed_at,queue_state,backup_state,online_state) VALUES(gen_random_uuid(),$1,now(),$2,$3,$4)",
      [
        verdict.internalId,
        telemetry?.signals?.queue?.state ?? null,
        telemetry?.readiness?.backup_state ?? null,
        "online",
      ],
    );
    await pool.query(
      "DELETE FROM deployment_state_history WHERE id IN (SELECT id FROM deployment_state_history WHERE deployment_id=$1 ORDER BY observed_at DESC OFFSET $2)",
      [verdict.internalId, config.historyLimit],
    );
    reply.code(202).send({ accepted: true });
    return { accepted: true };
  });

  // Read-only operator APIs. These form the OCP-2B contract; there are deliberately
  // no mutation or remote-execution endpoints.
  app.get("/deployments", async (r, reply) => {
    if (!(await operator(r, reply))) return;
    const rows = await pool.query(
      `SELECT d.id,d.workspace_deployment_id,d.alias,d.state,d.first_seen,d.last_seen,d.app_version,d.build_sha,d.schema_version,d.contract_version,
              s.telemetry
         FROM deployments d LEFT JOIN deployment_current_state s ON s.deployment_id=d.id
        ORDER BY d.created_at DESC LIMIT 500`,
    );
    const now = new Date();
    return {
      deployments: rows.rows.map((row: any) => ({
        id: row.id,
        workspace_deployment_id: row.workspace_deployment_id,
        alias: row.alias,
        state: row.state,
        online_state: onlineStateFor({ state: row.state, last_seen: row.last_seen }, now, config),
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        app_version: row.app_version,
        build_sha: row.build_sha,
        schema_version: row.schema_version,
        contract_version: row.contract_version,
        queue: row.telemetry?.signals?.queue ?? { depth: null, state: "unknown" },
        storage: row.telemetry?.signals?.capacity?.storage ?? null,
        database_capacity: row.telemetry?.signals?.capacity?.database ?? null,
        backup: row.telemetry?.readiness
          ? { last_backup_at: row.telemetry.readiness.last_backup_at ?? null, state: row.telemetry.readiness.backup_state ?? "unknown" }
          : { last_backup_at: null, state: "unknown" },
        runtime: row.telemetry?.runtime ?? null,
      })),
    };
  });

  app.get("/deployments/:id", async (r, reply) => {
    if (!(await operator(r, reply))) return;
    const id = String((r.params as any).id);
    const rows = await pool.query(
      `SELECT d.*, s.telemetry FROM deployments d LEFT JOIN deployment_current_state s ON s.deployment_id=d.id WHERE d.id=$1`,
      [id],
    );
    if (!rows.rowCount) {
      reply.code(404).send({ error: "Deployment not found" });
      return { error: "Deployment not found" };
    }
    const row = rows.rows[0];
    const credentials = await pool.query(
      "SELECT id,state,created_at,rotated_at,revoked_at FROM deployment_credentials WHERE deployment_id=$1 ORDER BY created_at DESC",
      [id],
    );
    const history = await pool.query(
      "SELECT observed_at,queue_state,backup_state,online_state FROM deployment_state_history WHERE deployment_id=$1 ORDER BY observed_at DESC LIMIT $2",
      [id, config.historyLimit],
    );
    const now = new Date();
    return {
      deployment: {
        id: row.id,
        workspace_deployment_id: row.workspace_deployment_id,
        alias: row.alias,
        state: row.state,
        online_state: onlineStateFor({ state: row.state, last_seen: row.last_seen }, now, config),
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        app_version: row.app_version,
        build_sha: row.build_sha,
        schema_version: row.schema_version,
        contract_version: row.contract_version,
        notes: row.notes,
      },
      // Secrets are never returned; only credential identifiers and lifecycle state.
      credentials: credentials.rows,
      telemetry: row.telemetry ?? null,
      history: history.rows,
      alerts: alertsFor(
        { id: row.id, alias: row.alias, state: row.state, last_seen: row.last_seen },
        { telemetry: row.telemetry },
        now,
        config,
      ),
    };
  });

  app.get("/alerts", async (r, reply) => {
    if (!(await operator(r, reply))) return;
    const rows = await pool.query(
      `SELECT d.id,d.alias,d.state,d.last_seen,s.telemetry FROM deployments d LEFT JOIN deployment_current_state s ON s.deployment_id=d.id ORDER BY d.created_at DESC LIMIT 500`,
    );
    const now = new Date();
    const alerts = rows.rows.flatMap((row: any) =>
      alertsFor({ id: row.id, alias: row.alias, state: row.state, last_seen: row.last_seen }, { telemetry: row.telemetry }, now, config),
    );
    return { alerts: alerts.slice(0, 200) };
  });

  app.get("/audit", async (r, reply) => {
    if (!(await operator(r, reply))) return;
    const rows = await pool.query(
      "SELECT action,deployment_id,detail,created_at FROM fleet_audit ORDER BY created_at DESC LIMIT 200",
    );
    return { audit: rows.rows };
  });

  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
