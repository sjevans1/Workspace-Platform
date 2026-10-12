// OCP-1A: the application-facing operator telemetry contract.
//
// This module defines what privacy-safe operational state Workspace is willing to
// expose to a future OpenJM operator plane, in a stable versioned format, without
// making that operator plane a runtime dependency.
//
// Principles enforced here rather than by convention:
// - observation only: composing telemetry never mutates customer data and never
//   sits on the normal request path required for Workspace functionality;
// - fail soft: unavailable sources become explicit "unknown", never an error;
// - bounded: fixed caps on counts, string lengths, array sizes and payload size;
// - privacy by construction: a machine-checked allowlist plus a prohibition scan
//   over the serialized output, not just the in-memory model;
// - portability: no OpenTelemetry, Loki, Grafana or other infrastructure stack.

import { createHash } from "node:crypto";

export const OPERATOR_TELEMETRY_SCHEMA = "openjm.workspace.operator-telemetry.v1";

// Version negotiation. Unknown versions are never silently interpreted as v1.
export const OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS = [OPERATOR_TELEMETRY_SCHEMA];

export type HealthState = "healthy" | "degraded" | "unhealthy" | "unknown";

export const OPERATOR_TELEMETRY_LIMITS = {
  maxEvents: 12,
  maxServices: 12,
  maxStatusClasses: 6,
  maxServiceValues: 8,
  maxStringLength: 96,
  maxAliasLength: 64,
  maxDeploymentIdLength: 64,
  maxPayloadBytes: 16384,
} as const;

export type OperatorTelemetryV1 = {
  schema: string;
  generated_at: string;
  sequence: number;
  source: {
    application: string;
    version: string;
    build_sha: string | null;
  };
  deployment: {
    deployment_id: string;
    alias: string | null;
    version: string;
    build_sha: string | null;
    release_channel: string;
    environment: string | null;
    region: string | null;
  };
  runtime: {
    uptime_seconds: number;
    overall: HealthState;
    api: HealthState;
    worker: HealthState;
    collaboration: HealthState;
    database: HealthState;
    redis: HealthState;
    storage: HealthState;
    antivirus: HealthState;
  };
  signals: {
    requests: { total: number; by_status_class: StatusClassCount[] };
    errors: { total: number; by_status_class: StatusClassCount[] };
    latency: { samples: number; total_seconds: number; max_seconds: number };
    services: TelemetryService[];
    queue: { depth: number | null; state: HealthState };
    capacity: { storage: number | null; database: number | null };
  };
  readiness: {
    last_backup_at: string | null;
    backup_state: HealthState;
    schema_version: string | null;
    upgrade_ready: boolean | null;
    tls: HealthState;
    profiles: { identity: string | null; storage: string | null };
  };
  events: { category: string; count: number }[];
};

export type StatusClassCount = { status_class: string; count: number };
export type TelemetryService = {
  name: string;
  state: HealthState;
  configured: boolean;
  values: { name: string; value: number | null }[];
};

// Sources the composition service reads. Every field is optional so that a missing
// or failing source degrades to "unknown" instead of breaking composition.
export type OperatorTelemetrySources = {
  application: string;
  version: string;
  buildSha?: string | null;
  deploymentIdSeed: string;
  alias?: string | null;
  releaseChannel?: string | null;
  environment?: string | null;
  region?: string | null;
  startedAt?: number | null;
  now?: Date;
  sequence?: number;
  dependencies?: Record<string, boolean>;
  overallHealthy?: boolean | null;
  readinessKnown?: boolean;
  services?: Record<
    string,
    | { healthy: boolean; configured?: true; values?: Record<string, number | null> }
    | { configured: false }
  >;
  http?: { method: string; statusClass: string; count: number; durationSeconds: number }[];
  antivirus?: { clean: number; infected: number; error: number } | null;
  queueDepth?: number | null;
  // OCP-1 source enrichment: an explicitly supplied factual queue state. Internal
  // input only; the serialized wire shape is unchanged.
  queueState?: HealthState;
  storageCapacity?: number | null;
  databaseCapacity?: number | null;
  lastBackupAt?: string | null;
  backupVerified?: boolean | null;
  schemaVersion?: string | null;
  upgradeReady?: boolean | null;
  tlsHealthy?: boolean | null;
  identityProfile?: string | null;
  storageProfile?: string | null;
  events?: { category: string; count: number }[];
};

const boundedInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : Math.floor(value);
};

// Strings entering the contract are sanitized: control characters removed, length
// bounded, and any URL reduced to scheme+host so query strings and customer
// identifiers cannot ride along.
export function sanitizeText(value: unknown, max: number = OPERATOR_TELEMETRY_LIMITS.maxStringLength): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    try {
      const url = new URL(text);
      text = `${url.protocol}//${url.host}`;
    } catch {
      return null;
    }
  }
  const bounded = text.slice(0, max);
  // Privacy by construction: a value that carries prohibited content is dropped
  // rather than forwarded, so a hostile source cannot make composition fatal.
  if (PROHIBITED_PATTERNS.some((entry) => entry.pattern.test(bounded))) return null;
  return bounded;
}

// Categories are allowlisted, so no user-generated string can become a label.
export function sanitizeCategory(value: unknown): string | null {
  const text = sanitizeText(value, 48);
  if (!text) return null;
  return /^[a-z][a-z0-9._:-]{0,47}$/.test(text) ? text : null;
}

export function sanitizeServiceName(value: unknown): string | null {
  const text = sanitizeText(value, 32);
  if (!text) return null;
  return /^[a-z][a-z0-9._-]{0,31}$/.test(text) ? text : null;
}

// A stable, opaque deployment identifier. It is a digest, so the seed (which may be
// an operator-supplied value) never appears in the payload, and it deliberately
// contains no customer name, tenant id, hostname or email.
export function deploymentIdFrom(seed: string): string {
  return "ws-" + createHash("sha256").update(String(seed)).digest("hex").slice(0, 40);
}

const state = (healthy: boolean | null | undefined, known = true): HealthState => {
  if (!known) return "unknown";
  if (healthy === null || healthy === undefined) return "unknown";
  return healthy ? "healthy" : "unhealthy";
};

const dependencyState = (dependencies: Record<string, boolean> | undefined, key: string): HealthState => {
  const value = dependencies?.[key];
  return value === undefined ? "unknown" : value ? "healthy" : "unhealthy";
};

