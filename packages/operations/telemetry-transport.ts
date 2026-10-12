// OCP-1B: authenticated outbound telemetry transport, replay protection and
// bounded offline delivery.
//
// This module is transport infrastructure only. It consumes the canonical OCP-1A
// serialization, wraps it in a small versioned signed envelope, delivers it over
// trusted TLS with a per-deployment credential, and buffers work in a bounded
// local spool. It never reconstructs telemetry, never bypasses the OCP-1A
// prohibition scan, and never lets transport state affect Workspace product
// operation.
//
// Signing reuses the repository primitive packages/events signature(secret, time,
// body) = HMAC-SHA-256 over `${time}.${body}`, so no new cryptographic scheme is
// introduced and the receiver contract stays implementable later.

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { signature } from "../events/index.ts";
import {
  OPERATOR_TELEMETRY_SCHEMA,
  OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS,
} from "./operator-telemetry.ts";

export const TELEMETRY_ENVELOPE_VERSION = "openjm.workspace.telemetry-envelope.v1";
export const TELEMETRY_ENVELOPE_SUPPORTED = [TELEMETRY_ENVELOPE_VERSION];

export type TelemetryTransportConfig = {
  enabled: boolean;
  endpoint: string | null;
  endpointOrigin: string | null;
  credentialId: string | null;
  secret: string | null;
  intervalMs: number;
  requestTimeoutMs: number;
  spoolPath: string;
  spoolMaxItems: number;
  spoolMaxBytes: number;
  spoolMaxAgeMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
};

export type ConfigIssue = { setting: string; problem: string };

const bounded = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
};

// Fail-closed configuration. With telemetry disabled, no endpoint and no credential
// are required and the deployment boots exactly as before.
export function telemetryTransportConfig(env: Record<string, string | undefined>) {
  const enabled = String(env.OPERATOR_TELEMETRY_ENABLED ?? "").toLowerCase() === "true";
  const issues: ConfigIssue[] = [];
  const rawEndpoint = (env.OPERATOR_TELEMETRY_ENDPOINT ?? "").trim();
  const credentialId = (env.OPERATOR_TELEMETRY_CREDENTIAL_ID ?? "").trim() || null;
  const secret = env.OPERATOR_TELEMETRY_SECRET ?? null;

  let endpoint: string | null = null;
  let endpointOrigin: string | null = null;
  if (rawEndpoint) {
    try {
      const url = new URL(rawEndpoint);
      endpointOrigin = url.origin;
      if (url.protocol !== "https:") issues.push({ setting: "OPERATOR_TELEMETRY_ENDPOINT", problem: "scheme must be https" });
      else if (url.username || url.password) issues.push({ setting: "OPERATOR_TELEMETRY_ENDPOINT", problem: "credentials in URL are not allowed" });
      else if (url.search) issues.push({ setting: "OPERATOR_TELEMETRY_ENDPOINT", problem: "query string is not allowed" });
      else if (url.hash) issues.push({ setting: "OPERATOR_TELEMETRY_ENDPOINT", problem: "fragment is not allowed" });
      else endpoint = url.toString();
    } catch {
      issues.push({ setting: "OPERATOR_TELEMETRY_ENDPOINT", problem: "not a valid absolute URL" });
    }
  }
  if (enabled && !rawEndpoint) issues.push({ setting: "OPERATOR_TELEMETRY_ENDPOINT", problem: "required when telemetry is enabled" });
  if (enabled && !credentialId) issues.push({ setting: "OPERATOR_TELEMETRY_CREDENTIAL_ID", problem: "required when telemetry is enabled" });
  else if (credentialId && !/^[A-Za-z0-9._-]{1,64}$/.test(credentialId)) issues.push({ setting: "OPERATOR_TELEMETRY_CREDENTIAL_ID", problem: "must match [A-Za-z0-9._-]{1,64}" });
  if (enabled && (!secret || secret.length < 32)) issues.push({ setting: "OPERATOR_TELEMETRY_SECRET", problem: "required and at least 32 characters when telemetry is enabled" });

  const config: TelemetryTransportConfig = {
    enabled,
    endpoint,
    endpointOrigin,
    credentialId,
    secret,
    intervalMs: bounded(env.OPERATOR_TELEMETRY_INTERVAL_MS, 300_000, 5_000, 86_400_000),
    requestTimeoutMs: bounded(env.OPERATOR_TELEMETRY_TIMEOUT_MS, 10_000, 1_000, 60_000),
    spoolPath: (env.OPERATOR_TELEMETRY_SPOOL_PATH ?? ".data/operator-telemetry/spool.jsonl").trim(),
    spoolMaxItems: bounded(env.OPERATOR_TELEMETRY_SPOOL_MAX_ITEMS, 32, 1, 1_000),
    spoolMaxBytes: bounded(env.OPERATOR_TELEMETRY_SPOOL_MAX_BYTES, 262_144, 4_096, 8_388_608),
    spoolMaxAgeMs: bounded(env.OPERATOR_TELEMETRY_SPOOL_MAX_AGE_MS, 86_400_000, 60_000, 2_592_000_000),
    backoffBaseMs: bounded(env.OPERATOR_TELEMETRY_BACKOFF_BASE_MS, 5_000, 1_000, 3_600_000),
    backoffMaxMs: bounded(env.OPERATOR_TELEMETRY_BACKOFF_MAX_MS, 3_600_000, 1_000, 86_400_000),
  };
  if (config.backoffMaxMs < config.backoffBaseMs) issues.push({ setting: "OPERATOR_TELEMETRY_BACKOFF_MAX_MS", problem: "must be >= the backoff base" });
  return { config, issues, ok: issues.length === 0 };
}

