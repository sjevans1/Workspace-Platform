/**
 * W29-P0/A1: the durable external-effect lifecycle.
 *
 * A connector action is the ONE place a workflow can reach the outside world, so
 * its provider I/O must never happen inside the engine's tenant transaction. A
 * slow provider would hold a database connection and a row lock for as long as it
 * likes, and a rollback after the provider had already accepted the request would
 * leave Workspace believing nothing happened.
 *
 * The lifecycle is therefore split into short transactions around an unprotected
 * provider call:
 *
 *   authorize/validate -> persist/reuse the effect   (engine, short transaction)
 *   -> claim it                                       (worker, short transaction)
 *   -> COMMIT
 *   -> mark the I/O boundary                          (short transaction)
 *   -> provider I/O with NO transaction and NO row lock held
 *   -> new short transaction: verify the lease is still authoritative
 *   -> commit the normalized outcome
 *   -> the engine settles the workflow step from the durable effect state
 *
 * Honest semantics, because a lie here sends a message twice or loses one:
 *   - `planned`   the effect exists and no provider I/O has been attempted;
 *   - `claimed`   a worker holds a lease and may be inside the provider call;
 *   - `succeeded` a normalized successful outcome is committed;
 *   - `failed`    the attempt provably never reached the provider (or the
 *                 provider offers an idempotency primitive, so a re-send with the
 *                 same key is safe);
 *   - `outcome_unknown` the provider I/O may have happened and its outcome cannot
 *                 be proven. It is NEVER retried automatically and NEVER reported
 *                 as success;
 *   - `cancelled` the run was cancelled before the I/O boundary.
 *
 * The request itself is NOT stored: it is re-derived from the run's immutable
 * pinned revision and checked against the digest recorded at plan time, so run
 * evidence never carries message content.
 */
import { createHash, randomUUID } from "node:crypto";
import { assert, json } from "../contracts/index.ts";
import type { Database, Query } from "../database/index.ts";
import { one } from "../database/index.ts";
import {
  RETRY_POLICY,
  classifyProviderFailure,
  isRetryableCategory,
  type FailureCategory,
} from "../connectors/index.ts";
import {
  connectionActionFacts,
  connectorReachDenial,
  invokeProviderAction,
  type ConnectionActionFacts,
} from "../connectors/index.ts";
import { planSteps, type WorkflowDefinition } from "./dsl.ts";

export const EFFECT_LIMITS = Object.freeze({
  /** Effects claimed per tenant per worker tick. */
  claim_batch: 10,
  /** Lease held while a worker prepares the call. */
  lease_seconds: 60,
  /** Lease extension that must cover the provider call itself. */
  io_lease_seconds: 180,
  /** How long a parked step waits before it re-reads the effect state. */
  poll_seconds: 1,
  max_attempts: RETRY_POLICY.max_attempts,
  max_result_bytes: 4096,
  max_request_bytes: 4096,
  max_summary: 400,
});

export type ExternalEffectRow = any;

export type EffectRequest = {
  connection_id: string;
  action: string;
  capability: string;
  payload: Record<string, unknown>;
};

