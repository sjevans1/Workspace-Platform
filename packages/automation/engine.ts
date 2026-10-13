/**
 * W30-A: the deterministic workflow engine.
 *
 * A workflow executes against an IMMUTABLE revision, pinned to the run at insert
 * time. Execution is a leased claim followed by a walk of the compiled plan; a
 * step that durably succeeded is never re-executed, and every attempt count is
 * persisted so a worker restart cannot quietly reset a retry. The engine never
 * runs arbitrary code, never calls a model and never reaches the network except
 * through the connector port. Every entry point is bounded per tenant and per
 * tick.
 *
 * Authority is resolved at run START, fail closed. If the delegated user's
 * membership is gone or inactive, no step runs and no external action occurs; the
 * run simply records `authorization_revoked`.
 */
import { randomUUID } from "node:crypto";
import { HttpError, assert, json } from "../contracts/index.ts";
import type { Database, Query } from "../database/index.ts";
import { one } from "../database/index.ts";
import type { Actor } from "../auth/index.ts";
import {
  RETRY_POLICY,
  backoffSeconds,
  classifyStepFailure,
  isTenantAdministrator,
  markEventDispatched,
  pendingConnectorEvents,
} from "../connectors/index.ts";
import {
  WORKFLOW_LIMITS,
  definitionDigest,
  describeTrigger,
  parseWorkflowDefinition,
  planDigest,
  planSteps,
  scheduledTriggers,
  type PlannedStep,
  type WorkflowDefinition,
} from "./dsl.ts";
import { boundedContext, evaluateCondition } from "./conditions.ts";
import { nextOccurrence } from "./schedule.ts";
import { WORKSPACE_EVENT_TYPES, triggerMatches } from "./triggers.ts";
import { actionFor, type ConnectorActionPort } from "./actions.ts";

export type RunAuthority =
  | { kind: "delegated_user"; user_id: string; capabilities: string[] }
  | { kind: "service_principal"; user_id: string; capabilities: string[] };

export type WorkflowRow = any;
export type RunRow = any;

export type EngineDeps = {
  connectorPort: ConnectorActionPort;
  now?: () => Date;
};

type TickOutcome = "succeeded" | "failed" | "waiting" | "retry";

const LEASE_SECONDS = 120;
const AUDIT_WORKFLOW_ACTIONS = new Set([
  "workflow.created",
  "workflow.edited",
  "workflow.enabled",
  "workflow.disabled",
  "workflow.deleted",
  "workflow.run_triggered",
  "workflow.run_cancelled",
  "workflow.run_retried",
  "workflow.service_principal_provisioned",
  "workflow.service_principal_deprovisioned",
]);

function clock(deps: EngineDeps): Date {
  return deps.now ? deps.now() : new Date();
}

async function audit(
  q: Query,
  tenant: string,
  actorId: string | null,
  action: string,
  resourceId: string | null,
): Promise<void> {
  assert(
    AUDIT_WORKFLOW_ACTIONS.has(action),
    500,
    `Unregistered workflow audit action: ${action}`,
  );
  await q.query(
    "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), tenant, actorId, action, resourceId],
  );
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

async function loadWorkflow(q: Query, actor: Actor, id: string): Promise<any> {
  assert(UUID_RE.test(id), 400, "Invalid workflow id");
  const row = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  assert(row, 404, "Workflow not found");
  return row;
}

function assertManage(actor: Actor, workflow: any): void {
  assert(workflow.tenant_id === actor.tenant_id, 404, "Workflow not found");
  assert(
    workflow.owner_user_id === actor.user_id || isTenantAdministrator(actor),
    403,
    "Only the workflow owner or an administrator can change this workflow",
  );
}

async function assertManagesWorkflow(
  q: Query,
  actor: Actor,
  workflowId: string,
): Promise<any> {
  const row = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, workflowId],
  );
  assert(row, 404, "Workflow not found");
  assertManage(actor, row);
  return row;
}

async function revisionDefinition(
  q: Query,
  tenant: string,
  workflowId: string,
  revision: number,
): Promise<WorkflowDefinition | null> {
  const row = await one(
    q,
    "SELECT definition FROM workflow_revisions WHERE tenant_id=$1 AND workflow_id=$2 AND revision=$3",
    [tenant, workflowId, revision],
  );
  return row ? (row.definition as WorkflowDefinition) : null;
}

export function runSummary(run: any): any {
  const started = run.started_at ? new Date(run.started_at).getTime() : null;
  const completed = run.completed_at
    ? new Date(run.completed_at).getTime()
    : null;
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    workflow_name: run.workflow_name ?? null,
    revision: run.revision,
    trigger_type: run.trigger_type,
    status: run.status,
    error_category: run.error_category ?? null,
    step_count: Number(run.step_count) || 0,
    current_step: Number(run.current_step) || 0,
    attempts: Number(run.attempts) || 0,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    duration_ms:
      started !== null && completed !== null ? completed - started : null,
    created_at: run.created_at,
  };
}

export function stepRecord(step: any): any {
  return {
    seq: step.seq,
    step_type: step.step_type,
    operation: step.operation,
    status: step.status,
    attempt: step.attempt,
    started_at: step.started_at ?? null,
    completed_at: step.completed_at ?? null,
    error_category: step.error_category ?? null,
    result: step.result ?? {},
    retry_state: step.retry_state ?? {},
  };
}

function workflowSummary(
  row: any,
  definition: WorkflowDefinition,
  lastRun: any | null,
): any {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    authority: row.authority,
    revision: row.published_revision ?? row.current_draft_revision,
    published_revision: row.published_revision,
    trigger: describeTrigger(definition),
    enabled: row.status === "enabled",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_run: lastRun,
  };
}

async function lastRunFor(
  q: Query,
  tenant: string,
  workflowId: string,
): Promise<any | null> {
  const row = await one(
    q,
    "SELECT id,status,started_at,completed_at,error_category FROM workflow_runs" +
      " WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
    [tenant, workflowId],
  );
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_category: row.error_category ?? null,
  };
}

export async function createWorkflow(
  q: Query,
  actor: Actor,
  input: {
    name: string;
    description?: string;
    definition: unknown;
    authority?: unknown;
  },
): Promise<any> {
  const name = String(input.name || "").trim();
  assert(
    name.length >= 1 && name.length <= 200,
    400,
    "Workflow name must contain 1-200 characters",
  );
  const description = String(input.description || "").trim();
  assert(description.length <= 2000, 400, "Workflow description is too long");
  const definition = parseWorkflowDefinition(input.definition);

  const total = Number(
    (
      await one(
        q,
        "SELECT count(*)::int AS c FROM workflow_definitions WHERE tenant_id=$1",
        [actor.tenant_id],
      )
    )?.c || 0,
  );
  assert(
    total < WORKFLOW_LIMITS.max_workflows_per_tenant,
    409,
    "Workflow limit reached for this workspace",
  );

  const stored = await resolveStoredAuthority(q, actor, input.authority);
  const id = randomUUID();
  await q.query(
    "INSERT INTO workflow_definitions(id,tenant_id,name,description,status,owner_user_id,authority," +
      " current_draft_revision,created_by) VALUES($1,$2,$3,$4,'draft',$5,$6,1,$5)",
    [id, actor.tenant_id, name, description, actor.user_id, stored.authority],
  );
  // Revision 1 is created here and never mutated again; editing produces revision 2 onward.
  await q.query(
    "INSERT INTO workflow_revisions(tenant_id,workflow_id,revision,schema_version,definition,digest,authority," +
      " authority_user_id,created_by) VALUES($1,$2,1,1,$3,$4,$5,$6,$7)",
    [
      actor.tenant_id,
      id,
      json(definition),
      definitionDigest(definition),
      stored.authority,
      stored.authority_user_id,
      actor.user_id,
    ],
  );
  await audit(q, actor.tenant_id, actor.user_id, "workflow.created", id);

  const row = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  return {
    workflow: workflowSummary(row, definition, null),
    definition,
    plan: planSteps(definition),
  };
}