// ---------------------------------------------------------------------------
// Signed transport envelope.
// ---------------------------------------------------------------------------

export type TelemetryEnvelope = {
  envelope: string;
  contract: string;
  deployment_id: string;
  credential_id: string;
  generated_at: string;
  nonce: string;
  payload_digest: string;
  payload: string;
  signature: string;
};

export function payloadDigest(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

// The exact bytes signed. Every field a receiver must not be able to change is
// included, so mutating any one of them invalidates the signature.
export function signingInput(envelope: Omit<TelemetryEnvelope, "signature">): string {
  return [
    envelope.envelope,
    envelope.contract,
    envelope.deployment_id,
    envelope.credential_id,
    envelope.generated_at,
    envelope.nonce,
    envelope.payload_digest,
    envelope.payload,
  ].join("\n");
}

export function buildEnvelope(input: {
  deploymentId: string;
  credentialId: string;
  secret: string;
  payload: string;
  now?: Date;
  nonce?: string;
}): TelemetryEnvelope {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const base = {
    envelope: TELEMETRY_ENVELOPE_VERSION,
    contract: OPERATOR_TELEMETRY_SCHEMA,
    deployment_id: input.deploymentId,
    credential_id: input.credentialId,
    generated_at: generatedAt,
    nonce: input.nonce ?? randomUUID(),
    payload_digest: payloadDigest(input.payload),
    payload: input.payload,
  };
  return { ...base, signature: signature(input.secret, generatedAt, signingInput(base)) };
}

export function verifyEnvelopeSignature(envelope: TelemetryEnvelope, secret: string): boolean {
  if (!TELEMETRY_ENVELOPE_SUPPORTED.includes(envelope.envelope)) return false;
  if (!OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS.includes(envelope.contract)) return false;
  if (payloadDigest(envelope.payload) !== envelope.payload_digest) return false;
  const { signature: provided, ...base } = envelope;
  return signature(secret, envelope.generated_at, signingInput(base)) === provided;
}

// ---------------------------------------------------------------------------
// Receiver-side acceptance contract (implemented as a deterministic test
// receiver here; OCP-2 ingestion must implement the same semantics).
// ---------------------------------------------------------------------------

export type ReceiverOutcome = {
  status: number;
  code:
    | "accepted"
    | "malformed"
    | "unsupported_version"
    | "unknown_credential"
    | "revoked_credential"
    | "timestamp_out_of_window"
    | "replayed"
    | "invalid_signature"
    | "payload_too_large";
};

export class TestTelemetryReceiver {
  private readonly nonces = new Map<string, number>();
  private readonly seenSignatures = new Set<string>();
  readonly accepted: string[] = [];
  constructor(
    private readonly options: {
      secrets: Record<string, string>;
      revoked?: string[];
      skewMs?: number;
      maxTracked?: number;
      maxBodyBytes?: number;
      now?: () => number;
    },
  ) {}

  private prune(now: number) {
    const horizon = now - (this.options.skewMs ?? 120_000) * 4;
    for (const [nonce, at] of this.nonces) if (at < horizon) this.nonces.delete(nonce);
    const max = this.options.maxTracked ?? 256;
    while (this.nonces.size > max) {
      const oldest = [...this.nonces.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      this.nonces.delete(oldest[0]);
    }
  }

  handle(rawBody: string): ReceiverOutcome {
    const now = this.options.now?.() ?? Date.now();
    if (rawBody.length > (this.options.maxBodyBytes ?? 131_072))
      return { status: 413, code: "payload_too_large" };
    let envelope: TelemetryEnvelope;
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      return { status: 400, code: "malformed" };
    }
    if (!TELEMETRY_ENVELOPE_SUPPORTED.includes(envelope?.envelope))
      return { status: 400, code: "unsupported_version" };
    const secret = this.options.secrets[envelope.credential_id];
    if (!secret) return { status: 401, code: "unknown_credential" };
    if ((this.options.revoked ?? []).includes(envelope.credential_id))
      return { status: 403, code: "revoked_credential" };
    if (!verifyEnvelopeSignature(envelope, secret))
      return { status: 401, code: "invalid_signature" };
    const skew = Math.abs(now - Date.parse(envelope.generated_at));
    if (!Number.isFinite(skew) || skew > (this.options.skewMs ?? 120_000))
      return { status: 408, code: "timestamp_out_of_window" };
    this.prune(now);
    if (this.nonces.has(envelope.nonce) || this.seenSignatures.has(envelope.signature))
      return { status: 409, code: "replayed" };
    this.nonces.set(envelope.nonce, now);
    this.seenSignatures.add(envelope.signature);
    this.accepted.push(envelope.nonce);
    return { status: 200, code: "accepted" };
  }
}

// ---------------------------------------------------------------------------
// Bounded offline spool. Telemetry snapshots describe current state, so the policy
// is newest-state-first with deterministic FIFO eviction, not unbounded history.
// ---------------------------------------------------------------------------

export type SpoolStats = { items: number; bytes: number; evicted: number; droppedCorrupt: number };

export class BoundedSpool {
  private readonly entries: { id: string; at: number; body: string }[] = [];
  private evicted = 0;
  private droppedCorrupt = 0;
  constructor(
    private readonly options: {
      path: string;
      maxItems: number;
      maxBytes: number;
      maxAgeMs: number;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private bytes() {
    return this.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.body, "utf8"), 0);
  }

  // Fail-soft on corruption: unreadable or malformed content is discarded rather
  // than propagated, and a corrupt file can never stop the exporter.
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.options.path, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.body === "string" && typeof parsed?.id === "string")
            this.entries.push({ id: parsed.id, at: Number(parsed.at) || this.now(), body: parsed.body });
          else this.droppedCorrupt += 1;
        } catch {
          this.droppedCorrupt += 1;
        }
      }
    } catch {
      // Absent or unreadable spool is not an error.
    }
    this.expire();
  }

  expire(): number {
    const horizon = this.now() - this.options.maxAgeMs;
    const before = this.entries.length;
    for (let i = this.entries.length - 1; i >= 0; i -= 1)
      if (this.entries[i].at < horizon) this.entries.splice(i, 1);
    this.evicted += before - this.entries.length;
    return before - this.entries.length;
  }

  async add(body: string): Promise<void> {
    this.entries.push({ id: randomUUID(), at: this.now(), body });
    this.expire();
    // Deterministic eviction: oldest first by age, then by insertion order when the
    // count or byte ceiling is exceeded, so the newest state is never blocked behind
    // stale snapshots.
    while (
      this.entries.length > this.options.maxItems ||
      (this.bytes() > this.options.maxBytes && this.entries.length > 1)
    ) {
      this.entries.shift();
      this.evicted += 1;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      const tmp = `${this.options.path}.tmp`;
      await writeFile(tmp, this.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      await rename(tmp, this.options.path);
    } catch {
      // Spool write failure is fail-soft: transport is never allowed to stop product
      // operation, and the in-memory copy still bounds memory use.
    }
  }

  peek(): { id: string; body: string } | null {
    const first = this.entries[0];
    return first ? { id: first.id, body: first.body } : null;
  }

  async ack(id: string): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index >= 0) this.entries.splice(index, 1);
    await this.persist();
  }

  stats(): SpoolStats {
    return { items: this.entries.length, bytes: this.bytes(), evicted: this.evicted, droppedCorrupt: this.droppedCorrupt };
  }
}