/** The bounded, non-secret request digest that pins the planned request. */
export function requestDigest(request: EffectRequest): string {
  const serialized = json({
    connection_id: request.connection_id,
    action: request.action,
    capability: request.capability,
    payload: request.payload || {},
  });
  assert(
    Buffer.byteLength(serialized) <= EFFECT_LIMITS.max_request_bytes,
    400,
    "Connector action request is too large",
  );
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Stable deterministic identity of one logical effect: the same run, step and
 * operation always address the same row and the same provider idempotency key, no
 * matter how many retries, restarts or replays reach it.
 */
export function effectIdentity(input: {
  run_id: string;
  step_seq: number;
  operation: string;
  digest: string;
}): { id: string; idempotency_key: string } {
  const idempotency_key = createHash("sha256")
    .update(
      [
        "external-effect",
        input.run_id,
        String(input.step_seq),
        input.operation,
        input.digest,
      ].join("\u0000"),
    )
    .digest("hex");
  const bytes = Buffer.from(
    createHash("sha256")
      .update(
        [
          "external-effect-id",
          input.run_id,
          String(input.step_seq),
          input.operation,
        ].join("\u0000"),
      )
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return { id, idempotency_key };
}

/**
 * Bounded, non-secret evidence for run/step history. It never carries the
 * request, a credential or provider content.
 */
export function externalEffectEvidence(
  row: ExternalEffectRow,
): Record<string, unknown> {
  if (!row) return {};
  const evidence: Record<string, unknown> = {
    id: row.id,
    status: row.status,
    attempt: Number(row.attempt) || 0,
    operation: row.operation,
    connection_id: row.connection_id,
    provider_key: row.provider_key,
    action: row.action,
    capability: row.capability,
    idempotency_key: row.idempotency_key,
    provider_idempotent: row.provider_idempotent === true,
  };
  if (row.provider_reference)
    evidence.provider_reference = row.provider_reference;
  if (row.error_category) evidence.error_category = row.error_category;
  if (row.error_summary)
    evidence.error_summary = String(row.error_summary).slice(0, 200);
  if (row.completed_at)
    evidence.completed_at = new Date(row.completed_at).toISOString();
  return evidence;
}

async function effectByRunStep(
  q: Query,
  tenant: string,
  runId: string,
  stepSeq: number,
  operation: string,
): Promise<ExternalEffectRow | null> {
  return one(
    q,
    "SELECT * FROM workflow_external_effects WHERE tenant_id=$1 AND run_id=$2 AND step_seq=$3 AND operation=$4",
    [tenant, runId, stepSeq, operation],
  );
}

/**
 * A step parked on an effect waits with a short poll deadline, but a terminal
 * outcome is known NOW: waking the run makes the engine settle it on the next
 * engine pass instead of after a needless poll interval.
 */
async function wakeParkedRun(
  q: Query,
  tenant: string,
  runId: string,
): Promise<void> {
  await q.query(
    "UPDATE workflow_runs SET next_attempt_at=now() WHERE tenant_id=$1 AND id=$2 AND status='waiting'",
    [tenant, runId],
  );
}

export async function externalEffectForRunStep(
  q: Query,
  tenant: string,
  runId: string,
  stepSeq: number,
  operation: string,
): Promise<ExternalEffectRow | null> {
  return effectByRunStep(q, tenant, runId, stepSeq, operation);
}

/**
 * Creates the effect once and REUSES it forever after: a retry, a restart or a
 * replayed trigger addresses the same row, so one logical effect can never become
 * two provider operations.
 *
 * A retryable failure is re-armed (`planned`) so the next worker tick may claim
 * it again; a terminal state is returned untouched, and the engine decides from it
 * rather than re-planning.
 */
export async function ensureExternalEffect(
  q: Query,
  tenant: string,
  input: {
    run_id: string;
    workflow_id: string;
    revision: number;
    step_seq: number;
    /** The step attempt addressing the effect, which decides whether a retryable
     *  failure is re-armed or reported to the engine as a settled failure. */
    step_attempt: number;
    operation: string;
    connection_id: string;
    provider_key: string;
    action: string;
    capability: string;
    provider_idempotent: boolean;
    authority_kind: "delegated_user" | "service_principal";
    authority_user_id: string;
    request: EffectRequest;
  },
): Promise<ExternalEffectRow> {
  const digest = requestDigest(input.request);
  const { id, idempotency_key } = effectIdentity({
    run_id: input.run_id,
    step_seq: input.step_seq,
    operation: input.operation,
    digest,
  });
  const existing = await effectByRunStep(
    q,
    tenant,
    input.run_id,
    input.step_seq,
    input.operation,
  );
  if (existing) {
    assert(
      existing.request_digest === digest,
      409,
      "External effect request no longer matches the planned request",
    );
    if (
      existing.status === "failed" &&
      existing.error_category &&
      isRetryableCategory(existing.error_category as FailureCategory) &&
      Number(existing.attempt) < Number(existing.max_attempts) &&
      // Re-arm ONLY for a genuine new step attempt. The settle pass that reads a
      // failed effect at the SAME attempt must see the failure, so the engine can
      // classify it and apply its own bounded retry policy.
      Number(input.step_attempt) > Number(existing.attempt)
    ) {
      // Re-arm the SAME effect for the next attempt: identity is unchanged, so a
      // provider that offers an idempotency primitive still sees one operation.
      return await one(
        q,
        "UPDATE workflow_external_effects SET status='planned',next_attempt_at=now(),lease_token=NULL," +
          " lease_expires_at=NULL,io_started_at=NULL,error_category=NULL,error_summary=NULL,updated_at=now()" +
          " WHERE tenant_id=$1 AND id=$2 RETURNING *",
        [tenant, existing.id],
      );
    }
    return existing;
  }
  const inserted = await one(
    q,
    "INSERT INTO workflow_external_effects(id,tenant_id,run_id,workflow_id,revision,step_seq,operation," +
      " connection_id,provider_key,action,capability,idempotency_key,request_digest,authority_kind," +
      " authority_user_id,status,attempt,max_attempts,provider_idempotent,next_attempt_at)" +
      " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'planned',0,$16,$17,now())" +
      " ON CONFLICT(tenant_id,run_id,step_seq,operation) DO NOTHING RETURNING *",
    [
      id,
      tenant,
      input.run_id,
      input.workflow_id,
      input.revision,
      input.step_seq,
      input.operation,
      input.connection_id,
      input.provider_key,
      input.action,
      input.capability,
      idempotency_key,
      digest,
      input.authority_kind,
      input.authority_user_id,
      EFFECT_LIMITS.max_attempts,
      input.provider_idempotent,
    ],
  );
  if (inserted) return inserted;
  // A concurrent planner won the race: the row exists and is authoritative.
  const raced = await effectByRunStep(
    q,
    tenant,
    input.run_id,
    input.step_seq,
    input.operation,
  );
  assert(raced, 409, "External effect could not be created");
  return raced!;
}

export type ExternalEffectClaim = {
  id: string;
  run_id: string;
  workflow_id: string;
  revision: number;
  step_seq: number;
  operation: string;
  connection_id: string;
  provider_key: string;
  action: string;
  capability: string;
  idempotency_key: string;
  request_digest: string;
  authority_kind: "delegated_user" | "service_principal";
  authority_user_id: string;
  attempt: number;
  max_attempts: number;
  provider_idempotent: boolean;
  lease_token: string;
  reclaimed: boolean;
};

/**
 * Claims due effects inside the CALLER's short tenant transaction.
 *
 * Two things happen here, both before any provider I/O:
 *   - an expired claim is RECLAIMED. If the previous attempt never crossed the I/O
 *     boundary it is safe to retry; if it did, only a provider idempotency
 *     primitive makes a re-send safe, and otherwise the effect becomes
 *     `outcome_unknown` and is never retried automatically.
 *   - an attempt ceiling is enforced, so a permanently failing effect becomes
 *     terminal instead of churning.
 */
export type ClaimBatch = {
  claims: ExternalEffectClaim[];
  /** Effects settled during reclamation without being claimed again. */
  settled: { outcome_unknown: number; failed: number };
};

export async function claimDueExternalEffects(
  q: Query,
  tenant: string,
  limit: number = EFFECT_LIMITS.claim_batch,
): Promise<ClaimBatch> {
  const candidates = await q.query(
    "SELECT * FROM workflow_external_effects WHERE tenant_id=$1" +
      " AND ((status='planned' AND next_attempt_at<=now())" +
      "   OR (status='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=now()))" +
      " ORDER BY next_attempt_at,id LIMIT $2 FOR UPDATE SKIP LOCKED",
    [tenant, Math.max(1, Math.min(limit, EFFECT_LIMITS.claim_batch))],
  );
  const claims: ExternalEffectClaim[] = [];
  const settled = { outcome_unknown: 0, failed: 0 };
  for (const row of candidates.rows) {
    if (row.status === "claimed") {
      const exhausted = Number(row.attempt) >= Number(row.max_attempts);
      const safeToResend =
        row.io_started_at === null || row.provider_idempotent === true;
      if (!safeToResend || exhausted) {
        await q.query(
          "UPDATE workflow_external_effects SET status=$3,error_category=$4,error_summary=$5," +
            " lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()" +
            " WHERE tenant_id=$1 AND id=$2",
          [
            tenant,
            row.id,
            safeToResend ? "failed" : "outcome_unknown",
            safeToResend ? "transient" : "outcome_unknown",
            safeToResend
              ? "Attempt ceiling reached after a safe retry sequence"
              : "A previous attempt may have reached the provider and its outcome cannot be proven",
          ],
        );
        if (safeToResend) settled.failed += 1;
        else settled.outcome_unknown += 1;
        await wakeParkedRun(q, tenant, row.run_id);
        continue;
      }
    } else if (Number(row.attempt) >= Number(row.max_attempts)) {
      await q.query(
        "UPDATE workflow_external_effects SET status='failed',error_category='transient'," +
          " error_summary=$3,lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()" +
          " WHERE tenant_id=$1 AND id=$2",
        [tenant, row.id, "Attempt ceiling reached before any provider I/O"],
      );
      settled.failed += 1;
      await wakeParkedRun(q, tenant, row.run_id);
      continue;
    }
    const leaseToken = randomUUID();
    const claimed = await one(
      q,
      "UPDATE workflow_external_effects SET status='claimed',attempt=attempt+1,lease_token=$3," +
        " lease_expires_at=now()+($4 || ' seconds')::interval,claimed_at=now(),updated_at=now()," +
        " error_category=NULL,error_summary=NULL" +
        " WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [tenant, row.id, leaseToken, String(EFFECT_LIMITS.lease_seconds)],
    );
    if (!claimed) continue;
    claims.push({
      id: claimed.id,
      run_id: claimed.run_id,
      workflow_id: claimed.workflow_id,
      revision: Number(claimed.revision),
      step_seq: Number(claimed.step_seq),
      operation: claimed.operation,
      connection_id: claimed.connection_id,
      provider_key: claimed.provider_key,
      action: claimed.action,
      capability: claimed.capability,
      idempotency_key: claimed.idempotency_key,
      request_digest: claimed.request_digest,
      authority_kind: claimed.authority_kind,
      authority_user_id: claimed.authority_user_id,
      attempt: Number(claimed.attempt),
      max_attempts: Number(claimed.max_attempts),
      provider_idempotent: claimed.provider_idempotent === true,
      lease_token: leaseToken,
      reclaimed: row.status === "claimed",
    });
  }
  return { claims, settled };
}

/**
 * Records the I/O boundary in its own short transaction, immediately before the
 * provider call, and extends the lease so the call is covered. A crash before
 * this marker is provably safe to retry; a crash after it is not.
 */
export async function markExternalEffectIoStarted(
  q: Query,
  tenant: string,
  claim: ExternalEffectClaim,
): Promise<boolean> {
  const updated = await one(
    q,
    "UPDATE workflow_external_effects SET io_started_at=COALESCE(io_started_at,now())," +
      " lease_expires_at=now()+($4 || ' seconds')::interval,updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2 AND status='claimed' AND lease_token=$3 AND lease_expires_at>now()" +
      " RETURNING id",
    [
      tenant,
      claim.id,
      claim.lease_token,
      String(EFFECT_LIMITS.io_lease_seconds),
    ],
  );
  return Boolean(updated);
}

/** A refusal that happens BEFORE the I/O boundary, so nothing external occurred. */
export async function refuseExternalEffectBeforeIo(
  q: Query,
  tenant: string,
  claim: ExternalEffectClaim,
  input: { category: FailureCategory; summary: string; cancelled?: boolean },
): Promise<void> {
  await q.query(
    "UPDATE workflow_external_effects SET status=$3,error_category=$4,error_summary=$5," +
      " lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2 AND status='claimed' AND lease_token=$6",
    [
      tenant,
      claim.id,
      input.cancelled ? "cancelled" : "failed",
      input.cancelled ? null : input.category,
      String(input.summary).slice(0, EFFECT_LIMITS.max_summary),
      claim.lease_token,
    ],
  );
  await wakeParkedRun(q, tenant, claim.run_id);
}

export type EffectIoOutcome =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: unknown };

/**
 * Reads the delivery state an adapter reports for a failure. The default is
 * `unknown`, deliberately: an adapter that does not say must not be assumed to
 * have failed safely.
 */
export function effectDeliveryState(
  error: unknown,
): "not_sent" | "sent" | "unknown" {
  const candidates = [
    (error as { delivery_state?: unknown })?.delivery_state,
    (error as { details?: { delivery_state?: unknown } })?.details
      ?.delivery_state,
  ];
  for (const value of candidates)
    if (value === "not_sent" || value === "sent" || value === "unknown")
      return value;
  return "unknown";
}

/**
 * Commits the normalized outcome in a NEW short transaction, and only while this
 * worker's lease is still authoritative. A stale worker whose lease was reclaimed
 * writes nothing at all, so it can never overwrite a newer claimant's outcome.
 */
export async function commitExternalEffectOutcome(
  q: Query,
  tenant: string,
  claim: ExternalEffectClaim,
  outcome: EffectIoOutcome,
): Promise<"succeeded" | "failed" | "outcome_unknown" | "stale"> {
  const current = await one(
    q,
    "SELECT status,lease_token,lease_expires_at>now() AS live FROM workflow_external_effects" +
      " WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenant, claim.id],
  );
  if (
    !current ||
    current.status !== "claimed" ||
    current.lease_token !== claim.lease_token ||
    current.live !== true
  )
    return "stale";

  if (outcome.ok) {
    const result = boundedEffectResult(outcome.result || {});
    const reference = providerReferenceOf(outcome.result || {});
    await q.query(
      "UPDATE workflow_external_effects SET status='succeeded',result=$3,provider_reference=$4," +
        " error_category=NULL,error_summary=NULL,lease_token=NULL,lease_expires_at=NULL," +
        " completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant, claim.id, json(result), reference],
    );
    await wakeParkedRun(q, tenant, claim.run_id);
    return "succeeded";
  }

  const delivery = effectDeliveryState(outcome.error);
  const failure = classifyEffectError(outcome.error);
  const resendSafe = claim.provider_idempotent === true;
  if (delivery === "not_sent") {
    // Provably never reached the provider: an ordinary classified failure, which
    // the engine retries only when the category is genuinely retryable.
    await q.query(
      "UPDATE workflow_external_effects SET status='failed',error_category=$3,error_summary=$4," +
        " lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()" +
        " WHERE tenant_id=$1 AND id=$2",
      [tenant, claim.id, failure.category, failure.summary],
    );
    await wakeParkedRun(q, tenant, claim.run_id);
    return "failed";
  }
  if (resendSafe && failure.retryable) {
    // The provider offers an idempotency primitive, so a re-send with the same key
    // cannot duplicate the external operation.
    await q.query(
      "UPDATE workflow_external_effects SET status='failed',error_category=$3,error_summary=$4," +
        " lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()" +
        " WHERE tenant_id=$1 AND id=$2",
      [tenant, claim.id, failure.category, failure.summary],
    );
    await wakeParkedRun(q, tenant, claim.run_id);
    return "failed";
  }
  await q.query(
    "UPDATE workflow_external_effects SET status='outcome_unknown',error_category='outcome_unknown'," +
      " error_summary=$3,lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2",
    [
      tenant,
      claim.id,
      "The provider may have received this action and its outcome cannot be proven",
    ],
  );
  await wakeParkedRun(q, tenant, claim.run_id);
  return "outcome_unknown";
}

/** The provider-side idempotency/transaction reference an adapter may echo. */
export function providerReferenceOf(
  result: Record<string, unknown>,
): string | null {
  const value =
    (result.provider_reference as unknown) ??
    (result.idempotency_reference as unknown) ??
    (result.message_id as unknown);
  if (typeof value !== "string") return null;
  const bounded = value.slice(0, 200);
  return bounded.length ? bounded : null;
}

function boundedEffectResult(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = json(value);
  assert(
    Buffer.byteLength(serialized) <= EFFECT_LIMITS.max_result_bytes,
    400,
    "External effect result is too large",
  );
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  assertNonSecretEvidence(parsed);
  return parsed;
}

const SECRET_PATTERN =
  /secret_encrypted|refresh_token|access_token|bot_token|authorization:|password|client_secret|api_key/i;

/** Run/step and effect evidence must never carry credential material. */
export function assertNonSecretEvidence(value: unknown): void {
  const serialized = json(value ?? {});
  assert(
    !SECRET_PATTERN.test(serialized),
    400,
    "External effect evidence rejected: it contains credential material",
  );
}

function classifyEffectError(error: unknown): {
  category: FailureCategory;
  retryable: boolean;
  summary: string;
} {
  const status = (error as { statusCode?: number })?.statusCode;
  const message = String((error as Error)?.message || "");
  if (typeof status === "number") {
    const classified = classifyProviderFailure({ status });
    return {
      category: classified.category,
      retryable: classified.retryable,
      summary: classified.summary.slice(0, EFFECT_LIMITS.max_summary),
    };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message))
    return {
      category: "transient",
      retryable: true,
      summary: "Provider connection timeout".slice(
        0,
        EFFECT_LIMITS.max_summary,
      ),
    };
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(message))
    return {
      category: "transient",
      retryable: true,
      summary: "Provider connection failure".slice(
        0,
        EFFECT_LIMITS.max_summary,
      ),
    };
  const explicit = (error as { details?: { category?: string } })?.details
    ?.category;
  if (explicit && explicit !== "outcome_unknown")
    return {
      category: explicit as FailureCategory,
      retryable: isRetryableCategory(explicit as FailureCategory),
      summary: message.slice(0, EFFECT_LIMITS.max_summary),
    };
  // An adapter error with no status and no declared category is classified the way
  // the engine has always classified one: as a retryable transient condition. What
  // decides whether it may ACTUALLY be retried is the delivery state and the
  // provider's idempotency primitive, never this label.
  return {
    category: "transient",
    retryable: true,
    summary: message.slice(0, EFFECT_LIMITS.max_summary),
  };
}