export async function listWorkflows(q: Query, actor: Actor): Promise<any[]> {
  const rows = (
    await q.query(
      "SELECT * FROM workflow_definitions WHERE tenant_id=$1 ORDER BY created_at DESC,id",
      [actor.tenant_id],
    )
  ).rows;
  const output: any[] = [];
  for (const row of rows) {
    const revision = row.published_revision ?? row.current_draft_revision;
    const definition = await revisionDefinition(
      q,
      actor.tenant_id,
      row.id,
      revision,
    );
    if (!definition) continue;
    output.push(
      workflowSummary(
        row,
        definition,
        await lastRunFor(q, actor.tenant_id, row.id),
      ),
    );
  }
  return output;
}

export async function getWorkflowDetail(
  q: Query,
  actor: Actor,
  id: string,
): Promise<{
  workflow: any;
  draft_definition: WorkflowDefinition;
  published: { revision: number; definition: WorkflowDefinition } | null;
  plan: PlannedStep[];
}> {
  const row = await loadWorkflow(q, actor, id);
  const draftDefinition = await revisionDefinition(
    q,
    actor.tenant_id,
    id,
    row.current_draft_revision,
  );
  assert(draftDefinition, 500, "Workflow draft revision is missing");
  let published: { revision: number; definition: WorkflowDefinition } | null =
    null;
  if (row.published_revision) {
    const publishedDefinition = await revisionDefinition(
      q,
      actor.tenant_id,
      id,
      row.published_revision,
    );
    if (publishedDefinition)
      published = {
        revision: row.published_revision,
        definition: publishedDefinition,
      };
  }
  return {
    workflow: workflowSummary(
      row,
      draftDefinition!,
      await lastRunFor(q, actor.tenant_id, id),
    ),
    draft_definition: draftDefinition!,
    published,
    plan: planSteps(draftDefinition!),
  };
}

export async function saveDraft(
  q: Query,
  actor: Actor,
  id: string,
  input: { definition: unknown },
): Promise<{
  workflow: any;
  draft_definition: WorkflowDefinition;
  plan: PlannedStep[];
}> {
  const row = await loadWorkflow(q, actor, id);
  assertManage(actor, row);
  const definition = parseWorkflowDefinition(input.definition);
  const nextRevision = Number(row.current_draft_revision) + 1;
  // A NEW revision row every edit: an active run keeps executing the revision it was pinned to.
  const authorityUserId =
    row.authority === "service_principal"
      ? ((
          await one(
            q,
            "SELECT user_id FROM tenant_automation_principals WHERE tenant_id=$1",
            [actor.tenant_id],
          )
        )?.user_id ?? null)
      : null;
  assert(
    row.authority !== "service_principal" || authorityUserId,
    409,
    "The tenant automation identity is no longer provisioned",
  );
  await q.query(
    "INSERT INTO workflow_revisions(tenant_id,workflow_id,revision,schema_version,definition,digest,authority," +
      " authority_user_id,created_by) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)",
    [
      actor.tenant_id,
      id,
      nextRevision,
      json(definition),
      definitionDigest(definition),
      row.authority,
      authorityUserId,
      actor.user_id,
    ],
  );
  await q.query(
    "UPDATE workflow_definitions SET current_draft_revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id, nextRevision],
  );
  await audit(q, actor.tenant_id, actor.user_id, "workflow.edited", id);
  const updated = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  return {
    workflow: workflowSummary(
      updated,
      definition,
      await lastRunFor(q, actor.tenant_id, id),
    ),
    draft_definition: definition,
    plan: planSteps(definition),
  };
}

export async function validateDraft(
  q: Query,
  actor: Actor,
  id: string,
  input: { definition: unknown },
): Promise<{ plan: PlannedStep[] }> {
  await loadWorkflow(q, actor, id);
  const definition = parseWorkflowDefinition(input.definition);
  return { plan: planSteps(definition) };
}

/**
 * Publishes the current draft: it becomes the pinned revision for future runs and
 * the schedule state is recomputed. It does NOT touch an existing revision (the
 * revisions table is append-only at the trigger layer); the revision already
 * carries the authority it was created with.
 */
export async function enableWorkflow(
  q: Query,
  actor: Actor,
  id: string,
): Promise<any> {
  const row = await loadWorkflow(q, actor, id);
  assertManage(actor, row);
  const definition = await revisionDefinition(
    q,
    actor.tenant_id,
    id,
    row.current_draft_revision,
  );
  assert(definition, 500, "Workflow draft revision is missing");

  await q.query(
    "UPDATE workflow_definitions SET published_revision=$3,status='enabled',enabled_at=now(),disabled_at=NULL,updated_at=now()" +
      " WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id, row.current_draft_revision],
  );
  await syncScheduleState(
    q,
    actor.tenant_id,
    id,
    row.current_draft_revision,
    definition!,
  );
  await audit(q, actor.tenant_id, actor.user_id, "workflow.enabled", id);
  const updated = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  return workflowSummary(
    updated,
    definition!,
    await lastRunFor(q, actor.tenant_id, id),
  );
}

/**
 * Upserts the schedule state for a published revision. The next instant is
 * computed in the trigger's timezone from the database clock; when a schedule has
 * no future occurrence (a spent one-time trigger) the row is parked at infinity
 * so it never becomes due again.
 */
