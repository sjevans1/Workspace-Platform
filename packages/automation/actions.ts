/**
 * W30-A: the workflow action registry.
 *
 * An action is the only place a workflow is allowed to touch the workspace. Each
 * action declares the config it accepts, whether it is safe to repeat, and the
 * authority a service principal must hold to run it. The registry is the
 * boundary: the engine can only execute a key it finds here, so an unknown
 * operation fails closed at definition time rather than at run time.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError, assert, json } from "../contracts/index.ts";
import type { Query } from "../database/index.ts";
import { one } from "../database/index.ts";
import type { Actor } from "../auth/index.ts";
import { emit } from "../events/index.ts";
import { requireAccess } from "../permissions/index.ts";
import { isCapability, type Capability } from "../connectors/index.ts";
import {
  connectorReachDenial,
  isRetryableCategory,
  providerActionIdempotent,
  type FailureCategory,
} from "../connectors/index.ts";
import {
  EFFECT_LIMITS,
  ensureExternalEffect,
  externalEffectEvidence,
  type ExternalEffectRow,
} from "./effects.ts";
import {
  createRecord,
  updateRecordCanonical,
} from "../../apps/api/src/domain.ts";
import type { WorkflowAction } from "./dsl.ts";
import type { RunAuthority } from "./engine.ts";

/**
 * The port the engine uses to reach the connector plane without the automation
 * package importing a provider adapter.
 *
 * W29-P0/A1: it is deliberately INSPECT-ONLY. The engine plans a durable external
 * effect and a worker executes it outside every tenant transaction, so there is no
 * longer any way for a workflow step to perform provider I/O while a database
 * transaction is held. Provider invocation lives behind
 * `invokeProviderAction` in the connectors package, which the external-effect
 * worker phase calls with no transaction open.
 */
export type ConnectorActionPort = {
  inspect(input: {
    tenant_id: string;
    connection_id: string;
    actor_role: "owner" | "admin" | "member" | "guest";
    user_id: string | null;
  }): Promise<{
    exists: boolean;
    enabled: boolean;
    status: string;
    ownership: string;
    owner_user_id: string | null;
    capabilities_granted: string[];
    provider_key: string;
  } | null>;
};

export type ActionExecutionContext = {
  q: Query;
  tenant_id: string;
  actor: Actor;
  authority: RunAuthority;
  run: { id: string; workflow_id: string; revision: number };
  action: WorkflowAction;
  step: { seq: number; attempt: number };
  connectorPort: ConnectorActionPort;
};

export type ActionDefinition = {
  key: string;
  display_name: string;
  kind: "workspace" | "connector" | "control";
  retryable: boolean;
  /** Authority capability a SERVICE PRINCIPAL must hold to run this action. */
  service_capability: string;
  describe(): Record<string, unknown>;
  validate(config: Record<string, unknown>): Record<string, unknown>;
  run(
    context: ActionExecutionContext & { config: Record<string, unknown> },
  ): Promise<{ result: Record<string, unknown>; waiting_until?: Date }>;
};

const ACTIONS = new Map<string, ActionDefinition>();

/** Registration is idempotent so importing the package twice cannot double-register. */
export function registerAction(definition: ActionDefinition): void {
  ACTIONS.set(definition.key, definition);
}

export function actionFor(key: string): ActionDefinition {
  const definition = ACTIONS.get(key);
  assert(definition, 400, `Unknown workflow operation: ${key}`);
  return definition!;
}

