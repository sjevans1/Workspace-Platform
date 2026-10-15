/**
 * W29-A / W30-A: normalized provider and step failure classification.
 *
 * Every external call classifies its outcome into a bounded vocabulary instead of a
 * generic `error`, because the remedies differ: a 429 must back off and retry, an
 * expired credential must reach `attention_required` and stop, a revoked permission
 * needs a human, and a validation failure must never be retried at all. The same
 * vocabulary is used by the connector sync worker and by the workflow engine's
 * retry policy so the two can never disagree about what is retryable.
 */
import { assert } from "../contracts/index.ts";

export type FailureCategory =
  | "transient"
  | "rate_limited"
  | "provider_unavailable"
  | "credential_expired"
  | "permission_revoked"
  | "permanent"
  | "validation"
  | "authorization_revoked"
  | "connector_attention_required"
  | "capability_missing"
  | "not_found"
  | "conflict"
  /**
   * W29-P0/A1: an external effect may have reached the provider but its outcome
   * cannot be proven. It is deliberately NOT retryable: a blind retry could send
   * the same message twice, so only an explicit human decision may re-attempt it.
   */
  | "outcome_unknown";

export const FAILURE_CATEGORIES: FailureCategory[] = [
  "transient",
  "rate_limited",
  "provider_unavailable",
  "credential_expired",
  "permission_revoked",
  "permanent",
  "validation",
  "authorization_revoked",
  "connector_attention_required",
  "capability_missing",
  "not_found",
  "conflict",
  "outcome_unknown",
];

/** Retry is bounded and only ever applies to a genuinely transient condition. */
export const RETRY_POLICY = {
  max_attempts: 7,
  base_seconds: 5,
  cap_seconds: 3600,
  /** A sync that keeps failing becomes visible attention rather than silent churn. */
  attention_after_failures: 5,
} as const;

const RETRYABLE = new Set<FailureCategory>([
  "transient",
  "rate_limited",
  "provider_unavailable",
]);

export function isRetryableCategory(category: FailureCategory): boolean {
  return RETRYABLE.has(category);
}

/** Deterministic bounded exponential backoff; no jitter so retries are reproducible. */
export function backoffSeconds(attempt: number, retryAfterSeconds?: number | null): number {
  const safeAttempt = Math.max(0, Math.min(Number(attempt) || 0, 32));
  const exponential = RETRY_POLICY.base_seconds * 2 ** safeAttempt;
  const directed =
    typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.ceil(retryAfterSeconds)
      : 0;
  return Math.min(RETRY_POLICY.cap_seconds, Math.max(exponential, directed));
}

export type ProviderFailureInput = {
  status?: number | null;
  retryAfterSeconds?: number | null;
  code?: string | null;
  /** Transport-level outcome when no HTTP status exists. */
  kind?: "network" | "timeout" | "protocol" | null;
};

export type ConnectionStatus =
  | "pending"
  | "connected"
  | "attention_required"
  | "disabled"
  | "revoked"
  | "error";

export type ProviderFailure = {
  category: FailureCategory;
  retryable: boolean;
  /** Null when the attempt must not be retried. */
  backoff_seconds: number | null;
  /**
   * The connection status this failure implies. `null` means "leave the connection
   * status alone and record the error against the pending operation", which is the
   * correct outcome for a bounded transient failure of an otherwise healthy
   * connection.
   */
  connection_status: ConnectionStatus | null;
  /** Bounded, non-secret operator summary. */
  summary: string;
};

const AUTHORIZATION_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "expired_token",
  "invalid_client",
  "unauthorized_client",
]);

export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  const status = typeof input.status === "number" ? input.status : null;
  const code = (input.code || "").toLowerCase();
  const attemptForBackoff = 0;
  const transient = (category: FailureCategory, summary: string): ProviderFailure => ({
    category,
    retryable: true,
    backoff_seconds: backoffSeconds(attemptForBackoff, input.retryAfterSeconds),
    connection_status: null,
    summary,
  });
  const terminal = (
    category: FailureCategory,
    connection_status: ConnectionStatus,
    summary: string,
  ): ProviderFailure => ({
    category,
    retryable: false,
    backoff_seconds: null,
    connection_status,
    summary,
  });

  if (status === 429)
    return transient("rate_limited", "Provider rate limit reached; backing off");
  if (status !== null && status >= 500 && status <= 599)
    return transient("provider_unavailable", `Provider unavailable (HTTP ${status})`);
  if (status === 401 || AUTHORIZATION_CODES.has(code))
    return terminal(
      "credential_expired",
      "attention_required",
      "Provider credential expired or was rejected; reconnect required",
    );
  if (status === 403)
    return terminal(
      "permission_revoked",
      "attention_required",
      "Provider permission was revoked; reconnect required",
    );
  if (status === 400 || status === 422)
    return terminal("validation", "error", `Provider rejected the request (HTTP ${status})`);
  if (status === 404)
    return terminal("not_found", "error", "Provider resource no longer exists");
  if (status === 409)
    return terminal("conflict", "error", "Provider reported a conflicting state");
  if (input.kind === "network" || input.kind === "timeout")
    return transient("transient", `Provider connection ${input.kind} failure`);
  if (input.kind === "protocol")
    return terminal("permanent", "error", "Provider returned an unreadable response");
  if (status !== null)
    return terminal("permanent", "error", `Provider rejected the request (HTTP ${status})`);
  return terminal("permanent", "error", "Provider operation failed");
}

/** Classifies a workflow step failure raised by Workspace itself. */
export function classifyStepFailure(error: unknown): {
  category: FailureCategory;
  retryable: boolean;
  summary: string;
} {
  const status =
    typeof (error as { statusCode?: number })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : null;
  const message = String((error as Error)?.message || "step failed");
  const summary = message.slice(0, 200);
  if (status === 403) return { category: "authorization_revoked", retryable: false, summary };
  if (status === 404) return { category: "not_found", retryable: false, summary };
  if (status === 409) return { category: "conflict", retryable: true, summary };
  if (status === 429) return { category: "rate_limited", retryable: true, summary };
  if (status !== null && status >= 500)
    return { category: "transient", retryable: true, summary };
  if (status === 400 || status === 422)
    return { category: "validation", retryable: false, summary };
  if (status === 401)
    return { category: "authorization_revoked", retryable: false, summary };
  return { category: "transient", retryable: true, summary };
}

export function assertFailureCategory(value: string): FailureCategory {
  assert(
    FAILURE_CATEGORIES.includes(value as FailureCategory),
    500,
    `Unknown failure category: ${value}`,
  );
  return value as FailureCategory;
}