async function syncScheduleState(
  q: Query,
  tenant: string,
  workflowId: string,
  revision: number,
  definition: WorkflowDefinition,
): Promise<void> {
  const scheduled = scheduledTriggers(definition);
  const trigger = definition.trigger;
  const dbNow = (await one(q, "SELECT now() AS now"))?.now as Date;
  const keep: string[] = [];
  if (scheduled.length && trigger.type === "schedule") {
    // An interval trigger carries no `at` (the DSL forbids one) and has no previous
    // firing to measure from, so its base is the instant the schedule is published.
    const next = nextOccurrence({
      kind: trigger.kind,
      at: trigger.at,
      every_seconds: trigger.every_seconds,
      expression: trigger.expression,
      timezone: trigger.timezone,
      missed_policy: trigger.missed_policy,
      after: dbNow,
      from: trigger.kind === "interval" ? dbNow : null,
    });
    const spec = scheduled[0];
    await q.query(
      "INSERT INTO workflow_schedule_state(tenant_id,workflow_id,revision,trigger_id,timezone,kind,expression,next_at," +
        " last_at,missed_policy,attempts) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,'infinity'::timestamptz),NULL,$9,0)" +
        " ON CONFLICT(tenant_id,workflow_id,trigger_id) DO UPDATE SET revision=EXCLUDED.revision,timezone=EXCLUDED.timezone," +
        " kind=EXCLUDED.kind,expression=EXCLUDED.expression,next_at=EXCLUDED.next_at,last_at=NULL," +
        " missed_policy=EXCLUDED.missed_policy,attempts=0,lease_token=NULL,lease_expires_at=NULL,updated_at=now()",
      [
        tenant,
        workflowId,
        revision,
        spec.trigger_id,
        spec.timezone,
        spec.kind,
        spec.expression,
        next ? next.toISOString() : null,
        spec.missed_policy,
      ],
    );
    keep.push(spec.trigger_id);
  }
  if (keep.length) {
    await q.query(
      "DELETE FROM workflow_schedule_state WHERE tenant_id=$1 AND workflow_id=$2 AND NOT (trigger_id = ANY($3))",
      [tenant, workflowId, keep],
    );
  } else {
    await q.query(
      "DELETE FROM workflow_schedule_state WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflowId],
    );
  }
}

/**
 * Disabling is the documented deterministic policy: runs that never started
 * (queued) are cancelled, while runs already running or waiting continue against
 * the revision they were pinned to.
 */
export async function disableWorkflow(
  q: Query,
  actor: Actor,
  id: string,
): Promise<{ workflow: any; cancelled_queued_runs: number }> {
  const row = await loadWorkflow(q, actor, id);
  assertManage(actor, row);
  await q.query(
    "UPDATE workflow_definitions SET status='disabled',disabled_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  const cancelled = await q.query(
    "UPDATE workflow_runs SET status='cancelled',cancelled_at=now(),completed_at=now(),lease_token=NULL," +
      " lease_expires_at=NULL,next_attempt_at=now() WHERE tenant_id=$1 AND workflow_id=$2 AND status='queued'",
    [actor.tenant_id, id],
  );
  await q.query(
    "UPDATE workflow_run_steps SET status='cancelled',completed_at=now() WHERE tenant_id=$1 AND status IN ('pending','running','waiting')" +
      " AND run_id IN (SELECT id FROM workflow_runs WHERE tenant_id=$1 AND workflow_id=$2 AND status='cancelled')",
    [actor.tenant_id, id],
  );
  await audit(q, actor.tenant_id, actor.user_id, "workflow.disabled", id);
  const definition = await revisionDefinition(
    q,
    actor.tenant_id,
    id,
    row.current_draft_revision,
  );
  const updated = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  return {
    workflow:
      updated && definition
        ? workflowSummary(
            updated,
            definition,
            await lastRunFor(q, actor.tenant_id, id),
          )
        : updated,
    cancelled_queued_runs: cancelled.rowCount || 0,
  };
}

export async function deleteWorkflow(
  q: Query,
  actor: Actor,
  id: string,
): Promise<void> {
  const row = await loadWorkflow(q, actor, id);
  assertManage(actor, row);
  await q.query(
    "DELETE FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  await audit(q, actor.tenant_id, actor.user_id, "workflow.deleted", id);
}

async function insertRun(
  q: Query,
  params: {
    tenant: string;
    workflowId: string;
    revision: number;
    triggerType: string;
    triggerRef: Record<string, unknown>;
    idempotencyKey: string;
    plan: PlannedStep[];
  },
): Promise<{ run: any; inserted: boolean }> {
  // 'skip' policy: an explicit deterministic choice not to stack a second logical
  // execution on top of one that is already queued, running or waiting. The caller
  // receives the existing run, so a trigger is never silently dropped.
  const policy = await one(
    q,
    "SELECT concurrency_policy FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [params.tenant, params.workflowId],
  );
  if (policy?.concurrency_policy === "skip") {
    const active = await one(
      q,
      "SELECT * FROM workflow_runs WHERE tenant_id=$1 AND workflow_id=$2" +
        " AND status IN ('queued','running','waiting') ORDER BY created_at,id LIMIT 1",
      [params.tenant, params.workflowId],
    );
    if (active) return { run: active, inserted: false };
  }
  const triggerRef = json(params.triggerRef);
  assert(
    Buffer.byteLength(triggerRef) <= WORKFLOW_LIMITS.max_trigger_ref_bytes,
    400,
    "Trigger context is too large",
  );
  assert(
    params.idempotencyKey.length >= 1 && params.idempotencyKey.length <= 200,
    400,
    "Idempotency key is out of range",
  );
  const inserted = await one(
    q,
    "INSERT INTO workflow_runs(id,tenant_id,workflow_id,revision,trigger_type,trigger_ref,authority,status," +
      " idempotency_key,plan_digest,step_count,current_step,next_attempt_at)" +
      " VALUES($1,$2,$3,$4,$5,$6,'{}','queued',$7,$8,$9,0,now())" +
      " ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING *",
    [
      randomUUID(),
      params.tenant,
      params.workflowId,
      params.revision,
      params.triggerType,
      triggerRef,
      params.idempotencyKey,
      planDigest(params.plan),
      params.plan.length,
    ],
  );
  if (inserted) return { run: inserted, inserted: true };
  // A duplicate delivery must return the ORIGINAL run rather than an error.
  const existing = await one(
    q,
    "SELECT * FROM workflow_runs WHERE tenant_id=$1 AND idempotency_key=$2",
    [params.tenant, params.idempotencyKey],
  );
  return { run: existing, inserted: false };
}

/** Any live member may trigger a run; it executes under the workflow's pinned authority, not the caller's. */
export async function triggerManualRun(
  q: Query,
  actor: Actor,
  id: string,
  input: { idempotency_key?: string },
): Promise<any> {
  const row = await loadWorkflow(q, actor, id);
  assert(row.published_revision, 409, "Enable the workflow before running it");
  // A disabled workflow must not create NEW runs. Runs already queued, running or
  // waiting keep executing against their pinned revision, because cancelling an
  // arbitrary mid-step execution would leave the run evidence ambiguous and could
  // not undo an external action that had already been committed.
  assert(
    row.status === "enabled",
    409,
    "Enable the workflow before running it",
  );
  const definition = await revisionDefinition(
    q,
    actor.tenant_id,
    id,
    row.published_revision,
  );
  assert(definition, 500, "Published revision is missing");
  const supplied = input.idempotency_key ? String(input.idempotency_key) : null;
  if (supplied)
    assert(
      supplied.length >= 1 && supplied.length <= 200,
      400,
      "Idempotency key must contain 1-200 characters",
    );
  const key = supplied || `manual:${randomUUID()}`;
  const inserted = await insertRun(q, {
    tenant: actor.tenant_id,
    workflowId: id,
    revision: row.published_revision,
    triggerType: "manual",
    triggerRef: { trigger_id: definition!.trigger.id, manual: true },
    idempotencyKey: key,
    plan: planSteps(definition!),
  });
  if (inserted.inserted)
    await audit(
      q,
      actor.tenant_id,
      actor.user_id,
      "workflow.run_triggered",
      id,
    );
  return runSummary(inserted.run);
}

export async function listRuns(
  q: Query,
  actor: Actor,
  input: { workflow_id?: string; limit?: number },
): Promise<any[]> {
  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 200));
  const params: any[] = [actor.tenant_id];
  let where = "r.tenant_id=$1";
  if (input.workflow_id) {
    assert(UUID_RE.test(input.workflow_id), 400, "Invalid workflow id");
    params.push(input.workflow_id);
    where += ` AND r.workflow_id=$${params.length}`;
  }
  params.push(limit);
  const rows = (
    await q.query(
      `SELECT r.*,d.name AS workflow_name FROM workflow_runs r` +
        ` JOIN workflow_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.workflow_id` +
        ` WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT $${params.length}`,
      params,
    )
  ).rows;
  return rows.map(runSummary);
}

