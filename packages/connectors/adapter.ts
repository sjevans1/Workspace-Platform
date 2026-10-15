/**
 * W29-A: the provider adapter contract.
 *
 * Adapters are SMALL. An adapter authenticates its own inbound requests, normalizes
 * them into the provider-neutral event shape, reports bounded health, performs a
 * bounded incremental sync that returns a cursor, and executes its own declared
 * actions. It never touches Workspace authorization, tenant isolation, run
 * recording, idempotency or audit: those belong to the connector runtime and the
 * deterministic workflow engine, so a provider can never broaden a Workspace
 * permission or bypass a capability check.
 */
import { createHash } from "node:crypto";
import { SYNTHETIC_PROVIDER_KEY, type Capability } from "./registry.ts";

export type AdapterFailureCategory =
  | "transient"
  | "rate_limited"
  | "provider_unavailable"
  | "credential_expired"
  | "permission_revoked"
  | "permanent"
  | "validation";

export type NormalizedEvent = {
  event_type: string;
  provider_event_id: string | null;
  /** Stable provider-side identity of this delivery, used for deduplication. */
  dedupe_key: string;
  occurred_at: string | null;
  resource_refs: Record<string, unknown>[];
  payload_ref: Record<string, unknown>;
};

export type InboundRequest = {
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, already bounded by the caller. */
  body: unknown;
  /** The decrypted verification secret for this connection, never logged. */
  secret: string;
};

export type AdapterHooks = {
  capabilities: Capability[];
  /** Authenticate the provider request BEFORE normalization. */
  verifyInbound(input: InboundRequest): { verified: boolean; reason?: string };
  /** Normalize a VERIFIED request. Returning null means "nothing to record". */
  normalizeInbound(input: InboundRequest): NormalizedEvent | null;
  health(input: {
    config: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    category?: AdapterFailureCategory;
    detail?: string;
  }>;
  /** Bounded incremental sync. Cursor is opaque to the caller. */
  sync(input: {
    cursor: string | null;
    limit: number;
    config: Record<string, unknown>;
  }): Promise<{ events: NormalizedEvent[]; next_cursor: string | null }>;
  action(input: {
    action: string;
    capability: Capability;
    config: Record<string, unknown>;
    payload: Record<string, unknown>;
    /**
     * W29-P0/A1: the durable external-effect context. `idempotency_key` is stable
     * for one logical effect, so an adapter whose provider offers an idempotency
     * primitive must pass it through and may then treat a repeat as the same
     * operation. An adapter that fails knowing the request never reached the
     * provider must mark the error with `delivery_state: "not_sent"` (see
     * `notSent`); anything else is treated as potentially delivered.
     */
    effect?: { idempotency_key: string; attempt: number };
  }): Promise<Record<string, unknown>>;
};

export function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const boundedText = (value: unknown, max: number): string | null => {
  const text = typeof value === "string" ? value : "";
  return text && text.length <= max ? text : text ? text.slice(0, max) : null;
};

/**
 * The synthetic/test provider. It exists so the whole connector architecture can be
 * accepted without an external account or credential: it verifies an inbound token,
 * normalizes a bounded event, reports health, syncs from a deterministic cursor and
 * executes one declared action. It performs no network I/O.
 */
export const SYNTHETIC_HOOKS: AdapterHooks = {
  capabilities: [
    "connection.health",
    "connection.sync",
    "message.receive",
    "message.send",
  ],
  verifyInbound({ headers, secret }) {
    const presented = headerOf(headers, "x-connector-token");
    if (!secret || !presented)
      return { verified: false, reason: "missing_signature" };
    // Constant-shape comparison; the caller passes the decrypted secret and the
    // adapter never records either value.
    const left = Buffer.from(presented),
      right = Buffer.from(secret);
    const matches = left.length === right.length && left.equals(right);
    return matches
      ? { verified: true }
      : { verified: false, reason: "invalid_signature" };
  },
  normalizeInbound({ body }) {
    const value = (body ?? {}) as Record<string, unknown>;
    const eventType = boundedText(value.event_type, 120);
    const providerEventId = boundedText(value.provider_event_id, 256);
    if (!eventType || !providerEventId)
      throw new Error(
        "Synthetic event requires event_type and provider_event_id",
      );
    const dedupeKey = boundedText(value.dedupe_key, 256) ?? providerEventId;
    const refs = Array.isArray(value.resource_refs) ? value.resource_refs : [];
    return {
      event_type: eventType,
      provider_event_id: providerEventId,
      dedupe_key: dedupeKey,
      occurred_at:
        typeof value.occurred_at === "string" &&
        !Number.isNaN(Date.parse(value.occurred_at))
          ? new Date(value.occurred_at).toISOString()
          : null,
      resource_refs: refs
        .filter((item) => item && typeof item === "object")
        .slice(0, 16) as Record<string, unknown>[],
      payload_ref: {
        ...(typeof value.summary === "string"
          ? { summary: value.summary.slice(0, 400) }
          : {}),
        ...(typeof value.priority === "string"
          ? { priority: value.priority.slice(0, 40) }
          : {}),
        synthetic: true,
      },
    };
  },
  async health() {
    return { ok: true };
  },
  async sync({ cursor, limit }) {
    const from = Number(cursor ?? "0");
    assertBoundedCursor(from);
    const size = Math.max(1, Math.min(limit, 50));
    const events: NormalizedEvent[] = [];
    for (let index = 0; index < size; index++) {
      const seq = from + index + 1;
      events.push({
        event_type: "synthetic.tick",
        provider_event_id: `synthetic-${seq}`,
        dedupe_key: `synthetic-${seq}`,
        occurred_at: null,
        resource_refs: [],
        payload_ref: { sequence: seq, synthetic: true },
      });
    }
    return { events, next_cursor: String(from + size) };
  },
  async action({ action, payload, effect }) {
    if (action !== "synthetic.record")
      throw new Error(`Unsupported synthetic action: ${action}`);
    // The provider reference is a deterministic function of the effect's
    // idempotency key, so a re-send after a reclaimed lease reports the SAME
    // provider-side operation instead of a second one.
    // W29-P0/A1: the reference carries the provider's OWN key as its prefix, which
    // is the contract the runtime accepts verbatim; every other provider value is
    // reduced to a safe digest before it reaches durable evidence.
    const reference = effect
      ? `${SYNTHETIC_PROVIDER_KEY}:${createHash("sha256").update(effect.idempotency_key).digest("hex").slice(0, 32)}`
      : null;
    return {
      synthetic: true,
      recorded: true,
      // Bounded, non-secret echo so the acceptance can prove the action really ran.
      label: boundedText(payload.label, 120) ?? "synthetic",
      ...(reference ? { provider_reference: reference } : {}),
    };
  },
};

/**
 * W29-P0/A1: the delivery-state marker an adapter raises when it knows the request
 * never reached the provider. The runtime treats every other failure as
 * potentially delivered, which is what stops a blind retry from sending twice.
 */
export function notSent(
  message: string,
): Error & { delivery_state: "not_sent" } {
  const error = new Error(message) as Error & { delivery_state: "not_sent" };
  error.delivery_state = "not_sent";
  return error;
}

function assertBoundedCursor(from: number) {
  if (!Number.isInteger(from) || from < 0 || from > 1_000_000)
    throw new Error("Synthetic sync cursor is out of bounds");
}