/**
 * Re-derives the planned request from the run's IMMUTABLE pinned revision instead
 * of storing provider content, and proves it is the request the engine planned.
 */
export async function deriveEffectRequest(
  q: Query,
  tenant: string,
  claim: ExternalEffectClaim,
): Promise<
  | { ok: true; request: EffectRequest; provider_idempotent: boolean }
  | {
      ok: false;
      category: FailureCategory;
      summary: string;
      cancelled?: boolean;
    }
> {
  const run = await one(
    q,
    "SELECT id,status,workflow_id,revision FROM workflow_runs WHERE tenant_id=$1 AND id=$2",
    [tenant, claim.run_id],
  );
  if (!run)
    return {
      ok: false,
      category: "not_found",
      summary: "The run no longer exists",
    };
  if (run.status === "cancelled")
    return {
      ok: false,
      category: "authorization_revoked",
      summary: "The run was cancelled before the provider call",
      cancelled: true,
    };
  const revision = await one(
    q,
    "SELECT definition FROM workflow_revisions WHERE tenant_id=$1 AND workflow_id=$2 AND revision=$3",
    [tenant, run.workflow_id, claim.revision],
  );
  if (!revision)
    return {
      ok: false,
      category: "not_found",
      summary: "The run's pinned revision is missing",
    };
  const plan = planSteps(revision.definition as WorkflowDefinition);
  const step = plan.find((candidate) => candidate.seq === claim.step_seq);
  if (!step || step.operation !== claim.operation)
    return {
      ok: false,
      category: "validation",
      summary: "The planned step no longer matches the effect",
    };
  const definition = revision.definition as WorkflowDefinition;
  const node = definition.actions.find(
    (candidate) => candidate.id === step.node_id,
  );
  if (!node)
    return {
      ok: false,
      category: "validation",
      summary: "The planned action is missing from the revision",
    };
  const config = (node.config || {}) as Record<string, unknown>;
  const request: EffectRequest = {
    connection_id: String(config.connection_id),
    action: String(config.action),
    capability: String(config.capability),
    payload: (config.payload as Record<string, unknown>) || {},
  };
  if (
    request.connection_id !== claim.connection_id ||
    request.action !== claim.action ||
    request.capability !== claim.capability
  )
    return {
      ok: false,
      category: "validation",
      summary: "The planned request does not match the effect identity",
    };
  if (requestDigest(request) !== claim.request_digest)
    return {
      ok: false,
      category: "validation",
      summary: "The planned request digest does not match the effect",
    };
  return { ok: true, request, provider_idempotent: claim.provider_idempotent };
}