async function loadRun(q: Query, actor: Actor, id: string): Promise<any> {
  assert(UUID_RE.test(id), 400, "Invalid run id");
  const row = await one(
    q,
    "SELECT r.*,d.name AS workflow_name FROM workflow_runs r" +
      " JOIN workflow_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.workflow_id" +
      " WHERE r.tenant_id=$1 AND r.id=$2",
    [actor.tenant_id, id],
  );
  assert(row, 404, "Run not found");
  return row;
}

export async function getRunDetail(
  q: Query,
  actor: Actor,
  id: string,
): Promise<{ run: any; steps: any[] }> {
  const run = await loadRun(q, actor, id);
  const steps = (
    await q.query(
      "SELECT * FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2 ORDER BY seq,attempt",
      [actor.tenant_id, id],
    )
  ).rows;
  return { run: runSummary(run), steps: steps.map(stepRecord) };
}

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter",
];

export async function cancelRun(
  q: Query,
  actor: Actor,
  id: string,
): Promise<any> {
  const run = await loadRun(q, actor, id);
  await assertManagesWorkflow(q, actor, run.workflow_id);
  assert(
    !TERMINAL_RUN_STATUSES.includes(run.status),
    409,
    "Run has already finished",
  );
  await q.query(
    "UPDATE workflow_runs SET status='cancelled',cancelled_at=now(),completed_at=now(),lease_token=NULL," +
      " lease_expires_at=NULL,next_attempt_at=now() WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  await q.query(
    "UPDATE workflow_run_steps SET status='cancelled',completed_at=now() WHERE tenant_id=$1 AND run_id=$2" +
      " AND status IN ('pending','running','waiting')",
    [actor.tenant_id, id],
  );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "workflow.run_cancelled",
    run.workflow_id,
  );
  return runSummary(await loadRun(q, actor, id));
}

/** Re-queues a finished run. Succeeded steps stay durably done; the attempt counts are never reset. */
export async function retryRun(
  q: Query,
  actor: Actor,
  id: string,
): Promise<any> {
  const run = await loadRun(q, actor, id);
  await assertManagesWorkflow(q, actor, run.workflow_id);
  assert(
    ["failed", "dead_letter", "cancelled"].includes(run.status),
    409,
    "Only a finished run can be retried",
  );
  await q.query(
    "UPDATE workflow_runs SET status='queued',next_attempt_at=now(),completed_at=NULL,cancelled_at=NULL," +
      " error_category=NULL,lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
    [actor.tenant_id, id],
  );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "workflow.run_retried",
    run.workflow_id,
  );
  return runSummary(await loadRun(q, actor, id));
}

async function enabledWorkflows(q: Query, tenant: string): Promise<any[]> {
  return (
    await q.query(
      "SELECT id,published_revision FROM workflow_definitions WHERE tenant_id=$1 AND status='enabled'" +
        " AND published_revision IS NOT NULL ORDER BY created_at,id",
      [tenant],
    )
  ).rows;
}

export async function dispatchConnectorEvent(
  q: Query,
  tenant: string,
  deps: EngineDeps,
): Promise<{ runs: string[] }> {
  void deps;
  const events = await pendingConnectorEvents(q, tenant);
  if (!events.length) return { runs: [] };
  const workflows = await enabledWorkflows(q, tenant);
  const runs: string[] = [];
  for (const event of events) {
    for (const workflow of workflows) {
      const definition = await revisionDefinition(
        q,
        tenant,
        workflow.id,
        workflow.published_revision,
      );
      if (!definition) continue;
      const matched = triggerMatches(definition.trigger, {
        type: "connector_event",
        event_type: event.event_type,
        provider_key: event.provider_key,
        connection_id: event.connection_id,
      });
      if (!matched) continue;
      const { run } = await insertRun(q, {
        tenant,
        workflowId: workflow.id,
        revision: workflow.published_revision,
        triggerType: "connector_event",
        triggerRef: {
          trigger_id: definition.trigger.id,
          connector_event_id: event.id,
          event_type: event.event_type,
          provider_key: event.provider_key,
          connection_id: event.connection_id,
          // The verified event's normalized, non-secret payload fields, projected
          // and bounded so a condition can filter on provider content without the
          // run record or the trigger context growing with provider input.
          payload: boundedEventPayload(event.payload_ref),
        },
        idempotencyKey: `connector_event:${event.id}:${definition.trigger.id}`,
        plan: planSteps(definition),
      });
      if (run) runs.push(run.id);
    }
    await markEventDispatched(q, tenant, event.id);
  }
  return { runs };
}

/**
 * Matches pending workspace events against workspace_event triggers. The outbox
 * row is NOT marked here: the existing worker owns outbox dispatch, and the unique
 * idempotency key (`workspace_event:<outbox id>:<trigger id>`) is what makes a
 * re-scan or a duplicate delivery produce at most one run.
 */
export async function dispatchWorkspaceEvent(
  q: Query,
  tenant: string,
  deps: EngineDeps,
): Promise<{ runs: string[] }> {
  void deps;
  const events = (
    await q.query(
      "SELECT id,type,resource_id FROM event_outbox WHERE tenant_id=$1 AND type = ANY($2) AND dispatched_at IS NULL" +
        " ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED",
      [tenant, WORKSPACE_EVENT_TYPES],
    )
  ).rows;
  if (!events.length) return { runs: [] };
  const workflows = await enabledWorkflows(q, tenant);
  const runs: string[] = [];
  for (const event of events) {
    for (const workflow of workflows) {
      const definition = await revisionDefinition(
        q,
        tenant,
        workflow.id,
        workflow.published_revision,
      );
      if (!definition || definition.trigger.type !== "workspace_event")
        continue;
      if (
        !triggerMatches(definition.trigger, {
          type: "workspace_event",
          event_type: event.type,
        })
      )
        continue;
      const { run } = await insertRun(q, {
        tenant,
        workflowId: workflow.id,
        revision: workflow.published_revision,
        triggerType: "workspace_event",
        triggerRef: {
          trigger_id: definition.trigger.id,
          workspace_event_id: event.id,
          event_type: event.type,
        },
        idempotencyKey: `workspace_event:${event.id}:${definition.trigger.id}`,
        plan: planSteps(definition),
      });
      if (run) runs.push(run.id);
    }
  }
  return { runs };
}