export function composeOperatorTelemetry(sources: OperatorTelemetrySources): OperatorTelemetryV1 {
  const limit = OPERATOR_TELEMETRY_LIMITS;
  const now = sources.now ?? new Date();

  // Requests and errors are derived from the existing bounded HTTP metric list.
  const byClass = new Map<string, { total: number; errors: number }>();
  let totalRequests = 0;
  let totalErrorRequests = 0;
  let latencySamples = 0;
  let latencyTotal = 0;
  let latencyMax = 0;
  for (const entry of sources.http ?? []) {
    const cls = sanitizeText(entry?.statusClass, 8);
    const count = boundedInt(entry?.count) ?? 0;
    if (!cls || !/^[1-5]xx$/.test(cls)) continue;
    const row = byClass.get(cls) ?? { total: 0, errors: 0 };
    row.total += count;
    if (cls.startsWith("5")) row.errors += count;
    byClass.set(cls, row);
    totalRequests += count;
    if (cls.startsWith("5")) totalErrorRequests += count;
    const duration = Number(entry?.durationSeconds);
    if (Number.isFinite(duration) && duration >= 0) {
      latencySamples += count;
      latencyTotal += duration;
      latencyMax = Math.max(latencyMax, duration);
    }
  }
  const classes = [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limit.maxStatusClasses)
    .map(([status_class, row]) => ({ status_class, count: row.total }));

  const services: TelemetryService[] = Object.entries(sources.services ?? {})
    .map(([rawName, value]) => ({ rawName, value }))
    .filter((entry) => sanitizeServiceName(entry.rawName) !== null)
    .slice(0, limit.maxServices)
    .map(({ rawName, value }) => {
      const name = sanitizeServiceName(rawName)!;
      if (value && (value as any).configured === false) {
        return { name, state: "unknown" as HealthState, configured: false, values: [] };
      }
      const v = value as { healthy: boolean; values?: Record<string, number | null> };
      const values = Object.entries(v.values ?? {})
        .filter(([key]) => sanitizeServiceName(key) !== null)
        .slice(0, limit.maxServiceValues)
        .map(([key, raw]) => ({ name: sanitizeServiceName(key)!, value: boundedInt(raw) }));
      return { name, state: state(v.healthy, true), configured: true, values };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const events = (sources.events ?? [])
    .map((entry) => ({ category: sanitizeCategory(entry?.category), count: boundedInt(entry?.count) ?? 0 }))
    .filter((entry): entry is { category: string; count: number } => entry.category !== null)
    .slice(0, limit.maxEvents)
    .sort((a, b) => a.category.localeCompare(b.category));

  const antivirus = sources.antivirus
    ? sources.antivirus.infected > 0
      ? "degraded"
      : "healthy"
    : "unknown";

  const worker = sources.services?.worker;
  const collaboration = sources.services?.collaboration;
  const overall: HealthState = sources.overallHealthy === null || sources.overallHealthy === undefined
    ? state(undefined, sources.readinessKnown !== false)
    : sources.overallHealthy
      ? "healthy"
      : "unhealthy";

  return {
    schema: OPERATOR_TELEMETRY_SCHEMA,
    generated_at: now.toISOString(),
    sequence: boundedInt(sources.sequence) ?? 0,
    source: {
      application: sanitizeText(sources.application, 48) ?? "workspace",
      version: sanitizeText(sources.version, 32) ?? "unknown",
      build_sha: sanitizeText(sources.buildSha, 40),
    },
    deployment: {
      deployment_id: deploymentIdFrom(sources.deploymentIdSeed).slice(0, limit.maxDeploymentIdLength),
      alias: sanitizeText(sources.alias, limit.maxAliasLength),
      version: sanitizeText(sources.version, 32) ?? "unknown",
      build_sha: sanitizeText(sources.buildSha, 40),
      release_channel: sanitizeText(sources.releaseChannel, 24) ?? "unknown",
      environment: sanitizeText(sources.environment, 24),
      region: sanitizeText(sources.region, 24),
    },
    runtime: {
      uptime_seconds: boundedInt(sources.startedAt ? (now.getTime() - sources.startedAt) / 1000 : null) ?? 0,
      overall,
      api: "healthy",
      worker: state(worker && (worker as any).configured === false ? null : (worker as any)?.healthy, true),
      collaboration: state(
        collaboration && (collaboration as any).configured === false
          ? null
          : (collaboration as any)?.healthy,
        true,
      ),
      database: dependencyState(sources.dependencies, "database"),
      redis: dependencyState(sources.dependencies, "redis"),
      storage: dependencyState(sources.dependencies, "storage"),
      antivirus,
    },
    signals: {
      requests: { total: totalRequests, by_status_class: classes },
      errors: { total: totalErrorRequests, by_status_class: classes.filter((c) => c.status_class.startsWith("5")) },
      latency: {
        samples: latencySamples,
        total_seconds: Math.round(latencyTotal * 1000) / 1000,
        max_seconds: Math.round(latencyMax * 1000) / 1000,
      },
      services,
      queue: {
        depth: boundedInt(sources.queueDepth),
        state: sources.queueState ?? sourcedState(sources.queueDepth, "unknown"),
      },
      capacity: {
        storage: boundedInt(sources.storageCapacity),
        database: boundedInt(sources.databaseCapacity),
      },
    },
    readiness: {
      last_backup_at: sources.lastBackupAt ? (sanitizeTimestamp(sources.lastBackupAt) ?? null) : null,
      backup_state: sources.backupVerified === null || sources.backupVerified === undefined
        ? "unknown"
        : sources.backupVerified
          ? "healthy"
          : "degraded",
      schema_version: sanitizeText(sources.schemaVersion, 32),
      upgrade_ready: typeof sources.upgradeReady === "boolean" ? sources.upgradeReady : null,
      tls: state(sources.tlsHealthy ?? null),
      profiles: {
        identity: sanitizeText(sources.identityProfile, 40),
        storage: sanitizeText(sources.storageProfile, 40),
      },
    },
    events,
  };
}

function sourcedState(value: number | null | undefined, unknownWhenMissing: HealthState): HealthState {
  const depth = boundedInt(value);
  return depth === null ? unknownWhenMissing : depth > 0 ? "degraded" : "healthy";
}

function sanitizeTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Machine-enforced prohibition scan. These patterns must never appear in a
// serialized telemetry payload, regardless of which source produced them.
export const PROHIBITED_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "email_address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "bearer_token", pattern: /bearer\s+[A-Za-z0-9._-]{8,}/i },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/ },
  { name: "session_cookie", pattern: /workspace_(session|oidc_state)\s*=/i },
  { name: "connection_string", pattern: /\b(postgres|postgresql|redis|mysql|mongodb):\/\/[^\s"]+/i },
  { name: "authorization_header", pattern: /authorization\s*:\s*\S+/i },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "password_field", pattern: /"?(password|passwd|client_secret|api_key|refresh_token|access_token|logout_token)"?\s*[:=]\s*\S+/i },
  { name: "url_with_query", pattern: /https?:\/\/[^\s"']*\?[^\s"']+/i },
  { name: "customer_filename", pattern: /[\w ()-]{3,}\.(pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|zip|eml|msg)\b/i },
];

export function scanForProhibited(serialized: string): string[] {
  return PROHIBITED_PATTERNS.filter((entry) => entry.pattern.test(serialized)).map((entry) => entry.name);
}

export function serializeOperatorTelemetry(payload: OperatorTelemetryV1): string {
  if (!OPERATOR_TELEMETRY_SUPPORTED_SCHEMAS.includes(payload.schema)) {
    throw new Error(`Unsupported operator telemetry schema: ${String(payload.schema)}`);
  }
  // Deterministic: the object is built in a fixed field order, so stable stringify
  // preserves it and the serialized shape is frozen by tests.
  const serialized = JSON.stringify(payload);
  const violations = scanForProhibited(serialized);
  if (violations.length) {
    throw new Error(`Operator telemetry privacy violation: ${violations.join(", ")}`);
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes) {
    throw new Error(`Operator telemetry payload exceeded ${OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes} bytes: ${bytes}`);
  }
  return serialized;
}

// Configuration boundary. Telemetry is disabled by default and Workspace must boot
// and operate with every telemetry setting absent.
export type OperatorTelemetryConfig = {
  enabled: boolean;
  deploymentIdSeed: string | null;
  alias: string | null;
  environment: string | null;
  region: string | null;
  releaseChannel: string | null;
  schema: string;
};

export function operatorTelemetryConfig(env: Record<string, string | undefined>): OperatorTelemetryConfig {
  return {
    enabled: String(env.OPERATOR_TELEMETRY_ENABLED ?? "").toLowerCase() === "true",
    deploymentIdSeed: sanitizeText(env.OPERATOR_TELEMETRY_DEPLOYMENT_ID, 128),
    alias: sanitizeText(env.OPERATOR_TELEMETRY_ALIAS, OPERATOR_TELEMETRY_LIMITS.maxAliasLength),
    environment: sanitizeText(env.OPERATOR_TELEMETRY_ENVIRONMENT, 24),
    region: sanitizeText(env.OPERATOR_TELEMETRY_REGION, 24),
    releaseChannel: sanitizeText(env.OPERATOR_TELEMETRY_RELEASE_CHANNEL, 24),
    schema: OPERATOR_TELEMETRY_SCHEMA,
  };
}

// ---------------------------------------------------------------------------
// Receiver-side canonical validation.
//
// The producer composes and serializes this shape; the receiver must enforce it at
// runtime, because a TypeScript type does not exist at runtime and a deployment with a
// valid credential could otherwise sign arbitrary JSON carrying the accepted schema
// string plus extra customer/content fields, which the fleet service would persist and
// return. This validator is the single shared definition of the accepted payload so
// producer and receiver semantics cannot drift.
//
// It rejects, in this order: byte size, JSON parseability, non-object payloads, unknown
// top-level or nested fields, unsupported schema, missing required fields, invalid
// field values (enums, bounds, shapes) and any prohibited content.
// ---------------------------------------------------------------------------

export type TelemetryValidation = { ok: true; payload: OperatorTelemetryV1 } | { ok: false; code: string };

const HEALTH_STATES: ReadonlySet<string> = new Set(["healthy", "degraded", "unhealthy", "unknown"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Returns the first field not in the allowlist, so an unknown or injected field is a
// hard rejection rather than being silently ignored.
function firstUnknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return key;
  return null;
}

// ---------------------------------------------------------------------------
// Shared canonical predicates.
//
// These are defined in terms of the producer's own helpers, so the receiver enforces
// the accepted producer contract rather than a compatible-looking superset and there is
// no second, drifting set of sanitation rules. A value is canonical when the producer's
// sanitizer would return it unchanged.
// ---------------------------------------------------------------------------

const healthState = (value: unknown): boolean => typeof value === "string" && HEALTH_STATES.has(value);

// Canonical sanitized text: already trimmed, control-character free, not a URL with a
// path or query, within the bound, and carrying no prohibited content.
export const canonicalText = (value: unknown, max: number): boolean =>
  typeof value === "string" && value.length > 0 && sanitizeText(value, max) === value;
export const canonicalOptionalText = (value: unknown, max: number): boolean => value === null || canonicalText(value, max);
export const canonicalServiceName = (value: unknown): boolean =>
  typeof value === "string" && sanitizeServiceName(value) === value;
export const canonicalCategory = (value: unknown): boolean =>
  typeof value === "string" && sanitizeCategory(value) === value;
// Status classes are produced as [1-5]xx only.
export const canonicalStatusClass = (value: unknown): boolean => typeof value === "string" && /^[1-5]xx$/.test(value);
// Counts, depths and capacities pass through boundedInt(): a non-negative integer.
export const canonicalCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const canonicalNullableCount = (value: unknown): boolean => value === null || canonicalCount(value);
// Latency is rounded to three decimals by the producer.
export const canonicalLatency = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && Math.round(value * 1000) / 1000 === value;
// Timestamps are emitted through Date.toISOString() (or sanitizeTimestamp, which does
// the same), so the canonical form is exactly the round-trip of its own ISO string.
export const canonicalTimestamp = (value: unknown): boolean =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
export const canonicalOptionalTimestamp = (value: unknown): boolean => value === null || canonicalTimestamp(value);

// The OCP-1A opaque deployment identity contract: "ws-" plus a SHA-256 hex prefix.
// One shared definition, used for telemetry validation, fleet registration and identity
// binding, so the fleet registry cannot hold identifiers Workspace would never produce.
export const DEPLOYMENT_ID_PATTERN = /^ws-[a-f0-9]{40}$/;
export const isCanonicalDeploymentId = (value: unknown): boolean =>
  typeof value === "string" && DEPLOYMENT_ID_PATTERN.test(value);

export function validateOperatorTelemetryV1(serialized: string): TelemetryValidation {
  const fail = (code: string): TelemetryValidation => ({ ok: false, code });
  // Byte accounting is UTF-8, matching the producer's ceiling exactly.
  if (Buffer.byteLength(serialized, "utf8") > OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes) return fail("payload_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return fail("payload_not_json");
  }
  if (!isPlainObject(parsed)) return fail("payload_not_object");
  const p = parsed as Record<string, any>;
  const L = OPERATOR_TELEMETRY_LIMITS;

  const unknownTop = firstUnknownKey(p, [
    "schema", "generated_at", "sequence", "source", "deployment", "runtime", "signals", "readiness", "events",
  ]);
  if (unknownTop) return fail(`unknown_field:${unknownTop}`);
  if (p.schema !== OPERATOR_TELEMETRY_SCHEMA) return fail("unsupported_schema");
  if (!canonicalTimestamp(p.generated_at)) return fail("invalid_generated_at");
  if (!canonicalCount(p.sequence)) return fail("invalid_sequence");

  if (!isPlainObject(p.source)) return fail("missing_field:source");
  if (firstUnknownKey(p.source, ["application", "version", "build_sha"])) return fail("unknown_field:source");
  if (!canonicalText(p.source.application, 48)) return fail("invalid_source_application");
  if (!canonicalText(p.source.version, 32)) return fail("invalid_source_version");
  if (!("build_sha" in p.source)) return fail("missing_field:source.build_sha");
  if (!canonicalOptionalText(p.source.build_sha, 40)) return fail("invalid_source_build_sha");

  if (!isPlainObject(p.deployment)) return fail("missing_field:deployment");
  if (firstUnknownKey(p.deployment, ["deployment_id", "alias", "version", "build_sha", "release_channel", "environment", "region"]))
    return fail("unknown_field:deployment");
  if (!isCanonicalDeploymentId(p.deployment.deployment_id)) return fail("invalid_deployment_id");
  if (!canonicalOptionalText(p.deployment.alias, L.maxAliasLength)) return fail("invalid_deployment_alias");
  if (!canonicalText(p.deployment.version, 32)) return fail("invalid_deployment_version");
  if (!canonicalOptionalText(p.deployment.build_sha, 40)) return fail("invalid_deployment_build_sha");
  if (!canonicalText(p.deployment.release_channel, 24)) return fail("invalid_deployment_release_channel");
  if (!canonicalOptionalText(p.deployment.environment, 24)) return fail("invalid_deployment_environment");
  if (!canonicalOptionalText(p.deployment.region, 24)) return fail("invalid_deployment_region");

  if (!isPlainObject(p.runtime)) return fail("missing_field:runtime");
  const runtimeKeys = ["uptime_seconds", "overall", "api", "worker", "collaboration", "database", "redis", "storage", "antivirus"];
  if (firstUnknownKey(p.runtime, runtimeKeys)) return fail("unknown_field:runtime");
  for (const key of runtimeKeys) if (!(key in p.runtime)) return fail(`missing_field:runtime.${key}`);
  if (!canonicalCount(p.runtime.uptime_seconds)) return fail("invalid_runtime_uptime");
  for (const key of runtimeKeys.slice(1)) if (!healthState(p.runtime[key])) return fail(`invalid_runtime_${key}`);

  if (!isPlainObject(p.signals)) return fail("missing_field:signals");
  if (firstUnknownKey(p.signals, ["requests", "errors", "latency", "services", "queue", "capacity"]))
    return fail("unknown_field:signals");
  const { requests, errors, latency, services, queue, capacity } = p.signals;
  for (const [name, group] of [["requests", requests], ["errors", errors]] as const) {
    if (!isPlainObject(group)) return fail(`missing_field:signals.${name}`);
    if (firstUnknownKey(group, ["total", "by_status_class"])) return fail(`unknown_field:signals.${name}`);
    if (!canonicalCount(group.total)) return fail(`invalid_signals_${name}_total`);
    if (
      !Array.isArray(group.by_status_class) ||
      group.by_status_class.length > L.maxStatusClasses ||
      !group.by_status_class.every(
        (entry: any) =>
          isPlainObject(entry) &&
          Object.keys(entry).length === 2 &&
          canonicalStatusClass(entry.status_class) &&
          canonicalCount(entry.count),
      )
    )
      return fail(`invalid_signals_${name}_by_status_class`);
  }
  if (!isPlainObject(latency)) return fail("missing_field:signals.latency");
  if (firstUnknownKey(latency, ["samples", "total_seconds", "max_seconds"])) return fail("unknown_field:signals.latency");
  if (!canonicalCount(latency.samples) || !canonicalLatency(latency.total_seconds) || !canonicalLatency(latency.max_seconds))
    return fail("invalid_signals_latency");
  if (
    !Array.isArray(services) ||
    services.length > L.maxServices ||
    !services.every(
      (service: any) =>
        isPlainObject(service) &&
        firstUnknownKey(service, ["name", "state", "configured", "values"]) === null &&
        canonicalServiceName(service.name) &&
        healthState(service.state) &&
        typeof service.configured === "boolean" &&
        Array.isArray(service.values) &&
        service.values.length <= L.maxServiceValues &&
        service.values.every(
          (item: any) =>
            isPlainObject(item) &&
            Object.keys(item).length === 2 &&
            canonicalServiceName(item.name) &&
            canonicalNullableCount(item.value),
        ),
    )
  )
    return fail("invalid_signals_services");
  if (!isPlainObject(queue)) return fail("missing_field:signals.queue");
  if (firstUnknownKey(queue, ["depth", "state"])) return fail("unknown_field:signals.queue");
  if (!canonicalNullableCount(queue.depth)) return fail("invalid_signals_queue_depth");
  if (!healthState(queue.state)) return fail("invalid_signals_queue_state");
  if (!isPlainObject(capacity)) return fail("missing_field:signals.capacity");
  if (firstUnknownKey(capacity, ["storage", "database"])) return fail("unknown_field:signals.capacity");
  if (!canonicalNullableCount(capacity.storage)) return fail("invalid_signals_capacity_storage");
  if (!canonicalNullableCount(capacity.database)) return fail("invalid_signals_capacity_database");

  if (!isPlainObject(p.readiness)) return fail("missing_field:readiness");
  if (firstUnknownKey(p.readiness, ["last_backup_at", "backup_state", "schema_version", "upgrade_ready", "tls", "profiles"]))
    return fail("unknown_field:readiness");
  if (!canonicalOptionalTimestamp(p.readiness.last_backup_at)) return fail("invalid_readiness_last_backup_at");
  if (!healthState(p.readiness.backup_state)) return fail("invalid_readiness_backup_state");
  if (!canonicalOptionalText(p.readiness.schema_version, 32)) return fail("invalid_readiness_schema_version");
  if (!(p.readiness.upgrade_ready === null || typeof p.readiness.upgrade_ready === "boolean"))
    return fail("invalid_readiness_upgrade_ready");
  if (!healthState(p.readiness.tls)) return fail("invalid_readiness_tls");
  if (!isPlainObject(p.readiness.profiles)) return fail("missing_field:readiness.profiles");
  if (firstUnknownKey(p.readiness.profiles, ["identity", "storage"])) return fail("unknown_field:readiness.profiles");
  if (!canonicalOptionalText(p.readiness.profiles.identity, 40)) return fail("invalid_readiness_profiles_identity");
  if (!canonicalOptionalText(p.readiness.profiles.storage, 40)) return fail("invalid_readiness_profiles_storage");

  if (!Array.isArray(p.events) || p.events.length > L.maxEvents) return fail("invalid_events");
  for (const event of p.events) {
    if (!isPlainObject(event) || Object.keys(event).length !== 2) return fail("unknown_field:events");
    if (!canonicalCategory(event.category) || !canonicalCount(event.count)) return fail("invalid_events");
  }

  // Prohibition scan runs on the received bytes, so content the producer would never
  // emit is still refused rather than trusted. Canonical predicates already drop
  // prohibited text, so this is defense in depth for the serialized whole.
  const violations = scanForProhibited(serialized);
  if (violations.length) return fail(`prohibited:${violations[0]}`);

  return { ok: true, payload: parsed as OperatorTelemetryV1 };
}
