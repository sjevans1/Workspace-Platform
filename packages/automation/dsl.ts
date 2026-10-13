/**
 * W30-A: the workflow definition language.
 *
 * A definition is a pure data document (Trigger -> Conditions -> Actions). It is
 * parsed strictly and compiled to a deterministic plan, and both the definition
 * and the plan are content-addressed by a digest, so a run can be pinned to the
 * exact revision that produced it and a retry or a worker restart can never drift
 * onto a different plan. Nothing here calls a model, the clock, the database or
 * the shell: `planSteps` is a pure function of the definition alone.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError, assert, json } from "../contracts/index.ts";
import { actionFor } from "./actions.ts";
import { isValidTimezone, parseCron, parseInstant } from "./schedule.ts";
import { isWorkspaceEventPattern } from "./triggers.ts";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

/**
 * Hard bounds on what a tenant may define. They exist so no workflow can turn
 * into an unbounded queue, an unbounded fan-out or a sub-minute poll, and so the
 * definition, the plan and the persisted trigger context all stay small enough to
 * fit their database byte limits.
 */
export const WORKFLOW_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  max_conditions: 8,
  max_condition_depth: 3,
  max_actions: 10,
  max_definition_bytes: 32768,
  max_workflows_per_tenant: 100,
  max_concurrent_runs_per_tenant: 4,
  max_run_history_per_tenant: 5000,
  run_retention_days: 30,
  step_timeout_seconds: 60,
  max_delay_seconds: 3600,
  max_schedule_frequency_seconds: 60,
  max_trigger_ref_bytes: 4096,
  max_runs_per_tick: 4,
  max_schedule_fire_per_tick: 8,
  prune_batch: 200,
});

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "empty"
  | "not_empty"
  | "boolean";

export type ConditionLeaf = {
  id: string;
  kind: "leaf";
  path: string;
  operator: ConditionOperator;
  value?: unknown;
};
export type ConditionGroup = {
  id: string;
  kind: "all" | "any";
  conditions: WorkflowCondition[];
};
export type WorkflowCondition = ConditionLeaf | ConditionGroup;
export type WorkflowAction = {
  id: string;
  operation: string;
  config: Record<string, unknown>;
};

export type WorkflowTrigger =
  | { id: string; type: "manual" }
  | {
      id: string;
      type: "schedule";
      kind: "one_time" | "interval" | "cron";
      at?: string;
      every_seconds?: number;
      expression?: string;
      timezone: string;
      missed_policy: "skip" | "catch_up_once";
    }
  | { id: string; type: "workspace_event"; event_types: string[] }
  | {
      id: string;
      type: "connector_event";
      event_types: string[];
      provider_keys?: string[];
      connection_ids?: string[];
    };

export type WorkflowDefinition = {
  schema_version: 1;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
};

export type PlannedStep = {
  seq: number;
  step_type: "trigger" | "condition" | "action";
  operation: string;
  node_id: string;
};

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CONDITION_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+){0,5}$/;
const OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "not_empty",
  "boolean",
] as const;
const CRON_MAX_BYTES = 200;

const conditionLeafSchema = z
  .object({
    id: z.string().regex(NODE_ID),
    kind: z.literal("leaf"),
    path: z.string().max(128).regex(CONDITION_PATH),
    operator: z.enum(OPERATORS),
    value: z.unknown().optional(),
  })
  .strict();

const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(NODE_ID),
      kind: z.enum(["all", "any"]),
      conditions: z.array(conditionSchema).max(WORKFLOW_LIMITS.max_conditions),
    })
    .strict(),
) as unknown as z.ZodType<ConditionGroup>;

const conditionSchema: z.ZodType<WorkflowCondition> = z.lazy(() =>
  z.union([conditionGroupSchema, conditionLeafSchema]),
) as unknown as z.ZodType<WorkflowCondition>;

const manualTriggerSchema = z
  .object({ id: z.string().regex(NODE_ID), type: z.literal("manual") })
  .strict();