/** Fires due schedules, at most `max_schedule_fire_per_tick` per call, then advances each one. */
export async function scheduleTick(
  q: Query,
  tenant: string,
  deps: EngineDeps,
): Promise<{ fired: number }> {
  const after = clock(deps);
  const due = (
    await q.query(
      "SELECT s.*,d.published_revision FROM workflow_schedule_state s" +
        " JOIN workflow_definitions d ON d.tenant_id=s.tenant_id AND d.id=s.workflow_id" +
        " AND d.status='enabled' AND d.published_revision IS NOT NULL" +
        " WHERE s.tenant_id=$1 AND s.next_at<=now() AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=now())" +
        " ORDER BY s.next_at,s.workflow_id,s.trigger_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED",
      [tenant, WORKFLOW_LIMITS.max_schedule_fire_per_tick],
    )
  ).rows;
  let fired = 0;
  for (const row of due) {
    const definition = await revisionDefinition(
      q,
      tenant,
      row.workflow_id,
      row.published_revision,
    );
    const trigger =
      definition && definition.trigger.type === "schedule"
        ? definition.trigger
        : null;
    if (!trigger || trigger.id !== row.trigger_id) {
      // The published trigger no longer matches this state row: park it so it stops firing.
      await q.query(
        "UPDATE workflow_schedule_state SET next_at='infinity'::timestamptz,lease_token=NULL,lease_expires_at=NULL,updated_at=now()" +
          " WHERE tenant_id=$1 AND workflow_id=$2 AND trigger_id=$3",
        [tenant, row.workflow_id, row.trigger_id],
      );
      continue;
    }
    const firedAt = new Date(row.next_at);
    const idempotencyKey = `schedule:${row.workflow_id}:${row.trigger_id}:${firedAt.toISOString()}`;
    const { inserted } = await insertRun(q, {
      tenant,
      workflowId: row.workflow_id,
      revision: row.published_revision,
      triggerType: "schedule",
      triggerRef: {
        trigger_id: row.trigger_id,
        scheduled_at: firedAt.toISOString(),
      },
      idempotencyKey,
      plan: planSteps(definition!),
    });
    if (inserted) fired += 1;
    const next = nextOccurrence({
      kind: trigger.kind,
      at: trigger.at,
      every_seconds: trigger.every_seconds,
      expression: trigger.expression,
      timezone: trigger.timezone,
      missed_policy: trigger.missed_policy,
      after,
      from: firedAt,
    });
    await q.query(
      "UPDATE workflow_schedule_state SET next_at=COALESCE($4::timestamptz,'infinity'::timestamptz),last_at=$5,revision=$6," +
        " attempts=attempts+1,lease_token=NULL,lease_expires_at=NULL,updated_at=now()" +
        " WHERE tenant_id=$1 AND workflow_id=$2 AND trigger_id=$3",
      [
        tenant,
        row.workflow_id,
        row.trigger_id,
        next ? next.toISOString() : null,
        firedAt,
        row.published_revision,
      ],
    );
  }
  return { fired };
}

/**
 * Claims up to `max_runs_per_tick` runs under a fresh lease and executes them. The
 * lease is what makes a crashed worker's run reclaimable: `attempts` is bumped
 * only here, and the previous attempt's step evidence is what stops a re-run from
 * repeating a durably completed action.
 */
export async function engineTick(
  q: Query,
  tenant: string,
  deps: EngineDeps,
): Promise<{
  claimed: number;
  succeeded: number;
  failed: number;
  waiting: number;
}> {
  const candidates = (
    await q.query(
      "SELECT r.* FROM workflow_runs r WHERE r.tenant_id=$1" +
        " AND r.status IN ('queued','running','waiting')" +
        " AND r.next_attempt_at<=now()" +
        " AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=now())" +
        // Tenant fairness: a tenant may hold at most
        // WORKFLOW_LIMITS.max_concurrent_runs_per_tenant runs in flight, so one
        // tenant cannot monopolize the worker.
        " AND (SELECT count(*) FROM workflow_runs live WHERE live.tenant_id=$1" +
        " AND live.status='running') < $3" +
        // Concurrency policy: a workflow whose policy serializes its runs
        // ('queue' and 'skip') is not claimed while another run of that same
        // workflow is already running. 'parallel' opts out of that gate.
        " AND (NOT EXISTS (SELECT 1 FROM workflow_definitions d" +
        " WHERE d.tenant_id=$1 AND d.id=r.workflow_id AND d.concurrency_policy<>'parallel')" +
        " OR NOT EXISTS (SELECT 1 FROM workflow_runs other WHERE other.tenant_id=$1" +
        " AND other.workflow_id=r.workflow_id AND other.status='running' AND other.id<>r.id))" +
        " ORDER BY r.next_attempt_at,r.id LIMIT $2 FOR UPDATE SKIP LOCKED",
      [
        tenant,
        WORKFLOW_LIMITS.max_runs_per_tick,
        WORKFLOW_LIMITS.max_concurrent_runs_per_tenant,
      ],
    )
  ).rows;
  let succeeded = 0;
  let failed = 0;
  let waiting = 0;
  for (const candidate of candidates) {
    const leaseToken = randomUUID();
    const run = await one(
      q,
      "UPDATE workflow_runs SET status='running',lease_token=$3,lease_expires_at=now()+($4 || ' seconds')::interval," +
        " attempts=attempts+1,started_at=COALESCE(started_at,now()) WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [tenant, candidate.id, leaseToken, String(LEASE_SECONDS)],
    );
    const outcome = await executeRun(q, tenant, run, deps);
    if (outcome === "succeeded") succeeded += 1;
    else if (outcome === "waiting") waiting += 1;
    else if (outcome === "failed") failed += 1;
  }
  return { claimed: candidates.length, succeeded, failed, waiting };
}

/**
 * Projects a verified connector event's payload into a small, bounded, non-secret
 * map for condition evaluation. Provider input is untrusted even after it is
 * verified: only primitive values survive, keys are capped at 16, and every string
 * is truncated. Anything larger is dropped rather than truncated into the run's
 * trigger context.
 */
function boundedEventPayload(
  value: unknown,
): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(
    value as Record<string, unknown>,
  ).slice(0, 16)) {
    if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(key)) continue;
    if (typeof raw === "string") output[key] = raw.slice(0, 120);
    else if (typeof raw === "number" && Number.isFinite(raw)) output[key] = raw;
    else if (typeof raw === "boolean") output[key] = raw;
  }
  return output;
}

/**
 * Bounded step ceiling. A step that does not settle within
 * WORKFLOW_LIMITS.step_timeout_seconds fails as a retryable timeout instead of
 * holding the run's lease and the tenant transaction indefinitely.
 */
async function withStepTimeout<T>(
  work: Promise<T>,
  seconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HttpError(504, "Workflow step exceeded its time ceiling"),
            ),
          Math.max(1, seconds) * 1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function failRun(
  q: Query,
  tenant: string,
  run: any,
  category: string,
  _reason: string,
): Promise<"failed"> {
  await q.query(
    "UPDATE workflow_runs SET status='failed',error_category=$3,completed_at=now(),lease_token=NULL," +
      " lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
    [tenant, run.id, category],
  );
  return "failed";
}

