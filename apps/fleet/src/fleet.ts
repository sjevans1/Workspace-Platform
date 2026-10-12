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

import { createHash, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import {
  TELEMETRY_ENVELOPE_SUPPORTED,
  payloadDigest,
  signingInput,
  verifyEnvelopeSignature,
  type TelemetryEnvelope,
} from "../../../packages/operations/telemetry-transport.ts";
import { OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS, isCanonicalDeploymentId, validateOperatorTelemetryV1 } from "../../../packages/operations/operator-telemetry.ts";
import {
  FLEET_RATE_LIMIT_RULES,
  RateLimiter,
  clientKey,
  rateLimitPolicy,
  rateLimitedBody,
  type RateLimitPolicy,
} from "../../../packages/security/rate-limit.ts";

export { runFleetMigrations, fleetSchemaVersion, FLEET_MIGRATIONS } from "./migrations.ts";
import { runFleetMigrations } from "./migrations.ts";

export type FleetConfig = {
  databaseUrl: string;
  port: number;
  offlineMsNormalized?: boolean;
  operatorTokenHash: string;
  encryptionKey: Buffer;
  skewMs: number;
  staleMs: number;
  offlineMs: number;
  historyLimit: number;
  maxEnvelopeBytes: number;
  replayRetentionMs: number;
  // Bounded audit retention: how long an audit record may live, and the maximum number of
  // records a single pruning pass may remove so no pass becomes an unbounded delete.
  auditRetentionMs: number;
  auditPruneBatch: number;
  rateLimit: RateLimitPolicy;
};

// Fail closed on security-sensitive misconfiguration. Workspace never needs to
// supply any of this.
export function fleetConfig(env: Record<string, string | undefined>): FleetConfig {
  const token = env.FLEET_OPERATOR_TOKEN ?? "";
  const key = env.FLEET_ENCRYPTION_KEY ?? "";
  if (token.length < 24) throw new Error("FLEET_OPERATOR_TOKEN must be at least 24 characters");
  if (key.length < 32) throw new Error("FLEET_ENCRYPTION_KEY must be at least 32 characters");
  // The fleet persistence boundary is explicit. The fleet service must never silently
  // inherit the customer Workspace database configuration, so DATABASE_URL is not
  // consulted at all; the operator configures the fleet database explicitly, and
  // production should use a dedicated, appropriately scoped database and role.
  const url = env.FLEET_DATABASE_URL ?? "";
  if (!url) throw new Error("FLEET_DATABASE_URL is required (the fleet service does not inherit DATABASE_URL)");
  const staleMs = bounded(env.FLEET_STALE_MS, 900_000, 60_000, 86_400_000);
  const requestedOfflineMs = bounded(env.FLEET_OFFLINE_MS, 3_600_000, 60_000, 604_800_000);
  const offlineMsNormalized = requestedOfflineMs <= staleMs;
  const offlineMs = offlineMsNormalized ? staleMs * 2 : requestedOfflineMs;
  return {
    databaseUrl: url,
    port: Number(env.FLEET_PORT) || 4100,
    operatorTokenHash: createHash("sha256").update(token).digest("hex"),
    encryptionKey: createHash("sha256").update(key).digest(),
    skewMs: bounded(env.FLEET_SKEW_MS, 120_000, 1_000, 3_600_000),
    staleMs,
    // Normalized so the state progression online -> stale -> offline always holds, even
    // if an operator configures an offline threshold at or below the stale threshold.
    offlineMs,
    offlineMsNormalized,
    historyLimit: bounded(env.FLEET_HISTORY_LIMIT, 50, 1, 500),
    maxEnvelopeBytes: bounded(env.FLEET_MAX_ENVELOPE_BYTES, 131_072, 4_096, 1_048_576),
    // Bounded replay retention: state is pruned deterministically on each accept.
    replayRetentionMs: bounded(env.FLEET_REPLAY_RETENTION_MS, 86_400_000, 60_000, 2_592_000_000),
    // Safe default of 90 days, clamped to a 1 day minimum and a 730 day maximum.
    auditRetentionMs: bounded(env.FLEET_AUDIT_RETENTION_MS, 90 * 86_400_000, 86_400_000, 730 * 86_400_000),
    // At most 500 rows per pruning pass, clamped to 1..5000.
    auditPruneBatch: bounded(env.FLEET_AUDIT_PRUNE_BATCH, 500, 1, 5_000),
    rateLimit: rateLimitPolicy(env),
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

// Boot-time convenience: applies any pending versioned migrations. Never rewrites the
// schema implicitly and never mixes with customer Workspace tenant migrations.
export async function ensureFleetSchema(pool: pg.Pool): Promise<number[]> {
  return runFleetMigrations(pool);
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
  credential: { id: string; deployment_id: string; internal_id: string; state: string; deployment_state: string; secret: string } | null;
  now: Date;
  config: { skewMs: number; maxEnvelopeBytes: number };
}): VerifiedIngestion {
  const { rawBody, envelope, credential, now, config } = input;
  // UTF-8 byte accounting, not JS character count.
  if (Buffer.byteLength(rawBody, "utf8") > config.maxEnvelopeBytes)
    return { ok: false, status: 413, code: "payload_too_large" };
  if (!envelope) return { ok: false, status: 400, code: "malformed" };
  if (!TELEMETRY_ENVELOPE_SUPPORTED.includes(envelope.envelope))
    return { ok: false, status: 400, code: "unsupported_envelope_version" };
  if (!credential) return { ok: false, status: 401, code: "unknown_credential" };
  if (credential.state !== "active") return { ok: false, status: 403, code: "credential_inactive" };
  // Deployment lifecycle is enforced independently of credential state: a disabled or
  // revoked deployment must not ingest merely because its credential is still active.
  // The two states stay semantically distinct and use precise bounded codes.
  if (credential.deployment_state === "disabled") return { ok: false, status: 403, code: "deployment_disabled" };
  if (credential.deployment_state === "revoked") return { ok: false, status: 403, code: "deployment_revoked" };
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
  // Strict canonical validation of the accepted OCP-1A payload, shared with the
  // producer so semantics cannot drift. The signature proves who sent the bytes; this
  // proves the bytes are the accepted shape and carry no extra or prohibited content.
  const validation = validateOperatorTelemetryV1(envelope.payload);
  if (!validation.ok) {
    const oversized = validation.code === "payload_too_large";
    return { ok: false, status: oversized ? 413 : 400, code: `canonical_${validation.code}` };
  }
  // Full identity chain: credential -> envelope deployment -> telemetry deployment. A
  // valid credential must not submit an envelope for one deployment whose inner
  // telemetry claims another.
  if (validation.payload.deployment.deployment_id !== envelope.deployment_id)
    return { ok: false, status: 403, code: "deployment_identity_mismatch" };
  return { ok: true, deploymentId: envelope.deployment_id, internalId: credential.internal_id, credentialId: credential.id, envelope };
}

// Bounded audit retention. Pruning is deterministic (a single created_at predicate), can
// never remove a record newer than the configured cutoff, and is invoked only after a
// lifecycle mutation has committed, so a retention failure cannot corrupt lifecycle state.
export async function pruneFleetAudit(
  pool: pg.Pool,
  retentionMs: number,
  batchSize: number,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - retentionMs).toISOString();
  // One pass removes at most `batchSize` of the OLDEST eligible rows, so pruning can never
  // become an unexpectedly large single delete (lock and WAL burst) and can never touch a
  // row at or newer than the cutoff. Repeated passes converge.
  const deleted = await pool.query(
    `DELETE FROM fleet_audit WHERE id IN (
       SELECT id FROM fleet_audit WHERE created_at < $1 ORDER BY created_at ASC LIMIT $2
     )`,
    [cutoff, batchSize],
  );
  return deleted.rowCount ?? 0;
}

// Retention is best-effort and runs outside the lifecycle transaction, after it has
// committed, so a pruning failure can never roll back or corrupt a completed lifecycle
// mutation.
export async function pruneFleetAuditSafely(
  pool: pg.Pool,
  config: { auditRetentionMs: number; auditPruneBatch: number },
  hooks?: FleetHooks,
): Promise<number> {
  try {
    await hooks?.beforeAuditPrune?.();
    return await pruneFleetAudit(pool, config.auditRetentionMs, config.auditPruneBatch);
  } catch {
    return 0;
  }
}

export type FleetHooks = {
  // Test-only seams: force a failure at a precise point so rollback and error
  // classification can be proven deterministically. Production never sets them.
  beforeStatePersist?: () => void;
  beforeReplayInsert?: () => void;
  beforeLifecycleAudit?: () => void;
  // Awaited inside the audited lifecycle transaction, after the row lock is held, so a
  // concurrent transition can be raced deterministically in tests.
  duringLifecycleTransaction?: (context: { action: string; deploymentId: string | null }) => Promise<void>;
  beforeAuditPrune?: () => Promise<void> | void;
};

// Bounded client-facing lifecycle failures, so not-found and terminal-conflict results
// keep their intended status codes instead of becoming generic 503s.
function lifecycleError(status: number, code: string): Error {
  return Object.assign(new Error(code), { status, code, lifecycle: true });
}

function validation_payload(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function buildFleetService(
  pool: pg.Pool,
  config: FleetConfig,
  hooks?: FleetHooks,
  // Test-only seams: the default rules and limiter are the production ones.
  seams?: { rules?: typeof FLEET_RATE_LIMIT_RULES; limiter?: RateLimiter },
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: config.maxEnvelopeBytes + 1024 });

  // Rule lookup is per name and falls back to the production rule, so an incomplete rule
  // set (a test seam, or a future caller) can never leave a security control with an
  // undefined window and turn it into a server error.
  // Budgets come from validated configuration (see rate-limit.ts), so an operator can tune
  // them within safe bounds and an incomplete override can never leave a rule undefined.
  const ruleFor = (name: keyof typeof FLEET_RATE_LIMIT_RULES) => config.rateLimit.rules[name] ?? FLEET_RATE_LIMIT_RULES[name];
  const limiter = seams?.limiter ?? new RateLimiter(config.rateLimit.maxKeys);
  const clientOf = (r: any): string =>
    clientKey(
      (r.headers ?? {}) as Record<string, unknown>,
      r.socket?.remoteAddress ?? r.ip,
      config.rateLimit.trustedClientIpHeader,
      config.rateLimit.trustedClientIpHeader !== null,
    );
  // Returns false when the request was rejected, having already sent a bounded 429.
  const withinBudget = (r: any, reply: any, rule: { limit: number; windowMs: number }, prefix: string, now = Date.now()): boolean => {
    const decision = limiter.check(`${prefix}:${clientOf(r)}`, rule, now);
    if (decision.allowed) return true;
    reply.code(429).header("retry-after", String(decision.retryAfterSeconds)).send(rateLimitedBody());
    return false;
  };

  // The operator guard consumes a strict failure budget before answering 401 and a
  // generous read or mutation budget before serving, so a hostile client cannot hammer
  // authentication and cannot starve another client's budget.
  const operator = async (r: any, reply: any, mode: "read" | "mutation" = "read") => {
    const header = String(r.headers.authorization ?? "");
    const authorized = header.startsWith("Bearer ") && operatorTokenMatches(header.slice(7), config.operatorTokenHash);
    if (!authorized) {
      const perClient = withinBudget(r, reply, ruleFor("operatorAuthFailure"), "operator-auth-failure");
      if (!perClient) return false;
      if (!limiter.check("operator-auth-failure-global", ruleFor("operatorAuthFailureGlobal")).allowed) {
        reply.code(429).header("retry-after", "60").send(rateLimitedBody());
        return false;
      }
      reply.code(401).send({ error: "Fleet operator credential required" });
      return false;
    }
    const rule = mode === "mutation" ? ruleFor("operatorMutation") : ruleFor("operatorRead");
    return withinBudget(r, reply, rule, mode === "mutation" ? "operator-mutation" : "operator-read");
  };

  // Ingestion: the production OCP-1B receiver.
  app.post("/ingest", async (r, reply) => {
    // Abuse budget first, purely as a bound on volume. Every allowed request still goes
    // through the full verification chain below: size, versions, credential, binding,
    // timestamp, digest, signature, canonical payload and replay.
    if (!withinBudget(r, reply, ruleFor("ingestion"), "ingest")) return;
    const rawBody = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
    let envelope: TelemetryEnvelope | null = null;
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      envelope = null;
    }
    const credentialId = typeof (envelope as any)?.credential_id === "string" ? (envelope as any).credential_id : null;
    let credential: { id: string; deployment_id: string; internal_id: string; state: string; deployment_state: string; secret: string } | null = null;
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
            state: row.state,
            deployment_state: row.deployment_state,
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
    // The accepted ingestion is persisted atomically: replay insertion and pruning,
    // current-state upsert, deployment last-seen and version update, and history append
    // and pruning all commit together or not at all. A failure after the replay insert
    // therefore rolls the replay state back too, so the same valid envelope can be
    // retried successfully instead of being consumed as a phantom replay.
    const telemetry = validation_payload(verdict.envelope.payload);
    const client = await pool.connect();
    let replayConflict = false;
    try {
      await client.query("BEGIN");
      try {
        hooks?.beforeReplayInsert?.();
        await client.query(
          "INSERT INTO fleet_replay(credential_id,nonce,signature,seen_at) VALUES($1,$2,$3,now())",
          [verdict.credentialId, verdict.envelope.nonce, verdict.envelope.signature],
        );
      } catch (error: any) {
        // Only a genuine uniqueness violation on fleet_replay means "this nonce or
        // signature was already seen". Any other database error (transient failure,
        // connection loss, permission or disk problem, or a different constraint) must
        // not masquerade as a replay, because OCP-1B treats 409 as permanent and would
        // permanently drop telemetry that was never accepted.
        replayConflict = error?.code === "23505" && String(error?.constraint ?? "").includes("fleet_replay");
        throw error;
      }
      await client.query("DELETE FROM fleet_replay WHERE seen_at < now() - ($1||' milliseconds')::interval", [
        String(config.replayRetentionMs),
      ]);
      hooks?.beforeStatePersist?.();
      await client.query(
        `INSERT INTO deployment_current_state(deployment_id,updated_at,contract_version,envelope_version,telemetry)
         VALUES($1,now(),$2,$3,$4)
         ON CONFLICT (deployment_id) DO UPDATE SET updated_at=now(), contract_version=EXCLUDED.contract_version, envelope_version=EXCLUDED.envelope_version, telemetry=EXCLUDED.telemetry`,
        [verdict.internalId, verdict.envelope.contract, verdict.envelope.envelope, JSON.stringify(telemetry)],
      );
      // first_seen is recorded on the first accepted telemetry and never overwritten.
      // Absent values are preserved as unknown rather than coerced.
      await client.query(
        `UPDATE deployments SET first_seen=COALESCE(first_seen, now()), last_seen=now(),
           app_version=COALESCE($2,app_version), build_sha=COALESCE($3,build_sha),
           schema_version=COALESCE($4,schema_version), contract_version=$5 WHERE id=$1`,
        [
          verdict.internalId,
          telemetry?.source?.version ?? null,
          telemetry?.source?.build_sha ?? null,
          telemetry?.readiness?.schema_version ?? null,
          verdict.envelope.contract,
        ],
      );
      await client.query(
        "INSERT INTO deployment_state_history(id,deployment_id,observed_at,queue_state,backup_state,online_state) VALUES(gen_random_uuid(),$1,now(),$2,$3,$4)",
        [verdict.internalId, telemetry?.signals?.queue?.state ?? null, telemetry?.readiness?.backup_state ?? null, "online"],
      );
      await client.query(
        "DELETE FROM deployment_state_history WHERE id IN (SELECT id FROM deployment_state_history WHERE deployment_id=$1 ORDER BY observed_at DESC OFFSET $2)",
        [verdict.internalId, config.historyLimit],
      );
      await client.query("COMMIT");
      reply.code(202).send({ accepted: true });
      return { accepted: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (replayConflict) {
        await fleetAudit(pool, "ingestion.rejected", verdict.internalId, "replayed");
        reply.code(409).send({ error: "replayed" });
        return { error: "replayed" };
      }
      // Retryable: the transaction rolled back, including replay state.
      await fleetAudit(pool, "ingestion.failed", verdict.internalId, "persistence_failed");
      reply.code(503).send({ error: "persistence_failed" });
      return { error: "persistence_failed" };
    } finally {
      client.release();
    }
  });

  // Read-only operator APIs. These form the OCP-2B contract; there are deliberately
  // no mutation or remote-execution endpoints.
  app.get("/deployments", async (r, reply) => {
    if (!(await operator(r, reply, "mutation"))) return;
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

  // Security-sensitive control-plane mutations are audit-required: the state change and
  // its audit record commit together or roll back together, so a lifecycle transition
  // can never happen unaudited. Fail-soft auditing (fleetAudit) remains in place for
  // observational paths such as rejected ingestion, where audit failure must not take
  // down ingestion.
  const LIFECYCLE_AUDIT_ACTION = /^(deployment\.[a-z_]+|credential\.[a-z_]+)$/;
  async function auditedLifecycleMutation<T>(
    action: string,
    deploymentId: string | null | ((result: T) => string | null),
    detail: string | null,
    mutate: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!LIFECYCLE_AUDIT_ACTION.test(action)) throw new Error(`Unbounded lifecycle audit action: ${action}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await mutate(client);
      const target = typeof deploymentId === "function" ? deploymentId(result) : deploymentId;
      await hooks?.duringLifecycleTransaction?.({ action, deploymentId: target });
      hooks?.beforeLifecycleAudit?.();
      await client.query("INSERT INTO fleet_audit(id,action,deployment_id,detail) VALUES(gen_random_uuid(),$1,$2,$3)", [
        action,
        target,
        detail ? String(detail).slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, "") : null,
      ]);
      await client.query("COMMIT");
      // Retention runs after the commit, just past the transaction, so a pruning failure can
      // never roll back or corrupt the lifecycle mutation that just succeeded.
      await pruneFleetAuditSafely(pool, config, hooks);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- operator-plane lifecycle ----
  // Real service capabilities rather than tests seeding tables. Operator-authorized,
  // audited, and with no dependency on customer Workspace admin surfaces or remote
  // Workspace command execution. No secret is ever returned except once, at issuance
  // or rotation, so Workspace can be provisioned.
  const lifecycleStateFor = (requested: unknown): "active" | "disabled" | "revoked" | null => {
    if (requested === "enabled") return "active";
    if (requested === "disabled" || requested === "active" || requested === "revoked") return requested;
    return null;
  };
  const newSecret = () => randomBytes(32).toString("base64url"); // 256 bits of entropy

  app.post("/deployments", async (r, reply) => {
    if (!(await operator(r, reply))) return;
    const body = (r.body ?? {}) as any;
    const workspaceId = typeof body.workspace_deployment_id === "string" ? body.workspace_deployment_id.trim() : "";
    if (!isCanonicalDeploymentId(workspaceId)) {
      reply.code(400).send({ error: "invalid_workspace_deployment_id" });
      return { error: "invalid_workspace_deployment_id" };
    }
    const alias = typeof body.alias === "string" ? body.alias.slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, "") : null;
    try {
      // Registration is not applied if its required audit record cannot commit.
      const row = await auditedLifecycleMutation(
        "deployment.registered",
        (created: any) => created.id,
        null,
        async (client) =>
          (
            await client.query(
              "INSERT INTO deployments(workspace_deployment_id,alias,state) VALUES($1,$2,'active') RETURNING id,workspace_deployment_id,alias,state",
              [workspaceId, alias],
            )
          ).rows[0],
      );
      reply.code(201).send(row);
      return row;
    } catch (error: any) {
      // A duplicate is a client error; anything else is a bounded server failure, and
      // nothing (including the audit record) survives the rollback.
      const exists = error?.code === "23505";
      reply.code(exists ? 409 : 503).send({ error: exists ? "deployment_exists" : "lifecycle_failed" });
      return { error: exists ? "deployment_exists" : "lifecycle_failed" };
    }
  });

  app.post("/deployments/:id/credentials", async (r, reply) => {
    if (!(await operator(r, reply, "mutation"))) return;
    const id = String((r.params as any).id);
    const credentialId = randomUUID();
    let secret = "";
    try {
      // The deployment-state check, the credential insert and the required issuance
      // audit are one transaction, under the deployment row lock. Issuance for a
      // terminally revoked deployment is refused; issuance while disabled stays
      // permitted so a deployment can be provisioned before it is enabled.
      await auditedLifecycleMutation("credential.issued", id, credentialId, async (client) => {
        const locked = await client.query("SELECT state FROM deployments WHERE id=$1 FOR UPDATE", [id]);
        if (!locked.rowCount) throw lifecycleError(404, "deployment_not_found");
        if (locked.rows[0].state === "revoked") throw lifecycleError(409, "deployment_revoked");
        secret = newSecret();
        await client.query(
          "INSERT INTO deployment_credentials(id,deployment_id,secret_encrypted,state) VALUES($1,$2,$3,'active')",
          [credentialId, id, sealCredentialSecret(secret, credentialId, config.encryptionKey)],
        );
      });
    } catch (error: any) {
      const status = error?.lifecycle === true ? error.status : 503;
      reply.code(status).send({ error: status === 503 ? "lifecycle_failed" : error.code });
      return { error: status === 503 ? "lifecycle_failed" : error.code };
    }
    // The only point at which a secret leaves the service, and only for provisioning.
    reply.code(201).send({ credential_id: credentialId, deployment_id: id, secret });
    return { credential_id: credentialId };
  });

  app.post("/deployments/:id/credentials/:credentialId/rotate", async (r, reply) => {
    if (!(await operator(r, reply, "mutation"))) return;
    const { id, credentialId } = r.params as any;
    let secret = "";
    try {
      // The active check, the secret replacement and the required audit are one
      // transaction. A revoked credential stays revoked and is never handed fresh but
      // unusable secret material, and the secret is not changed when the audit cannot
      // commit.
      await auditedLifecycleMutation("credential.rotated", id, credentialId, async (client) => {
        // Lock the parent deployment first, then the credential: the same order issuance
        // uses, so there is no deadlock-prone inversion. If terminal revocation has already
        // won, rotation must not return newly usable secret material, so a revoked
        // deployment is refused here rather than only at the credential.
        const deployment = await client.query("SELECT state FROM deployments WHERE id=$1 FOR UPDATE", [id]);
        if (!deployment.rowCount) throw lifecycleError(404, "deployment_not_found");
        if (deployment.rows[0].state === "revoked") throw lifecycleError(409, "deployment_revoked");
        const locked = await client.query(
          "SELECT state FROM deployment_credentials WHERE id=$1 AND deployment_id=$2 FOR UPDATE",
          [credentialId, id],
        );
        if (!locked.rowCount) throw lifecycleError(404, "credential_not_found");
        if (locked.rows[0].state !== "active") throw lifecycleError(409, "credential_not_active");
        secret = newSecret();
        await client.query("UPDATE deployment_credentials SET secret_encrypted=$2, rotated_at=now() WHERE id=$1", [
          credentialId,
          sealCredentialSecret(secret, credentialId, config.encryptionKey),
        ]);
      });
    } catch (error: any) {
      const status = error?.lifecycle === true ? error.status : 503;
      reply.code(status).send({ error: status === 503 ? "lifecycle_failed" : error.code });
      return { error: status === 503 ? "lifecycle_failed" : error.code };
    }
    reply.code(200).send({ credential_id: credentialId, deployment_id: id, secret });
    return { credential_id: credentialId };
  });

  app.post("/deployments/:id/credentials/:credentialId/revoke", async (r, reply) => {
    if (!(await operator(r, reply, "mutation"))) return;
    const { id, credentialId } = r.params as any;
    try {
      // A credential is never revoked silently: revocation and its audit commit
      // together or neither is applied.
      const revoked = await auditedLifecycleMutation("credential.revoked", id, credentialId, async (client) => {
        const rows = await client.query(
          "UPDATE deployment_credentials SET state='revoked', revoked_at=now() WHERE id=$1 AND deployment_id=$2 AND state='active' RETURNING id",
          [credentialId, id],
        );
        if (!rows.rowCount) throw Object.assign(new Error("credential_not_active"), { clientError: true });
        return rows.rows[0];
      });
      reply.code(200).send({ credential_id: revoked.id, state: "revoked" });
      return { credential_id: revoked.id, state: "revoked" };
    } catch (error: any) {
      const notActive = error?.clientError === true;
      reply.code(notActive ? 404 : 503).send({ error: notActive ? "credential_not_active" : "lifecycle_failed" });
      return { error: notActive ? "credential_not_active" : "lifecycle_failed" };
    }
  });

  app.post("/deployments/:id/lifecycle", async (r, reply) => {
    if (!(await operator(r, reply, "mutation"))) return;
    const id = String((r.params as any).id);
    const target = lifecycleStateFor(((r.body ?? {}) as any).state);
    if (!target) {
      reply.code(400).send({ error: "invalid_state" });
      return { error: "invalid_state" };
    }
    const action = target === "active" ? "deployment.enabled" : target === "disabled" ? "deployment.disabled" : "deployment.revoked";
    try {
      // State inspection, the terminal-revocation decision, the mutation and the
      // required audit are ONE serialized transaction, and the row is locked with
      // SELECT ... FOR UPDATE before the decision. A stale pre-transaction read is never
      // used to authorize a transition, so a concurrent enable cannot overtake a
      // revocation and silently undo it.
      await auditedLifecycleMutation(action, id, null, async (client) => {
        const locked = await client.query("SELECT state FROM deployments WHERE id=$1 FOR UPDATE", [id]);
        if (!locked.rowCount) throw lifecycleError(404, "deployment_not_found");
        const current = locked.rows[0].state as string;
        // Revocation is terminal: a revoked deployment cannot be moved back to active.
        // Disable and re-enable remain reversible.
        if (current === "revoked" && target !== "revoked") throw lifecycleError(409, "deployment_revocation_terminal");
        if (current !== target) await client.query("UPDATE deployments SET state=$2 WHERE id=$1", [id, target]);
      });
    } catch (error: any) {
      const status = error?.lifecycle === true ? error.status : 503;
      // Rejected transitions are recorded fail-soft, like rejected ingestion; the
      // transactional audit above already covers every applied transition.
      if (status === 409) await fleetAudit(pool, "deployment.lifecycle_rejected", id, "revocation_terminal");
      reply.code(status).send({ error: status === 503 ? "lifecycle_failed" : error.code });
      return { error: status === 503 ? "lifecycle_failed" : error.code };
    }
    reply.code(200).send({ id, state: target });
    return { id, state: target };
  });

  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