const scheduleTriggerSchema = z
  .object({
    id: z.string().regex(NODE_ID),
    type: z.literal("schedule"),
    kind: z.enum(["one_time", "interval", "cron"]),
    at: z.string().min(1).max(64).optional(),
    every_seconds: z.number().int().positive().optional(),
    expression: z.string().min(1).max(CRON_MAX_BYTES).optional(),
    timezone: z.string().min(1).max(64),
    missed_policy: z.enum(["skip", "catch_up_once"]),
  })
  .strict()
  .superRefine((trigger, ctx) => {
    const zoneOk = isValidTimezone(trigger.timezone);
    if (!zoneOk)
      ctx.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "Unknown timezone",
      });
    if (trigger.kind === "one_time") {
      if (!trigger.at)
        ctx.addIssue({
          code: "custom",
          path: ["at"],
          message: "A one_time schedule requires at",
        });
      else if (zoneOk && !parseInstant(trigger.at, trigger.timezone))
        ctx.addIssue({
          code: "custom",
          path: ["at"],
          message: "at must be an ISO 8601 instant",
        });
      if (
        trigger.every_seconds !== undefined ||
        trigger.expression !== undefined
      )
        ctx.addIssue({
          code: "custom",
          message:
            "A one_time schedule takes neither every_seconds nor expression",
        });
      return;
    }
    if (trigger.kind === "interval") {
      if (trigger.at !== undefined || trigger.expression !== undefined)
        ctx.addIssue({
          code: "custom",
          message: "An interval schedule takes neither at nor expression",
        });
      if (trigger.every_seconds === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["every_seconds"],
          message: "An interval schedule requires every_seconds",
        });
      else if (
        trigger.every_seconds < WORKFLOW_LIMITS.max_schedule_frequency_seconds
      )
        ctx.addIssue({
          code: "custom",
          path: ["every_seconds"],
          message: "Schedule frequency is below the supported minimum",
        });
      return;
    }
    if (trigger.at !== undefined || trigger.every_seconds !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "A cron schedule takes neither at nor every_seconds",
      });
    if (!trigger.expression)
      ctx.addIssue({
        code: "custom",
        path: ["expression"],
        message: "A cron schedule requires expression",
      });
    else if (!parseCron(trigger.expression))
      ctx.addIssue({
        code: "custom",
        path: ["expression"],
        message: "Cron expression must have 5 fields",
      });
  });

const workspaceEventTriggerSchema = z
  .object({
    id: z.string().regex(NODE_ID),
    type: z.literal("workspace_event"),
    event_types: z.array(z.string().min(1).max(120)).min(1).max(16),
  })
  .strict()
  .superRefine((trigger, ctx) => {
    for (const eventType of trigger.event_types)
      if (!isWorkspaceEventPattern(eventType))
        ctx.addIssue({
          code: "custom",
          path: ["event_types"],
          message: `Unknown workspace event type: ${eventType}`,
        });
  });

const connectorEventTriggerSchema = z
  .object({
    id: z.string().regex(NODE_ID),
    type: z.literal("connector_event"),
    event_types: z.array(z.string().min(1).max(120)).min(1).max(16),
    provider_keys: z.array(z.string().min(1).max(64)).max(16).optional(),
    connection_ids: z.array(z.string().uuid()).max(16).optional(),
  })
  .strict();

const triggerSchema = z.union([
  manualTriggerSchema,
  scheduleTriggerSchema,
  workspaceEventTriggerSchema,
  connectorEventTriggerSchema,
]);