async function lastStep(
  q: Query,
  tenant: string,
  runId: string,
  seq: number,
): Promise<any> {
  return one(
    q,
    "SELECT * FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2 AND seq=$3 ORDER BY attempt DESC LIMIT 1",
    [tenant, runId, seq],
  );
}

async function recordStep(
  q: Query,
  tenant: string,
  runId: string,
  step: PlannedStep,
  status: string,
  attempt: number,
  result: Record<string, unknown>,
  errorCategory: string | null,
  retryState: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await q.query(
    "INSERT INTO workflow_run_steps(id,tenant_id,run_id,seq,step_type,operation,status,attempt,started_at," +
      " completed_at,result,error_category,retry_state)" +
      " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)" +
      " ON CONFLICT(tenant_id,run_id,seq,attempt) DO UPDATE SET status=EXCLUDED.status," +
      " completed_at=EXCLUDED.completed_at,result=EXCLUDED.result,error_category=EXCLUDED.error_category," +
      " retry_state=EXCLUDED.retry_state,started_at=COALESCE(workflow_run_steps.started_at,EXCLUDED.started_at)",
    [
      randomUUID(),
      tenant,
      runId,
      step.seq,
      step.step_type,
      step.operation,
      status,
      attempt,
      status === "running" ? now : null,
      status === "running" ? null : now,
      json(result || {}),
      errorCategory,
      json(retryState || {}),
    ],
  );
}

const SECRET_PATTERN =
  /secret_encrypted|refresh_token|access_token|bot_token|authorization:/i;

/** Run history must never carry credential material: reject a result that smells of it. */
function assertNonSecret(value: unknown): void {
  const serialized = json(value ?? {});
  if (SECRET_PATTERN.test(serialized))
    throw new HttpError(
      400,
      "Step result rejected: it contains credential material",
    );
  assert(
    Buffer.byteLength(serialized) <= 8192,
    400,
    "Step result is too large",
  );
}

function classifyActionFailure(error: unknown): {
  category: string;
  retryable: boolean;
} {
  const details = (error as { details?: { fatal?: boolean } })?.details;
  const statusCode = (error as { statusCode?: number })?.statusCode;
  const message = String((error as Error)?.message || "");
  if (
    statusCode === 403 &&
    details?.fatal === true &&
    message.startsWith("Connector access denied")
  )
    return { category: "capability_missing", retryable: false };
  const classified = classifyStepFailure(error);
  return { category: classified.category, retryable: classified.retryable };
}

/** The capabilities an owner/admin may grant to the tenant automation identity. */
export const AUTOMATION_SERVICE_CAPABILITIES = [
  "notification.create",
  "record.create",
  "record.update",
  "webhook.emit",
  "connector.action",
  "workflow.delay",
];

/**
 * Resolves the authority a workflow will store. A service-principal workflow needs
 * an owner/admin and an already provisioned tenant automation identity, so a
 * workflow author can never nominate an arbitrary user (least of all an owner) as
 * its own execution authority.
 */
async function resolveStoredAuthority(
  q: Query,
  actor: Actor,
  requested: unknown,
): Promise<{ authority: string; authority_user_id: string | null }> {
  if (
    requested === undefined ||
    requested === null ||
    requested === "delegated_user"
  )
    return { authority: "delegated_user", authority_user_id: null };
  assert(
    requested === "service_principal",
    400,
    "Workflow authority must be delegated_user or service_principal",
  );
  assert(
    isTenantAdministrator(actor),
    403,
    "Administrator access required for a service principal workflow",
  );
  const principal = await one(
    q,
    "SELECT user_id FROM tenant_automation_principals WHERE tenant_id=$1",
    [actor.tenant_id],
  );
  assert(
    principal,
    409,
    "Provision the tenant automation identity before creating a service principal workflow",
  );
  return {
    authority: "service_principal",
    authority_user_id: principal.user_id,
  };
}

/** Reads the tenant automation identity, or reports that none is provisioned. */
export async function getServicePrincipal(
  q: Query,
  actor: Actor,
): Promise<any> {
  const row = await one(
    q,
    "SELECT p.user_id,p.capabilities,p.created_at,u.name,u.email" +
      " FROM tenant_automation_principals p JOIN users u ON u.id=p.user_id" +
      " WHERE p.tenant_id=$1",
    [actor.tenant_id],
  );
  return {
    configured: !!row,
    user_id: row?.user_id || null,
    name: row?.name || null,
    email: row?.email || null,
    capabilities: row ? [...row.capabilities].sort() : [],
    created_at: row?.created_at || null,
    available_capabilities: AUTOMATION_SERVICE_CAPABILITIES,
  };
}

/**
 * Provisions the tenant automation identity and its capability allowlist. Admin
 * only. The identity is a real user row flagged `is_service` with a plain member
 * membership, so every Workspace permission check it triggers is an ordinary
 * member check: it can never hold owner or admin authority.
 */
export async function provisionServicePrincipal(
  q: Query,
  actor: Actor,
  input: { capabilities: unknown },
): Promise<any> {
  assert(
    isTenantAdministrator(actor),
    403,
    "Administrator access required to provision the automation identity",
  );
  assert(
    Array.isArray(input.capabilities),
    400,
    "Capabilities must be an array",
  );
  const capabilities = [...new Set(input.capabilities.map(String))].sort();
  for (const capability of capabilities)
    assert(
      AUTOMATION_SERVICE_CAPABILITIES.includes(capability),
      400,
      `Unknown automation capability: ${capability}`,
    );
  const existing = await one(
    q,
    "SELECT user_id FROM tenant_automation_principals WHERE tenant_id=$1",
    [actor.tenant_id],
  );
  let userId = existing?.user_id as string | undefined;
  if (!userId) {
    userId = randomUUID();
    await q.query(
      "INSERT INTO users(id,email,name,is_service) VALUES($1,$2,$3,true)",
      [
        userId,
        `automation-${actor.tenant_id}@workspace.internal`,
        "Tenant automation",
      ],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)" +
        " ON CONFLICT(tenant_id,user_id) DO UPDATE SET active=true,role='member'",
      [actor.tenant_id, userId],
    );
  } else {
    await q.query(
      "UPDATE memberships SET active=true,role='member' WHERE tenant_id=$1 AND user_id=$2",
      [actor.tenant_id, userId],
    );
  }
  await q.query(
    "INSERT INTO tenant_automation_principals(tenant_id,user_id,capabilities,created_by)" +
      " VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET capabilities=EXCLUDED.capabilities," +
      " user_id=EXCLUDED.user_id,updated_at=now()",
    [actor.tenant_id, userId, capabilities, actor.user_id],
  );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "workflow.service_principal_provisioned",
    null,
  );
  return getServicePrincipal(q, actor);
}

