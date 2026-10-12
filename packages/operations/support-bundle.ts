// OCP-1C: customer-authorized, bounded, sanitized support evidence.
//
// A customer owner/admin explicitly authorises a time-bounded support window, and
// only within that window can a bounded, allowlisted evidence package be generated.
// The package contains operational evidence only: it reuses the already-vetted OCP-1
// telemetry snapshot, the bounded transport status, the deployment preflight summary
// and the enriched operational sources. It never contains logs, rows, customer
// content, identifiers or secrets.
//
// Principles: allowlist first, prohibition scan second; bounded; deterministic where
// feasible; fail-soft; no OCP-2 dependency; no automatic upload; no raw log export.

import { createHash } from "node:crypto";
import {
  OPERATOR_TELEMETRY_LIMITS,
  OPERATOR_TELEMETRY_SCHEMA,
  PROHIBITED_PATTERNS,
  scanForProhibited,
} from "./operator-telemetry.ts";

export const SUPPORT_BUNDLE_VERSION = "openjm.workspace.support-bundle.v1";
export const SUPPORT_BUNDLE_SUPPORTED = [SUPPORT_BUNDLE_VERSION];

// Bounds. Deliberately small: a support package is evidence, not a data dump.
export const SUPPORT_BUNDLE_LIMITS = {
  maxBytes: 32768,
  maxEvents: 10,
  maxEventCategories: 10,
  maxStringLength: 96,
  maxRetainedPackages: 20,
  defaultTtlMinutes: 60,
  maxTtlMinutes: 1440,
} as const;

export type SupportAuthorizationState = "active" | "expired" | "revoked" | "none";

export type SupportAuthorization = {
  id: string;
  state: string;
  purpose: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
};

// The authorization state machine, kept pure so expiry and revocation are provable
// without a database.
export function authorizationState(
  record: { state: string; expires_at: string; revoked_at: string | null } | null,
  now: Date,
): SupportAuthorizationState {
  if (!record) return "none";
  if (record.revoked_at) return "revoked";
  if (record.state !== "active") return "expired";
  return Date.parse(record.expires_at) > now.getTime() ? "active" : "expired";
}

export function clampTtlMinutes(value: unknown): number {
  const n = Math.floor(Number(value));
  const fallback = SUPPORT_BUNDLE_LIMITS.defaultTtlMinutes;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, SUPPORT_BUNDLE_LIMITS.maxTtlMinutes);
}

const text = (value: unknown, max: number = SUPPORT_BUNDLE_LIMITS.maxStringLength): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!trimmed) return null;
  const bounded = trimmed.slice(0, max);
  // Same policy as OCP-1A: a value carrying prohibited content is dropped, not
  // truncated into something that looks safe.
  if (PROHIBITED_PATTERNS.some((entry) => entry.pattern.test(bounded))) return null;
  return bounded;
};

const category = (value: unknown): string | null => {
  const bounded = text(value, 48);
  return bounded && /^[a-z][a-z0-9._:-]{0,47}$/.test(bounded) ? bounded : null;
};

// ---------------------------------------------------------------------------
// Bounded structured operational event summaries.
//
// These are DERIVED factual statements about the telemetry snapshot and the enriched
// operational sources. They are not logs, they carry no customer content, they are
// low cardinality and they are bounded in count.
// ---------------------------------------------------------------------------

export type SupportEvent = {
  category: string;
  severity: "info" | "warning";
  detail: string | boolean | number | null;
  observed_at: string;
};

export function summarizeOperationalEvents(input: {
  telemetry: any;
  now?: Date;
}): SupportEvent[] {
  const events: SupportEvent[] = [];
  const now = (input.now ?? new Date()).toISOString();
  const push = (c: string, s: SupportEvent["severity"], d: SupportEvent["detail"]) =>
    events.push({ category: c, severity: s, detail: d, observed_at: now });
  const t = input.telemetry ?? {};

  // Queue: factual presence of work, never an SLA judgment.
  if (t?.signals?.queue?.state === "degraded") push("queue.degraded", "warning", t.signals.queue.depth ?? null);
  if (t?.signals?.queue?.state === "unknown") push("queue.state_unavailable", "warning", null);
  // Storage and database capacity states.
  if (t?.signals?.capacity?.storage === null || t?.signals?.capacity?.storage === undefined)
    push("storage.capacity_unknown", "info", null);
  if (t?.signals?.capacity?.database === null) push("database.capacity_unknown", "info", null);
  // Backup verification.
  if (t?.readiness?.backup_state === "degraded") push("backup.verification_failed", "warning", null);
  if (t?.readiness?.backup_state === "unknown") push("backup.state_unknown", "info", null);
  // Service and dependency health, bounded to a single summary category.
  for (const [name, value] of Object.entries(t?.runtime ?? {})) {
    if (typeof value !== "string") continue;
    if (value === "unhealthy" || value === "degraded") {
      const c = category(`${name}.unhealthy`);
      if (c) push(c, "warning", value);
    }
  }
  // Transport status, when supplied.
  if (t?.transport?.last_failure_category && t.transport.last_failure_category !== "none")
    push("telemetry_transport.failure", "warning", text(t.transport.last_failure_category, 32));
  if (t?.transport?.enabled === false) push("telemetry_transport.disabled", "info", false);

  return events.slice(0, SUPPORT_BUNDLE_LIMITS.maxEvents);
}