const actionSchema = z
  .object({
    id: z.string().regex(NODE_ID),
    operation: z.string().min(1).max(120),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

const definitionSchema = z
  .object({
    schema_version: z.literal(1),
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(WORKFLOW_LIMITS.max_conditions),
    actions: z.array(actionSchema).min(1).max(WORKFLOW_LIMITS.max_actions),
  })
  .strict()
  .superRefine((definition, ctx) => {
    for (const condition of definition.conditions)
      if (conditionDepth(condition) > WORKFLOW_LIMITS.max_condition_depth)
        ctx.addIssue({
          code: "custom",
          path: ["conditions"],
          message: "Condition nesting is too deep",
        });
  });

function conditionDepth(condition: WorkflowCondition): number {
  if (condition.kind === "leaf") return 1;
  let deepest = 0;
  for (const child of condition.conditions)
    deepest = Math.max(deepest, conditionDepth(child));
  return 1 + deepest;
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "definition"}: ${issue.message}`)
    .join("; ")
    .slice(0, 300);
}

/**
 * Parses and normalizes a workflow definition. Strict by design: unknown keys,
 * unknown operators, an unknown action, a payload outside an action's bounds, an
 * unsupported timezone or an oversized document are all rejected with a 400
 * rather than accepted and puzzled over at run time.
 */
export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  const result = definitionSchema.safeParse(input);
  if (!result.success)
    throw new HttpError(
      400,
      `Invalid workflow definition: ${issueText(result.error)}`,
    );
  const parsed = result.data as WorkflowDefinition;

  const actions: WorkflowAction[] = [];
  let actionBytes = 0;
  for (const action of parsed.actions) {
    const definition = actionFor(action.operation);
    const config = definition.validate(action.config);
    actionBytes += Buffer.byteLength(json(config));
    actions.push({ id: action.id, operation: action.operation, config });
  }
  void actionBytes;

  const normalized: WorkflowDefinition = {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    trigger: parsed.trigger,
    conditions: parsed.conditions,
    actions,
  };
  assert(
    Buffer.byteLength(canonicalDefinition(normalized)) <=
      WORKFLOW_LIMITS.max_definition_bytes,
    400,
    "Workflow definition is too large",
  );
  return normalized;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort())
      ordered[key] = sortValue(source[key]);
    return ordered;
  }
  return value;
}

/** Stable JSON with keys sorted, so two logically equal definitions hash the same. */
export function canonicalDefinition(definition: WorkflowDefinition): string {
  return json(sortValue(definition));
}

export function definitionDigest(definition: WorkflowDefinition): string {
  return createHash("sha256")
    .update(canonicalDefinition(definition))
    .digest("hex");
}

/**
 * Compiles a definition to an ordered plan. The trigger is step one, then one
 * step per top-level condition, then one step per action, in document order. The
 * result depends only on the definition, so `planSteps` called twice on the same
 * revision is byte-identical and a run can be pinned to it by digest.
 */
export function planSteps(definition: WorkflowDefinition): PlannedStep[] {
  const steps: PlannedStep[] = [];
  let seq = 1;
  steps.push({
    seq: seq++,
    step_type: "trigger",
    operation: `trigger.${definition.trigger.type}`,
    node_id: definition.trigger.id,
  });
  for (const condition of definition.conditions) {
    steps.push({
      seq: seq++,
      step_type: "condition",
      operation:
        condition.kind === "leaf"
          ? "condition.leaf"
          : `condition.${condition.kind}`,
      node_id: condition.id,
    });
  }
  for (const action of definition.actions) {
    steps.push({
      seq: seq++,
      step_type: "action",
      operation: action.operation,
      node_id: action.id,
    });
  }
  return steps;
}

export function planDigest(plan: PlannedStep[]): string {
  return createHash("sha256").update(json(plan)).digest("hex");
}

/** The schedule trigger of a definition, if it has one, described for storage. */
export function scheduledTriggers(definition: WorkflowDefinition): {
  trigger_id: string;
  kind: "one_time" | "interval" | "cron";
  expression: string;
  timezone: string;
  missed_policy: "skip" | "catch_up_once";
}[] {
  const trigger = definition.trigger;
  if (trigger.type !== "schedule") return [];
  const expression =
    trigger.kind === "cron"
      ? trigger.expression || ""
      : trigger.kind === "interval"
        ? String(trigger.every_seconds ?? "")
        : trigger.at || "";
  return [
    {
      trigger_id: trigger.id,
      kind: trigger.kind,
      expression,
      timezone: trigger.timezone,
      missed_policy: trigger.missed_policy,
    },
  ];
}

export function describeTrigger(definition: WorkflowDefinition): {
  type: string;
  label: string;
  summary: string;
} {
  const trigger = definition.trigger;
  if (trigger.type === "manual")
    return {
      type: "manual",
      label: "Manual",
      summary: "Runs only when a member triggers it",
    };
  if (trigger.type === "workspace_event")
    return {
      type: "workspace_event",
      label: "Workspace event",
      summary: trigger.event_types.join(", "),
    };
  if (trigger.type === "connector_event") {
    const providers =
      trigger.provider_keys && trigger.provider_keys.length
        ? ` from ${trigger.provider_keys.join(", ")}`
        : "";
    return {
      type: "connector_event",
      label: "Connector event",
      summary: `${trigger.event_types.join(", ")}${providers}`,
    };
  }
  if (trigger.kind === "cron")
    return {
      type: "schedule",
      label: "Schedule (cron)",
      summary: `Cron ${trigger.expression} in ${trigger.timezone}`,
    };
  if (trigger.kind === "interval")
    return {
      type: "schedule",
      label: "Schedule (interval)",
      summary: `Every ${trigger.every_seconds} seconds in ${trigger.timezone}`,
    };
  return {
    type: "schedule",
    label: "Schedule (one time)",
    summary: `Once at ${trigger.at} in ${trigger.timezone}`,
  };
}