// ---------------------------------------------------------------------------
// Retry classification and bounded backoff.
// ---------------------------------------------------------------------------

export type DeliveryOutcome = "delivered" | "retryable" | "permanent";

export function classifyResponse(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  // 400 malformed, 401 unknown/invalid credential, 403 revoked, 404 endpoint,
  // 409 replay, 413 too large, 422 semantic: operator action, never retried forever.
  return "permanent";
}

export function backoffDelay(attempt: number, options: { baseMs: number; maxMs: number; jitter?: () => number }): number {
  const exponential = Math.min(options.baseMs * 2 ** Math.max(0, attempt - 1), options.maxMs);
  const jitter = options.jitter ? options.jitter() : 0.5;
  return Math.round(exponential * (0.5 + Math.min(Math.max(jitter, 0), 1) * 0.5));
}

export type FailureCategory =
  | "none"
  | "configuration"
  | "tls"
  | "network"
  | "timeout"
  | "retryable_response"
  | "rate_limited"
  | "permanent_response"
  | "authentication"
  | "spool";

export type TelemetryTransportStatus = {
  enabled: boolean;
  envelope_version: string;
  contract_version: string;
  credential_id: string | null;
  endpoint_origin: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_failure_category: FailureCategory;
  consecutive_failures: number;
  backoff_until: string | null;
  spool_items: number;
  spool_bytes: number;
  spool_evicted: number;
};