/**
 * The pre-execution authority re-check. It runs BEFORE the I/O boundary, inside a
 * short tenant transaction, and refuses on revoked membership, revoked capability,
 * a disabled/revoked connection or lost ownership reach. Nothing external has
 * happened at this point, so a refusal is safe and honest.
 */
export async function effectAuthorityRefusal(
  q: Query,
  tenant: string,
  claim: ExternalEffectClaim,
  inspectConnection: (
    q: Query,
    tenant: string,
    connectionId: string,
  ) => Promise<ConnectionActionFacts | null> = connectionActionFacts,
): Promise<{ category: FailureCategory; summary: string } | null> {
  const run = await one(
    q,
    "SELECT authority FROM workflow_runs WHERE tenant_id=$1 AND id=$2",
    [tenant, claim.run_id],
  );
  if (!run)
    return { category: "not_found", summary: "The run no longer exists" };
  const membership = await one(
    q,
    "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active",
    [tenant, claim.authority_user_id],
  );
  if (!membership)
    return {
      category: "authorization_revoked",
      summary: "The run's authority is no longer an active member",
    };
  if (claim.authority_kind === "service_principal") {
    const principal = await one(
      q,
      "SELECT capabilities FROM tenant_automation_principals WHERE tenant_id=$1",
      [tenant],
    );
    const granted: string[] = Array.isArray(principal?.capabilities)
      ? principal.capabilities
      : [];
    if (!principal || !granted.includes("connector.action"))
      return {
        category: "capability_missing",
        summary:
          "The tenant automation identity no longer holds the connector action capability",
      };
  }
  const facts = await inspectConnection(q, tenant, claim.connection_id);
  if (!facts)
    return {
      category: "not_found",
      summary: "The connection no longer exists",
    };
  const denial = connectorReachDenial({
    facts,
    capability: claim.capability,
    authority_kind: claim.authority_kind,
    authority_user_id: claim.authority_user_id,
    actor_role: String(membership.role),
  });
  if (denial)
    return {
      category: "capability_missing",
      summary: `Connector access denied: ${denial}`,
    };
  return null;
}