/** Removes the allowlist. The identity remains but no workflow can execute under it. */
export async function deprovisionServicePrincipal(
  q: Query,
  actor: Actor,
): Promise<{ removed: number }> {
  assert(
    isTenantAdministrator(actor),
    403,
    "Administrator access required to remove the automation identity",
  );
  const result = await q.query(
    "DELETE FROM tenant_automation_principals WHERE tenant_id=$1",
    [actor.tenant_id],
  );
  await audit(
    q,
    actor.tenant_id,
    actor.user_id,
    "workflow.service_principal_deprovisioned",
    null,
  );
  return { removed: result.rowCount || 0 };
}

function declaredCapabilities(definition: WorkflowDefinition): string[] {
  const capabilities = new Set<string>();
  for (const action of definition.actions) {
    try {
      capabilities.add(actionFor(action.operation).service_capability);
    } catch {
      // An unregistered operation is rejected at parse time; ignore it here.
    }
  }
  return [...capabilities].sort();
}

/**
 * Resolves the authority a run executes under, fail closed. A delegated run uses
 * the owning user's live membership role; a service principal must be a real
 * service user and runs as a member limited to the capabilities its actions declare.
 */
async function resolveAuthority(
  q: Query,
  tenant: string,
  workflow: any,
  revision: any,
  definition: WorkflowDefinition,
): Promise<{ authority: RunAuthority; actor: Actor } | null> {
  const isService = workflow.authority === "service_principal";
  // The service identity is chosen by an owner/admin in
  // `tenant_automation_principals`, never by the workflow author: a workflow cannot
  // nominate an arbitrary user (least of all an owner) as its own authority.
  const principal = isService
    ? await one(
        q,
        "SELECT user_id,capabilities FROM tenant_automation_principals WHERE tenant_id=$1",
        [tenant],
      )
    : null;
  if (isService && !principal) return null;
  const authorityUserId: string | null = isService
    ? principal.user_id
    : workflow.owner_user_id;
  if (!authorityUserId) return null;
  const membership = await one(
    q,
    "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active",
    [tenant, authorityUserId],
  );
  if (!membership) return null;
  const user = await one(
    q,
    "SELECT id,email,name,is_service FROM users WHERE id=$1",
    [authorityUserId],
  );
  if (!user) return null;
  if (isService && user.is_service !== true) return null;

  const actor: Actor = {
    tenant_id: tenant,
    user_id: authorityUserId,
    role: isService ? "member" : (membership.role as Actor["role"]),
    name: user.name,
    email: user.email,
    scopes: null,
    expires_at: new Date(Date.now() + 60000),
  };
  // A service principal's authority is exactly the operator-provisioned allowlist,
  // intersected with what this revision actually uses. A delegated user run carries
  // its owner's Workspace permissions instead, so the list is informational there.
  const declared = declaredCapabilities(definition);
  const granted = Array.isArray(principal?.capabilities)
    ? (principal!.capabilities as string[])
    : [];
  const capabilities = isService
    ? declared.filter((capability) => granted.includes(capability))
    : declared;
  const authority: RunAuthority = isService
    ? { kind: "service_principal", user_id: authorityUserId, capabilities }
    : { kind: "delegated_user", user_id: authorityUserId, capabilities };
  return { authority, actor };
}