export function classifyFailure(error: unknown, status?: number): FailureCategory {
  if (status !== undefined) {
    if (status === 429) return "rate_limited";
    if (status === 401 || status === 403) return "authentication";
    if (status >= 500 || status === 408) return "retryable_response";
    return "permanent_response";
  }
  // Node's fetch reports a generic "fetch failed" and carries the real reason in
  // the cause chain, so TLS and timeout detail must be read from there.
  const message =
    error instanceof Error
      ? `${error.name} ${error.message} ${(error as { cause?: unknown }).cause ? String((error as { cause?: unknown }).cause) : ""}`
      : String(error);
  if (/certificate|tls|ssl|self.signed|altname/i.test(message)) return "tls";
  if (/timeout|aborted|timed out/i.test(message)) return "timeout";
  return "network";
}

// ---------------------------------------------------------------------------
// Exporter. Observational by construction: one timer, complete error containment,
// its own failure counter, and no shared state with product jobs.
// ---------------------------------------------------------------------------

export function startTelemetryExporter(options: {
  config: TelemetryTransportConfig;
  deploymentId: string;
  payloadProvider: () => Promise<string | null>;
  spool: BoundedSpool;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  statusPath?: string;
}): { stop: () => Promise<void>; status: () => TelemetryTransportStatus; runOnce: () => Promise<DeliveryOutcome | "skipped"> } {
  const now = () => options.now?.() ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let consecutiveFailures = 0;
  let backoffUntil = 0;
  let lastAttemptAt: string | null = null;
  let lastSuccessAt: string | null = null;
  let lastFailureCategory: FailureCategory = "none";

  const status = (): TelemetryTransportStatus => {
    const stats = options.spool.stats();
    return {
      enabled: options.config.enabled,
      envelope_version: TELEMETRY_ENVELOPE_VERSION,
      contract_version: OPERATOR_TELEMETRY_SCHEMA,
      // Never the secret, and never an authorization header.
      credential_id: options.config.credentialId,
      endpoint_origin: options.config.endpointOrigin,
      last_attempt_at: lastAttemptAt,
      last_success_at: lastSuccessAt,
      last_failure_category: lastFailureCategory,
      consecutive_failures: consecutiveFailures,
      backoff_until: backoffUntil ? new Date(backoffUntil).toISOString() : null,
      spool_items: stats.items,
      spool_bytes: stats.bytes,
      spool_evicted: stats.evicted,
    };
  };

  // Awaited at each call site so the persisted status is never read before it is
  // written. Fail-soft: status reporting never affects delivery or product operation.
  const persistStatus = async (): Promise<void> => {
    const path = options.statusPath;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      // Bounded and secret-free by construction: this is exactly the status model.
      await writeFile(path, JSON.stringify(status()), "utf8");
    } catch {
      // Fail-soft.
    }
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce()
        .catch(() => "skipped" as const)
        .finally(() => schedule(0));
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  const record = (category: FailureCategory) => {
    lastFailureCategory = category;
    consecutiveFailures += 1;
    const delay = backoffDelay(consecutiveFailures, {
      baseMs: options.config.backoffBaseMs,
      maxMs: options.config.backoffMaxMs,
    });
    backoffUntil = now() + delay;
    options.log?.("telemetry.delivery.failed", { category, delay_ms: delay });
  };

  async function runOnce(): Promise<DeliveryOutcome | "skipped"> {
    if (stopped || !options.config.enabled) return "skipped";
    await persistStatus();
    if (now() < backoffUntil) return "skipped";
    if (!options.config.endpoint || !options.config.credentialId || !options.config.secret) {
      lastFailureCategory = "configuration";
      return "skipped";
    }
    lastAttemptAt = new Date(now()).toISOString();
    try {
      // Refresh with the current canonical snapshot, which supersedes stale state.
      const payload = await options.payloadProvider().catch(() => null);
      if (payload) await options.spool.add(payload);
      options.spool.expire();
      const next = options.spool.peek();
      if (!next) {
        consecutiveFailures = 0;
        backoffUntil = 0;
        return "skipped";
      }
      const envelope = buildEnvelope({
        deploymentId: options.deploymentId,
        credentialId: options.config.credentialId,
        secret: options.config.secret,
        payload: next.body,
        now: new Date(now()),
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.config.requestTimeoutMs);
      let status = 0;
      try {
        const response = await fetchImpl(options.config.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-workspace-credential": envelope.credential_id,
            "x-workspace-envelope": envelope.envelope,
          },
          body: JSON.stringify(envelope),
          redirect: "error",
          signal: controller.signal,
        });
        status = response.status;
        // Bounded response handling: the body is never used, only the status.
        await response.arrayBuffer().catch(() => undefined);
      } finally {
        clearTimeout(timeout);
      }
      const outcome = classifyResponse(status);
      if (outcome === "delivered") {
        await options.spool.ack(next.id);
        consecutiveFailures = 0;
        backoffUntil = 0;
        lastSuccessAt = new Date(now()).toISOString();
        lastFailureCategory = "none";
        options.log?.("telemetry.delivery.succeeded");
        await persistStatus();
        return "delivered";
      }
      const category = classifyFailure(undefined, status);
      record(category);
      await persistStatus();
      if (outcome === "permanent") {
        // Operator action is required: do not retry a malformed or rejected payload
        // forever. The item is dropped so bounded retention still applies.
        await options.spool.ack(next.id);
      }
      return outcome;
    } catch (error) {
      record(classifyFailure(error));
      await persistStatus();
      return "retryable";
    }
  }

  if (options.config.enabled) schedule(options.config.intervalMs);
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    status,
    runOnce,
  };
}