// ---------------------------------------------------------------------------
// The bundle contract. Strict allowlist: fields are constructed explicitly rather
// than collected broadly and then redacted.
// ---------------------------------------------------------------------------

export type SupportBundleV1 = {
  bundle: string;
  generated_at: string;
  digest: string;
  authorization: { state: SupportAuthorizationState; purpose: string | null };
  workspace: { application: string; version: string; build_sha: string | null };
  contract: { telemetry: string; envelope_or_transport: string | null };
  telemetry: any;
  transport: any;
  deployment: { preflight_valid: boolean | null; issues: number; identity_profile: string | null; storage_profile: string | null };
  operational: {
    queue: { depth: number | null; state: string };
    storage: { used_percent: number | null };
    backup: { last_backup_at: string | null; state: string };
  };
  schema_version: string | null;
  events: SupportEvent[];
};

export function composeSupportBundle(input: {
  telemetry: any;
  transport?: any;
  deployment?: { ok?: boolean; issues?: unknown[]; summary?: any };
  operational?: { queue?: any; storage?: any; backup?: any };
  schemaVersion?: string | null;
  applicationVersion?: string | null;
  buildSha?: string | null;
  authorizationState?: SupportAuthorizationState;
  purpose?: string | null;
  now?: Date;
}): SupportBundleV1 {
  const now = input.now ?? new Date();
  const telemetry = input.telemetry ?? {};
  const events = summarizeOperationalEvents({ telemetry: { ...telemetry, transport: input.transport }, now });
  const bundle: SupportBundleV1 = {
    bundle: SUPPORT_BUNDLE_VERSION,
    generated_at: now.toISOString(),
    digest: "",
    authorization: {
      state: input.authorizationState ?? "none",
      purpose: text(input.purpose, 64),
    },
    workspace: {
      application: text(telemetry?.source?.application, 48) ?? "workspace",
      version: text(input.applicationVersion, 32) ?? text(telemetry?.source?.version, 32) ?? "unknown",
      build_sha: text(input.buildSha, 40),
    },
    contract: {
      telemetry: OPERATOR_TELEMETRY_SCHEMA,
      envelope_or_transport: text(input.transport?.envelope_version, 64),
    },
    // The already-vetted OCP-1A snapshot is embedded as-is rather than re-derived.
    telemetry,
    transport: input.transport ?? null,
    deployment: {
      preflight_valid: typeof input.deployment?.ok === "boolean" ? input.deployment.ok : null,
      issues: Array.isArray(input.deployment?.issues) ? input.deployment!.issues!.length : 0,
      identity_profile: text(input.deployment?.summary?.auth, 40),
      storage_profile: text(input.deployment?.summary?.storage, 40),
    },
    operational: {
      queue: { depth: bounded(input.operational?.queue?.depth), state: enumState(input.operational?.queue?.state) },
      storage: { used_percent: bounded(input.operational?.storage?.usedPercent) },
      backup: {
        last_backup_at: timestamp(input.operational?.backup?.lastBackupAt),
        state: text(input.operational?.backup?.state, 24) ?? "unknown",
      },
    },
    schema_version: text(input.schemaVersion, 32),
    events,
  };
  bundle.digest = createHash("sha256").update(canonical(bundle)).digest("hex");
  return bundle;
}

function bounded(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}
function enumState(value: unknown): string {
  return ["healthy", "degraded", "unhealthy", "unknown"].includes(String(value)) ? String(value) : "unknown";
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
// Deterministic serialization with a fixed field order (object insertion order).
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

// Machine-enforced: the prohibition scan and the byte ceiling apply to the real
// serialized bundle, not just the in-memory object.
export function serializeSupportBundle(bundle: SupportBundleV1): string {
  if (!SUPPORT_BUNDLE_SUPPORTED.includes(bundle.bundle)) {
    throw new Error(`Unsupported support bundle version: ${String(bundle.bundle)}`);
  }
  const copy = { ...bundle };
  const serialized = JSON.stringify(copy);
  const violations = scanForProhibited(serialized);
  if (violations.length) throw new Error(`Support bundle privacy violation: ${violations.join(", ")}`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > SUPPORT_BUNDLE_LIMITS.maxBytes) {
    throw new Error(`Support bundle exceeded ${SUPPORT_BUNDLE_LIMITS.maxBytes} bytes: ${bytes}`);
  }
  return serialized;
}

// The OCP-1A ceiling must also still hold for the embedded telemetry snapshot.
export function assertEmbeddedTelemetryWithinBounds(serializedTelemetry: string): void {
  const bytes = Buffer.byteLength(serializedTelemetry, "utf8");
  if (bytes > OPERATOR_TELEMETRY_LIMITS.maxPayloadBytes) {
    throw new Error(`Embedded telemetry exceeded its own ceiling: ${bytes}`);
  }
}