async function executeRun(
  q: Query,
  tenant: string,
  run: any,
  deps: EngineDeps,
): Promise<TickOutcome> {
  const workflow = await one(
    q,
    "SELECT * FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
    [tenant, run.workflow_id],
  );
  if (!workflow)
    return await failRun(
      q,
      tenant,
      run,
      "not_found",
      "Workflow no longer exists",
    );
  const revision = await one(
    q,
    "SELECT * FROM workflow_revisions WHERE tenant_id=$1 AND workflow_id=$2 AND revision=$3",
    [tenant, run.workflow_id, run.revision],
  );
  if (!revision)
    return await failRun(
      q,
      tenant,
      run,
      "not_found",
      "The run's pinned revision is missing",
    );
  const definition = revision.definition as WorkflowDefinition;
  const plan = planSteps(definition);

  const resolved = await resolveAuthority(
    q,
    tenant,
    workflow,
    revision,
    definition,
  );
  if (!resolved)
    return await failRun(
      q,
      tenant,
      run,
      "authorization_revoked",
      "Run authority is no longer valid",
    );
  await q.query(
    "UPDATE workflow_runs SET authority=$3 WHERE tenant_id=$1 AND id=$2",
    [
      tenant,
      run.id,
      json({
        kind: resolved.authority.kind,
        user_id: resolved.authority.user_id,
        capabilities: resolved.authority.capabilities,
      }),
    ],
  );

  const context = boundedContext({
    trigger: (run.trigger_ref || {}) as Record<string, unknown>,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      revision: run.revision,
      authority: workflow.authority,
    },
    authority: {
      kind: resolved.authority.kind,
      user_id: resolved.authority.user_id,
    },
    run: {
      id: run.id,
      trigger_type: run.trigger_type,
      attempt: Number(run.attempts) || 0,
    },
  });

  let gateFailed = false;
  for (
    let index = Number(run.current_step) || 0;
    index < plan.length;
    index++
  ) {
    const step = plan[index];
    const previous = await lastStep(q, tenant, run.id, step.seq);
    // A durably completed step is never re-run, which is what makes a retry or a
    // restart safe after a partial execution.
    if (
      previous &&
      (previous.status === "succeeded" || previous.status === "skipped")
    )
      continue;
    // A step that asked to wait completes here, on the first tick at or after its
    // own deadline. Re-running it instead would re-arm the wait forever and no
    // later step could ever run.
    if (previous && previous.status === "waiting") {
      const until = Number(
        Date.parse(String(previous.retry_state?.waiting_until || "")),
      );
      if (Number.isFinite(until) && until > clock(deps).getTime()) {
        // The deadline has not passed. Restore the waiting state and stop, so an
        // early claim (a recovered lease, a forced retry) cannot re-arm the wait
        // with a fresh deadline or add a spurious attempt.
        await q.query(
          "UPDATE workflow_runs SET status='waiting',next_attempt_at=$3," +
            " lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
          [tenant, run.id, new Date(until)],
        );
        return "waiting";
      }
      if (Number.isFinite(until)) {
        await recordStep(
          q,
          tenant,
          run.id,
          step,
          "succeeded",
          Number(previous.attempt),
          { ...(previous.result || {}), resumed: true },
          null,
          {},
        );
        await q.query(
          "UPDATE workflow_runs SET current_step=$3 WHERE tenant_id=$1 AND id=$2",
          [tenant, run.id, step.seq],
        );
        continue;
      }
    }

    if (step.step_type === "trigger") {
      assertNonSecret({ trigger_type: run.trigger_type });
      await recordStep(
        q,
        tenant,
        run.id,
        step,
        "succeeded",
        0,
        { trigger_type: run.trigger_type },
        null,
        {},
      );
      await q.query(
        "UPDATE workflow_runs SET current_step=$3 WHERE tenant_id=$1 AND id=$2",
        [tenant, run.id, step.seq],
      );
      continue;
    }

    if (step.step_type === "condition") {
      const node = definition.conditions.find(
        (condition) => condition.id === step.node_id,
      );
      const passed = node ? evaluateCondition(node, context) : true;
      if (!passed) gateFailed = true;
      await recordStep(
        q,
        tenant,
        run.id,
        step,
        passed ? "succeeded" : "skipped",
        0,
        { passed },
        passed ? null : "conditions_not_met",
        {},
      );
      await q.query(
        "UPDATE workflow_runs SET current_step=$3 WHERE tenant_id=$1 AND id=$2",
        [tenant, run.id, step.seq],
      );
      continue;
    }

    if (gateFailed) {
      await recordStep(
        q,
        tenant,
        run.id,
        step,
        "skipped",
        0,
        { conditions_met: false },
        null,
        {},
      );
      await q.query(
        "UPDATE workflow_runs SET current_step=$3 WHERE tenant_id=$1 AND id=$2",
        [tenant, run.id, step.seq],
      );
      continue;
    }

    const action = definition.actions.find(
      (candidate) => candidate.id === step.node_id,
    );
    if (!action) {
      await recordStep(q, tenant, run.id, step, "failed", 1, {}, "validation", {
        reason: "action node missing from revision",
      });
      return await failRun(
        q,
        tenant,
        run,
        "validation",
        "Action node is missing from the revision",
      );
    }
    const attempt = (previous ? Number(previous.attempt) : 0) + 1;
    const definitionAction = actionFor(step.operation);
    await recordStep(q, tenant, run.id, step, "running", attempt, {}, null, {});
    try {
      // The service-principal allowlist is enforced HERE, at the one place every
      // step passes through, so no action can bypass it, and INSIDE the step's own
      // try block so the refusal is classified and recorded as a step failure
      // rather than escaping the engine. A delegated user run is bounded by that
      // user's live Workspace permissions instead.
      assert(
        resolved.authority.kind !== "service_principal" ||
          resolved.authority.capabilities.includes(
            definitionAction.service_capability,
          ),
        403,
        `Service principal is not authorised for ${definitionAction.service_capability}`,
      );
      const outcome = await withStepTimeout(
        definitionAction.run({
          q,
          tenant_id: tenant,
          actor: resolved.actor,
          authority: resolved.authority,
          run: {
            id: run.id,
            workflow_id: run.workflow_id,
            revision: run.revision,
          },
          action,
          step: { seq: step.seq, attempt },
          connectorPort: deps.connectorPort,
          config: action.config,
        }),
        WORKFLOW_LIMITS.step_timeout_seconds,
      );
      assertNonSecret(outcome.result || {});
      if (outcome.waiting_until) {
        await recordStep(
          q,
          tenant,
          run.id,
          step,
          "waiting",
          attempt,
          outcome.result || {},
          null,
          {
            waiting_until: outcome.waiting_until.toISOString(),
          },
        );
        await q.query(
          "UPDATE workflow_runs SET status='waiting',next_attempt_at=$3,error_category=NULL,lease_token=NULL," +
            " lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
          [tenant, run.id, outcome.waiting_until],
        );
        return "waiting";
      }
      await recordStep(
        q,
        tenant,
        run.id,
        step,
        "succeeded",
        attempt,
        outcome.result || {},
        null,
        {},
      );
      await q.query(
        "UPDATE workflow_runs SET current_step=$3,error_category=NULL WHERE tenant_id=$1 AND id=$2",
        [tenant, run.id, step.seq],
      );
      continue;
    } catch (error) {
      const classified = classifyActionFailure(error);
      const retryable = definitionAction.retryable && classified.retryable;
      if (retryable && attempt < RETRY_POLICY.max_attempts) {
        const backoff = backoffSeconds(attempt);
        await recordStep(
          q,
          tenant,
          run.id,
          step,
          "failed",
          attempt,
          {},
          classified.category,
          {
            retryable: true,
            backoff_seconds: backoff,
            attempt,
          },
        );
        // The attempt count lives on the step row, so a restart resumes the SAME attempt.
        await q.query(
          "UPDATE workflow_runs SET status='queued',error_category=$3,next_attempt_at=now()+($4 || ' seconds')::interval," +
            " completed_at=NULL,lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
          [tenant, run.id, classified.category, String(backoff)],
        );
        return "retry";
      }
      const exhausted = retryable;
      await recordStep(
        q,
        tenant,
        run.id,
        step,
        exhausted ? "dead_letter" : "failed",
        attempt,
        {},
        classified.category,
        {
          retryable,
          attempt,
        },
      );
      await q.query(
        "UPDATE workflow_runs SET status=$3,error_category=$4,completed_at=now(),lease_token=NULL,lease_expires_at=NULL" +
          " WHERE tenant_id=$1 AND id=$2",
        [
          tenant,
          run.id,
          exhausted ? "dead_letter" : "failed",
          classified.category,
        ],
      );
      return "failed";
    }
  }

  await q.query(
    "UPDATE workflow_runs SET status='succeeded',error_category=NULL,current_step=$3,completed_at=now()," +
      " lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
    [tenant, run.id, plan.length],
  );
  return "succeeded";
}

/**
 * Deletes a bounded batch of retired run history: terminal runs past the retention
 * window, then terminal runs beyond the per-tenant history cap (newest first).
 * A run that is queued, running or waiting is NEVER deleted.
 */
export async function pruneRuns(
  q: Query,
  tenant: string,
): Promise<{ deleted: number }> {
  const batch = WORKFLOW_LIMITS.prune_batch;
  const cutoff = (
    await one(q, "SELECT now() - ($1::int * interval '1 day') AS cutoff", [
      WORKFLOW_LIMITS.run_retention_days,
    ])
  )?.cutoff;
  const expired = await q.query(
    "DELETE FROM workflow_runs WHERE id IN (SELECT id FROM workflow_runs WHERE tenant_id=$1" +
      " AND status IN ('succeeded','failed','cancelled','dead_letter') AND created_at < $2::timestamptz" +
      " ORDER BY created_at,id LIMIT $3)",
    [tenant, cutoff, batch],
  );
  let deleted = expired.rowCount || 0;
  if (deleted < batch) {
    const overflow = await q.query(
      "DELETE FROM workflow_runs WHERE id IN (SELECT id FROM workflow_runs WHERE tenant_id=$1" +
        " AND status IN ('succeeded','failed','cancelled','dead_letter')" +
        " ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT $3)",
      [tenant, WORKFLOW_LIMITS.max_run_history_per_tenant, batch - deleted],
    );
    deleted += overflow.rowCount || 0;
  }
  return { deleted };
}

export async function workflowMetrics(
  db: Database,
): Promise<Record<string, number>> {
  const row = await db.system((q) =>
    one(q, "SELECT * FROM workspace_workflow_health()"),
  );
  return {
    workflows_enabled: Number(row?.workflows_enabled || 0),
    runs_started: Number(row?.runs_started || 0),
    runs_succeeded: Number(row?.runs_succeeded || 0),
    runs_failed: Number(row?.runs_failed || 0),
    runs_queued: Number(row?.runs_queued || 0),
    runs_dead_letter: Number(row?.runs_dead_letter || 0),
    retries: Number(row?.retries || 0),
    execution_latency_seconds: Number(row?.execution_latency_seconds || 0),
  };
}