// Read the worker-persisted transport status. Fail-soft: an absent or corrupt file
// yields null and the caller reports configuration-derived state instead.
export async function readTelemetryTransportStatus(
  path: string,
): Promise<TelemetryTransportStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    // Never surface unknown extra keys: the status shape is rebuilt explicitly.
    return {
      enabled: parsed.enabled === true,
      envelope_version: String(parsed.envelope_version ?? TELEMETRY_ENVELOPE_VERSION),
      contract_version: String(parsed.contract_version ?? OPERATOR_TELEMETRY_SCHEMA),
      credential_id: typeof parsed.credential_id === "string" ? parsed.credential_id : null,
      endpoint_origin: typeof parsed.endpoint_origin === "string" ? parsed.endpoint_origin : null,
      last_attempt_at: typeof parsed.last_attempt_at === "string" ? parsed.last_attempt_at : null,
      last_success_at: typeof parsed.last_success_at === "string" ? parsed.last_success_at : null,
      last_failure_category: typeof parsed.last_failure_category === "string" ? parsed.last_failure_category : "none",
      consecutive_failures: Number.isFinite(parsed.consecutive_failures) ? Number(parsed.consecutive_failures) : 0,
      backoff_until: typeof parsed.backoff_until === "string" ? parsed.backoff_until : null,
      spool_items: Number.isFinite(parsed.spool_items) ? Number(parsed.spool_items) : 0,
      spool_bytes: Number.isFinite(parsed.spool_bytes) ? Number(parsed.spool_bytes) : 0,
      spool_evicted: Number.isFinite(parsed.spool_evicted) ? Number(parsed.spool_evicted) : 0,
    };
  } catch {
    return null;
  }
}