export function actionCatalog(): {
  key: string;
  display_name: string;
  kind: string;
  retryable: boolean;
}[] {
  return [...ACTIONS.values()]
    .map((definition) => ({
      key: definition.key,
      display_name: definition.display_name,
      kind: definition.kind,
      retryable: definition.retryable,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * A stable identifier derived from a run and step, so a repeated execution of the
 * same step addresses the same row. It is shaped like a v4 UUID (version and
 * variant nibbles forced) because the storage columns are uuid, but it is a
 * deterministic function of its inputs, not a random value.
 */
export function deterministicUuid(...parts: (string | number)[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part)).join("\u0000"))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseConfig<T>(
  schema: z.ZodType<T>,
  config: Record<string, unknown>,
  key: string,
): T {
  const result = schema.safeParse(config ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ")
      .slice(0, 300);
    throw new HttpError(400, `Invalid configuration for ${key}: ${detail}`);
  }
  return result.data;
}

function boundedResult(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = json(value ?? {});
  assert(
    Buffer.byteLength(serialized) <= 4096,
    400,
    "Action result is too large",
  );
  return JSON.parse(serialized);
}

const notificationConfigSchema = z
  .object({
    resource_id: z.string().uuid(),
    user_id: z.string().uuid().optional(),
    message: z.string().min(1).max(500),
  })
  .strict();

const recordCreateConfigSchema = z
  .object({
    database_id: z.string().uuid(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const recordUpdateConfigSchema = z
  .object({
    record_id: z.string().uuid(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const webhookEmitConfigSchema = z
  .object({
    event_type: z.string().regex(/^workflow\.[a-z0-9][a-z0-9._-]{2,80}$/),
    resource_id: z.string().uuid().optional(),
  })
  .strict();

const connectorInvokeConfigSchema = z
  .object({
    connection_id: z.string().uuid(),
    action: z.string().min(1).max(120),
    capability: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const delayConfigSchema = z
  .object({ seconds: z.number().int().min(1).max(3600) })
  .strict();

const notificationCreate: ActionDefinition = {
  key: "workspace.notification.create",
  display_name: "Create a notification",
  kind: "workspace",
  retryable: true,
  service_capability: "notification.create",
  describe() {
    return {
      key: this.key,
      display_name: this.display_name,
      kind: this.kind,
      retryable: this.retryable,
      service_capability: this.service_capability,
      config: {
        resource_id: "uuid",
        user_id: "uuid (optional, defaults to the run's authority user)",
        message: "string (1..500)",
      },
    };
  },
  validate(config) {
    return parseConfig(
      notificationConfigSchema,
      config,
      "workspace.notification.create",
    ) as Record<string, unknown>;
  },
  async run(context) {
    const { q, actor, config, run, step } = context;
    const resourceId = String(config.resource_id);
    // Read access to the resource is required before a notification about it may exist.
    await requireAccess(q, actor, resourceId, 1);
    const userId = config.user_id ? String(config.user_id) : actor.user_id;
    const membership = await one(
      q,
      "SELECT 1 AS present FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active",
      [actor.tenant_id, userId],
    );
    assert(
      membership,
      400,
      "Notification recipient is not an active member of this workspace",
    );
    const notificationId = deterministicUuid(run.id, step.seq, "notification");
    await q.query(
      "INSERT INTO notifications(id,tenant_id,user_id,resource_id,message) VALUES($1,$2,$3,$4,$5)" +
        " ON CONFLICT(id) DO NOTHING",
      [
        notificationId,
        actor.tenant_id,
        userId,
        resourceId,
        String(config.message),
      ],
    );
    await emit(q, actor, "notification.created", resourceId);
    return {
      result: {
        notification_id: notificationId,
        resource_id: resourceId,
        user_id: userId,
      },
    };
  },
};

const recordCreate: ActionDefinition = {
  key: "workspace.record.create",
  display_name: "Create a database record",
  kind: "workspace",
  // Creating is not safe to repeat in general, so it is never retried. The
  // deterministic id below is what keeps a resumed step from duplicating a record.
  retryable: false,
  service_capability: "record.create",
  describe() {
    return {
      key: this.key,
      display_name: this.display_name,
      kind: this.kind,
      retryable: this.retryable,
      service_capability: this.service_capability,
      config: { database_id: "uuid", values: "object" },
    };
  },
  validate(config) {
    return parseConfig(
      recordCreateConfigSchema,
      config,
      "workspace.record.create",
    ) as Record<string, unknown>;
  },
  async run(context) {
    const { q, actor, config, run, step } = context;
    const databaseId = String(config.database_id);
    const values = (config.values || {}) as Record<string, unknown>;
    const recordId = deterministicUuid(run.id, step.seq, "record");
    const created = await createRecord(q, actor, databaseId, values, recordId);
    return { result: { record_id: created.id, database_id: databaseId } };
  },
};

const recordUpdate: ActionDefinition = {
  key: "workspace.record.update",
  display_name: "Update a database record",
  kind: "workspace",
  // A stale-revision conflict is a genuinely retryable condition.
  retryable: true,
  service_capability: "record.update",
  describe() {
    return {
      key: this.key,
      display_name: this.display_name,
      kind: this.kind,
      retryable: this.retryable,
      service_capability: this.service_capability,
      config: { record_id: "uuid", values: "object" },
    };
  },
  validate(config) {
    return parseConfig(
      recordUpdateConfigSchema,
      config,
      "workspace.record.update",
    ) as Record<string, unknown>;
  },
  async run(context) {
    const { q, actor, config } = context;
    const recordId = String(config.record_id);
    const values = (config.values || {}) as Record<string, unknown>;
    const current = await one(
      q,
      "SELECT revision FROM database_records WHERE resource_id=$1",
      [recordId],
    );
    assert(current, 404, "Record not found");
    const updated = await updateRecordCanonical(
      q,
      actor,
      recordId,
      values,
      Number(current.revision),
    );
    return { result: { record_id: recordId, revision: updated.revision } };
  },
};

const webhookEmit: ActionDefinition = {
  key: "workspace.webhook.emit",
  display_name: "Emit a webhook event",
  kind: "workspace",
  retryable: true,
  service_capability: "webhook.emit",
  describe() {
    return {
      key: this.key,
      display_name: this.display_name,
      kind: this.kind,
      retryable: this.retryable,
      service_capability: this.service_capability,
      config: {
        event_type: "string matching /^workflow\\.[a-z0-9][a-z0-9._-]{2,80}$/",
        resource_id: "uuid (optional)",
      },
    };
  },
  validate(config) {
    return parseConfig(
      webhookEmitConfigSchema,
      config,
      "workspace.webhook.emit",
    ) as Record<string, unknown>;
  },
  async run(context) {
    const { q, actor, config } = context;
    const eventType = String(config.event_type);
    const resourceId = config.resource_id ? String(config.resource_id) : null;
    // Reuses the accepted outbox + audit machinery, so the existing worker delivers
    // this to every matching subscription with the same signature and retry policy.
    await emit(q, actor, eventType, resourceId);
    return { result: { event_type: eventType } };
  },
};

const connectorInvoke: ActionDefinition = {
  key: "connector.action.invoke",
  display_name: "Invoke a connected provider action",
  kind: "connector",
  retryable: true,
  service_capability: "connector.action",
  describe() {
    return {
      key: this.key,
      display_name: this.display_name,
      kind: this.kind,
      retryable: this.retryable,
      service_capability: this.service_capability,
      config: {
        connection_id: "uuid",
        action: "string",
        capability: "connector capability",
        payload: "object (optional)",
      },
    };
  },
  validate(config) {
    const parsed = parseConfig(
      connectorInvokeConfigSchema,
      config,
      "connector.action.invoke",
    ) as Record<string, unknown>;
    assert(
      isCapability(parsed.capability),
      400,
      `Unknown connector capability: ${String(parsed.capability)}`,
    );
    return parsed;
  },
  async run(context) {
    const { q, config, authority, actor, connectorPort, tenant_id, run, step } =
      context;
    const connectionId = String(config.connection_id);
    const capability = config.capability as Capability;
    const action = String(config.action);
    const payload = (config.payload as Record<string, unknown>) || {};

    const denied = (reason: string): HttpError => {
      const error = new HttpError(403, `Connector access denied: ${reason}`);
      // `fatal` lets the engine classify this as capability_missing rather than a
      // transient authorization failure, so the run settles instead of retrying.
      (error as HttpError & { details?: { fatal?: boolean } }).details = {
        fatal: true,
      };
      return error;
    };

    const inspected = await connectorPort.inspect({
      tenant_id,
      connection_id: connectionId,
      actor_role: actor.role,
      user_id: authority.user_id ?? actor.user_id ?? null,
    });
    if (!inspected || !inspected.exists) throw denied("connection not found");
    // The reach rule is one pure function, shared with the worker phase that
    // re-checks it immediately before provider I/O.
    const reachDenial = connectorReachDenial({
      facts: inspected,
      capability,
      authority_kind: authority.kind,
      authority_user_id: authority.user_id ?? actor.user_id ?? null,
      actor_role: actor.role,
    });
    if (reachDenial) throw denied(reachDenial);

    // W29-P0/A1: the provider is NOT invoked here. The action plans (or reuses) a
    // durable external effect and the step parks until a worker has executed it
    // outside every tenant transaction. See packages/automation/effects.ts.
    const authorityUserId = authority.user_id ?? actor.user_id;
    assert(
      authorityUserId,
      403,
      "Connector action requires a resolved authority",
    );
    const effect = await ensureExternalEffect(q, tenant_id, {
      run_id: run.id,
      workflow_id: run.workflow_id,
      revision: run.revision,
      step_seq: step.seq,
      step_attempt: step.attempt,
      operation: connectorInvoke.key,
      connection_id: connectionId,
      provider_key: inspected.provider_key,
      action,
      capability,
      provider_idempotent: providerActionIdempotent(
        inspected.provider_key,
        action,
      ),
      authority_kind: authority.kind,
      authority_user_id: String(authorityUserId),
      request: { connection_id: connectionId, action, capability, payload },
    });

    const evidence = externalEffectEvidence(effect);
    if (effect.status === "succeeded")
      return {
        result: boundedResult({
          ...((effect.result as Record<string, unknown>) || {}),
          external_effect: evidence,
        }),
      };
    if (
      effect.status === "failed" ||
      effect.status === "outcome_unknown" ||
      effect.status === "cancelled"
    )
      throw effectFailure(effect);
    // planned or claimed: the worker owns the outcome now, so the step waits for
    // the durable state rather than holding the run's transaction open.
    return {
      result: { external_effect: evidence },
      waiting_until: new Date(Date.now() + EFFECT_LIMITS.poll_seconds * 1000),
    };
  },
};

/**
 * Turns a terminal external-effect state into the step failure the engine
 * records. `outcome_unknown` is never retryable and never reported as success:
 * the provider may have received the action, so only a human may re-attempt it.
 */
function effectFailure(effect: ExternalEffectRow): HttpError {
  const category = String(
    effect.status === "cancelled"
      ? effect.error_category || "authorization_revoked"
      : effect.error_category || "outcome_unknown",
  );
  const summary =
    effect.status === "cancelled"
      ? String(
          effect.error_summary ||
            "The run was cancelled before the provider call",
        )
      : effect.status === "outcome_unknown"
        ? "The provider may have received this action and its outcome cannot be proven"
        : String(
            effect.error_summary ||
              "The provider action failed before any external effect",
          );
  const error = new HttpError(
    409,
    `External effect ${effect.status}: ${summary}`,
  );
  // A failure that provably never reached the provider is retryable under the
  // engine's own bounded policy; an unprovable or cancelled effect is fatal, so no
  // automatic retry can duplicate or obscure it.
  const retryable =
    effect.status === "failed" &&
    isRetryableCategory(category as FailureCategory);
  (
    error as HttpError & {
      details?: { fatal?: boolean; category?: string; effect_id?: string };
    }
  ).details = {
    fatal: !retryable,
    category: category === "outcome_unknown" ? "outcome_unknown" : category,
    effect_id: String(effect.id),
  };
  return error;
}

const workflowDelay: ActionDefinition = {
  key: "workflow.delay",
  display_name: "Wait before the next action",
  kind: "control",
  // A delay is a pure state change: re-entering it after a restart simply re-arms
  // the same wait, so retrying it is meaningless and harmless.
  retryable: false,
  service_capability: "workflow.delay",
  describe() {
    return {
      key: this.key,
      display_name: this.display_name,
      kind: this.kind,
      retryable: this.retryable,
      service_capability: this.service_capability,
      config: { seconds: "integer (1..3600)" },
    };
  },
  validate(config) {
    return parseConfig(delayConfigSchema, config, "workflow.delay") as Record<
      string,
      unknown
    >;
  },
  async run(context) {
    const seconds = Number(context.config.seconds);
    return {
      result: { delayed_seconds: seconds },
      waiting_until: new Date(Date.now() + seconds * 1000),
    };
  },
};

/** Every action the runtime ships, in a fixed order so registration is reproducible. */
export const STANDARD_ACTION_DEFINITIONS: ActionDefinition[] = [
  notificationCreate,
  recordCreate,
  recordUpdate,
  webhookEmit,
  connectorInvoke,
  workflowDelay,
];

export function registerStandardActions(): void {
  for (const definition of STANDARD_ACTION_DEFINITIONS)
    registerAction(definition);
}

// Register at module load so importing the DSL alone is enough to validate a
// definition; the package index registers the same set again (idempotently).
registerStandardActions();