export type ExternalEffectDeps = {
  /** Provider invocation seam. Defaults to the governed connector adapter call. */
  invokeProvider?: (input: {
    provider_key: string;
    action: string;
    capability: string;
    payload: Record<string, unknown>;
    effect: { idempotency_key: string; attempt: number };
  }) => Promise<Record<string, unknown>>;
  /**
   * The live connection facts the worker re-checks before the I/O boundary.
   * Defaults to the real tenant read; the engine-level suites inject the same
   * deterministic facts their connector port already returns, while the dedicated
   * external-effect acceptance exercises the real path (including revocation).
   */
  inspectConnection?: (
    q: Query,
    tenant: string,
    connectionId: string,
  ) => Promise<ConnectionActionFacts | null>;
  now?: () => Date;
  claimLimit?: number;
};

/**
 * One bounded external-effect phase for a tenant.
 *
 * The provider call happens between two short transactions and with NO database
 * transaction or row lock held: the claim transaction has committed, and the
 * outcome transaction has not started. That is the property the acceptance proves
 * from the runtime (a provider that observes an open tenant transaction fails the
 * test) rather than from documentation.
 */
export async function externalEffectTick(
  db: Database,
  tenant: string,
  deps: ExternalEffectDeps = {},
): Promise<{
  claimed: number;
  succeeded: number;
  failed: number;
  refused: number;
  outcome_unknown: number;
  stale: number;
  invoked: number;
}> {
  const invoke =
    deps.invokeProvider ??
    ((input) =>
      invokeProviderAction({
        provider_key: input.provider_key,
        action: input.action,
        capability: input.capability,
        payload: input.payload,
        effect: input.effect,
      }));
  const { claims, settled } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(
      q,
      tenant,
      deps.claimLimit ?? EFFECT_LIMITS.claim_batch,
    ),
  );
  let succeeded = 0,
    failed = settled.failed,
    refused = 0,
    outcomeUnknown = settled.outcome_unknown,
    stale = 0,
    invoked = 0;

  for (const claim of claims) {
    // 1. The request is re-derived from the immutable revision (no content stored).
    const derived = await db.tenant(tenant, (q) =>
      deriveEffectRequest(q, tenant, claim),
    );
    if (!derived.ok) {
      await db.tenant(tenant, (q) =>
        refuseExternalEffectBeforeIo(q, tenant, claim, {
          category: derived.category,
          summary: derived.summary,
          cancelled: derived.cancelled === true,
        }),
      );
      refused += 1;
      continue;
    }
    // 2. Live authority and connection reach are re-checked before the boundary.
    const denial = await db.tenant(tenant, (q) =>
      effectAuthorityRefusal(q, tenant, claim, deps.inspectConnection),
    );
    if (denial) {
      await db.tenant(tenant, (q) =>
        refuseExternalEffectBeforeIo(q, tenant, claim, {
          category: denial.category,
          summary: denial.summary,
        }),
      );
      refused += 1;
      continue;
    }
    // 3. Mark the boundary in its own short transaction. After this point the
    //    outcome is either committed honestly or reported as unknown.
    const marked = await db.tenant(tenant, (q) =>
      markExternalEffectIoStarted(q, tenant, claim),
    );
    if (!marked) {
      stale += 1;
      continue;
    }
    // 4. Provider I/O with no transaction and no row lock held.
    let outcome: EffectIoOutcome;
    invoked += 1;
    try {
      outcome = {
        ok: true,
        result: await invoke({
          provider_key: claim.provider_key,
          action: claim.action,
          capability: claim.capability,
          payload: derived.request.payload,
          effect: {
            idempotency_key: claim.idempotency_key,
            attempt: claim.attempt,
          },
        }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    // 5. Commit in a new short transaction, only if this lease is still authoritative.
    const committed = await db.tenant(tenant, (q) =>
      commitExternalEffectOutcome(q, tenant, claim, outcome),
    );
    if (committed === "stale") stale += 1;
    else if (committed === "succeeded") succeeded += 1;
    else if (committed === "outcome_unknown") outcomeUnknown += 1;
    else failed += 1;
  }
  return {
    claimed: claims.length,
    succeeded,
    failed,
    refused,
    outcome_unknown: outcomeUnknown,
    stale,
    invoked,
  };
}

/** The connector half of the operator surface: bounded, count-only effect health. */
export async function externalEffectMetricsForTenant(
  q: Query,
  tenant: string,
): Promise<Record<string, number>> {
  const row = await one(
    q,
    "SELECT" +
      " (SELECT count(*)::int FROM workflow_external_effects WHERE tenant_id=$1 AND status='planned') AS planned," +
      " (SELECT count(*)::int FROM workflow_external_effects WHERE tenant_id=$1 AND status='claimed') AS claimed," +
      " (SELECT count(*)::int FROM workflow_external_effects WHERE tenant_id=$1 AND status='succeeded') AS succeeded," +
      " (SELECT count(*)::int FROM workflow_external_effects WHERE tenant_id=$1 AND status='failed') AS failed," +
      " (SELECT count(*)::int FROM workflow_external_effects WHERE tenant_id=$1 AND status='outcome_unknown') AS outcome_unknown," +
      " (SELECT count(*)::int FROM workflow_external_effects WHERE tenant_id=$1 AND status='cancelled') AS cancelled",
    [tenant],
  );
  return {
    planned: Number(row?.planned || 0),
    claimed: Number(row?.claimed || 0),
    succeeded: Number(row?.succeeded || 0),
    failed: Number(row?.failed || 0),
    outcome_unknown: Number(row?.outcome_unknown || 0),
    cancelled: Number(row?.cancelled || 0),
  };
}
