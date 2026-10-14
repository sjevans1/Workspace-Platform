/**
 * W29-A / W30-A end-to-end journey acceptance.
 *
 * This is the tranche's stated success condition, exercised against a real
 * PostgreSQL with the API and the worker running as the restricted
 * `workspace_runtime` role, so row level security is genuinely enforced:
 *
 *  1. connect a provider;
 *  2. receive a verified connector event;
 *  3. normalize and deduplicate it;
 *  4. trigger an enabled workflow;
 *  5. evaluate conditions;
 *  6. execute a permissioned action;
 *  7. survive retry and restart correctly;
 *  8. record the entire run;
 *  9. inspect it;
 * 10. revoke the connection and prove future actions fail closed.
 *
 * The provider is the deterministic synthetic adapter, so nothing here needs an
 * external account, a credential, a network identity provider or an LLM.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { tick } from "../apps/worker/src/worker.ts";
import { createSession, csrf } from "../packages/auth/index.ts";
import { testPostgres } from "../scripts/test-postgres.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { planSteps, parseWorkflowDefinition } from "../packages/automation/index.ts";
import {
  openCredential,
  credentialAad,
  readCredential,
} from "../packages/connectors/index.ts";

let pg: any, db: Database, app: any, owner: any, tenant: string, page: any;

const req = async (method: string, path: string, data?: any, actor = owner, extra: any = {}) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      ...(actor ? { cookie: actor.cookie, "x-csrf-token": actor.csrf } : {}),
      ...extra,
    },
    ...(data !== undefined ? { payload: data } : {}),
  });

const ok = async (method: string, path: string, data?: any, actor = owner) => {
  const r = await req(method, path, data, actor);
  assert.ok(r.statusCode < 300, `${method} ${path}: ${r.statusCode} ${r.body}`);
  return r.json();
};

/**
 * Drains the bounded engine: engineTick claims at most
 * WORKFLOW_LIMITS.max_runs_per_tick runs per tick, so a run created behind other
 * work is picked up on a later tick rather than the first one.
 */
const drain = async (times = 4) => {
  for (let index = 0; index < times; index++) await tick(db);
};

const DENIED = async (method: string, path: string, data?: any, actor = owner) => {
  const r = await req(method, path, data, actor);
  assert.ok(r.statusCode >= 400, `${method} ${path} unexpectedly allowed: ${r.statusCode}`);
  return r;
};

const workflowDefinition = (connectionId: string, resourceId: string) => ({
  schema_version: 1,
  trigger: {
    id: "when_synthetic",
    type: "connector_event",
    // A distinct type from the provider's own background sync traffic, so this
    // workflow reacts only to the events the journey deliberately delivers.
    event_types: ["synthetic.message.received"],
    provider_keys: ["synthetic-test"],
  },
  conditions: [
    {
      id: "only_high_priority",
      kind: "leaf",
      path: "trigger.payload.priority",
      operator: "equals",
      value: "high",
    },
  ],
  actions: [
    {
      id: "notify_owner",
      operation: "workspace.notification.create",
      config: { resource_id: resourceId, message: "High priority synthetic event" },
    },
    {
      id: "record_on_connector",
      operation: "connector.action.invoke",
      config: {
        connection_id: connectionId,
        action: "synthetic.record",
        capability: "message.send",
        payload: { label: "journey" },
      },
    },
  ],
});

before(async () => {
  process.env.ENCRYPTION_KEY = "b".repeat(64);
  process.env.SETUP_TOKEN = "journey-setup-token";
  process.env.COOKIE_SECURE = "false";
  process.env.STORAGE_LOCAL_PATH = await mkdtemp(`${tmpdir()}/workspace-journey-`);
  pg = await testPostgres(55447);
  if (!pg.emulated) process.env.RUNTIME_DB_PASSWORD = "journey-runtime-password";
  await migrate(pg.url);
  let applicationUrl = pg.url;
  if (!pg.emulated) {
    const runtimeUrl = new URL(pg.url);
    runtimeUrl.username = "workspace_runtime";
    runtimeUrl.password = process.env.RUNTIME_DB_PASSWORD!;
    applicationUrl = runtimeUrl.toString();
  }
  db = new Database(applicationUrl, { serialize: pg.emulated });
  app = await buildApp(db, undefined, false, null);
  const setup = await req(
    "POST",
    "/setup",
    {
      organisation: "Journey Co",
      workspace: "HQ",
      name: "Owner",
      email: "journey-owner@example.test",
      password: "test-password-123",
      demo: false,
    },
    null,
    { "x-setup-token": process.env.SETUP_TOKEN },
  );
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"].split(";")[0];
  owner = { cookie, csrf: csrf(cookie.split("=")[1]) };
  const me = await ok("GET", "/me");
  tenant = me.organisation.id;
  const roots = await ok("GET", "/resources");
  const workspaceRoot = roots.find((row: any) => row.kind === "workspace");
  assert.ok(workspaceRoot, "the workspace root must be readable");
  const space = await ok("POST", "/resources", {
    kind: "space",
    parent_id: workspaceRoot.id,
    title: "Ops",
  });
  page = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Runbook",
  });
});

after(async () => {
  await db?.close();
  await pg?.close();
});

test("W29-A/W30-A journey: a disconnected workspace is already fully functional", async () => {
  assert.deepEqual((await ok("GET", "/connectors/connections")).connections, []);
  assert.deepEqual((await ok("GET", "/automations/workflows")).workflows, []);
  // Ordinary authoring is unaffected by the new subsystems.
  const page2 = await ok("POST", "/resources", {
    kind: "page",
    parent_id: page.parent_id,
    title: "Still works",
  });
  assert.equal(page2.kind, "page");
  const catalog = await ok("GET", "/connectors/catalog");
  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0].implemented, true);
  assert.ok(catalog.declared.length >= 9);
  assert.ok(catalog.declared.every((entry: any) => entry.implemented === false));
});

test("W29-A/W30-A journey: connect, ingest, dedupe, trigger, act, evidence, revoke", async () => {
  // 1. Connect a provider. The operator supplies the secret; nothing is returned.
  const { connection } = await ok("POST", "/connectors/connections", {
    provider_key: "synthetic-test",
    label: "Synthetic journey",
    ownership: "tenant",
  });
  assert.equal(connection.status, "pending");
  const secret = "journey-synthetic-token-0123456789";
  const connected = await ok("POST", `/connectors/connections/${connection.id}/connect`, {
    secret,
  });
  assert.equal(connected.connection.status, "connected");
  assert.ok(connected.connection.capabilities_granted.includes("message.send"));
  assert.ok(!JSON.stringify(connected).includes(secret), "secret leaked in the connect response");
  assert.ok(!JSON.stringify(connected).includes("secret_encrypted"));

  // The credential really is encrypted at rest and really is bound to this scope.
  const stored = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT secret_encrypted,metadata,kind FROM connector_credentials WHERE connection_id=$1",
      [connection.id],
    ),
  );
  assert.ok(!stored.secret_encrypted.includes(secret));
  assert.equal(
    openCredential(
      credentialAad(tenant, connection.id, "webhook_secret"),
      stored.secret_encrypted,
    ),
    secret,
  );

  // 2. Define and enable a workflow.
  const definition = workflowDefinition(connection.id, page.id);
  const created = await ok("POST", "/automations/workflows", {
    name: "Notify on high priority",
    description: "Deterministic, no model involved",
    definition,
  });
  assert.equal(created.workflow.status, "draft");
  const plan = created.plan;
  const workflowId = created.workflow.id;
  const enabled = await ok("POST", `/automations/workflows/${workflowId}/enable`);
  assert.equal(enabled.workflow.status, "enabled");
  assert.ok(enabled.workflow.published_revision >= 1);

  // 3. Receive a VERIFIED connector event, then replay it.
  const inbound = {
    event_type: "synthetic.message.received",
    provider_event_id: "journey-event-1",
    priority: "high",
    summary: "priority inbound",
  };
  const first = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    inbound,
    null,
    { "x-connector-token": secret, "content-type": "application/json" },
  );
  assert.equal(first.statusCode, 202, first.body);
  assert.equal(first.json().accepted, true);
  assert.equal(first.json().duplicate, false);

  const replay = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    inbound,
    null,
    { "x-connector-token": secret, "content-type": "application/json" },
  );
  assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().duplicate, true);
  assert.equal(replay.json().event_id, first.json().event_id);

  // A forged token is refused, and refuses to say whether the connection exists.
  const forged = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    inbound,
    null,
    { "x-connector-token": "not-the-token-at-all-0123456789" },
  );
  assert.equal(forged.statusCode, 401);
  const unknownConnection = await req(
    "POST",
    `/connectors/ingress/${randomUUID()}`,
    inbound,
    null,
    { "x-connector-token": secret },
  );
  assert.equal(unknownConnection.statusCode, 401);
  assert.equal(unknownConnection.json().error, forged.json().error);

  const events = await ok("GET", `/connectors/connections/${connection.id}/events`);
  assert.equal(events.events.length, 1, "a replayed delivery must not create a second event");
  assert.equal(events.events[0].duplicate_count, 1);
  assert.equal(events.events[0].verification, "verified");
  assert.equal(events.events[0].dispatch_state, "pending");

  // 4-6. The worker dispatches the event and executes the run.
  await drain();
  const runs = await ok("GET", `/automations/runs?workflow_id=${workflowId}`);
  assert.equal(runs.runs.length, 1, "one verified event must produce exactly one run");
  const runId = runs.runs[0].id;
  const detail = await ok("GET", `/automations/runs/${runId}`);
  assert.equal(detail.run.status, "succeeded");
  assert.equal(detail.run.revision, enabled.workflow.published_revision);
  const operations = detail.steps.map((step: any) => step.operation);
  assert.deepEqual(operations, [
    "trigger.connector_event",
    "condition.leaf",
    "workspace.notification.create",
    "connector.action.invoke",
  ]);
  assert.ok(detail.steps.every((step: any) => step.status === "succeeded"));
  const invoked = detail.steps.find(
    (step: any) => step.operation === "connector.action.invoke",
  );
  assert.equal(invoked.result.recorded, true, JSON.stringify(invoked.result));
  assert.ok(!JSON.stringify(detail).includes(secret), "run history leaked a secret");

  const notifications = await db.tenant(tenant, (q) =>
    q.query("SELECT id,message FROM notifications WHERE resource_id=$1", [page.id]),
  );
  assert.equal(notifications.rows.length, 1, "the notification action must have run once");

  // 8-9. Duplicate delivery and a worker restart do not duplicate the logical action.
  const before = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM workflow_run_steps WHERE run_id=$1", [runId]),
  );
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_runs SET lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now() WHERE id=$1",
      [runId],
    ),
  );
  await drain(2);
  const afterSteps = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM workflow_run_steps WHERE run_id=$1", [runId]),
  );
  const afterNotifications = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM notifications WHERE resource_id=$1", [page.id]),
  );
  assert.equal(afterSteps.c, before.c, "a restart must not add step attempts to a finished run");
  assert.equal(afterNotifications.c, 1, "a restart must not repeat a completed action");
  const stillOne = await ok("GET", `/automations/runs?workflow_id=${workflowId}`);
  assert.equal(stillOne.runs.length, 1);

  // A second, genuinely new event produces a second run.
  const second = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    { ...inbound, provider_event_id: "journey-event-2" },
    null,
    { "x-connector-token": secret },
  );
  assert.equal(second.statusCode, 202);
  await drain(2);
  const twoRuns = await ok("GET", `/automations/runs?workflow_id=${workflowId}`);
  assert.equal(twoRuns.runs.length, 2);

  // A condition that does not match still records a run, but runs no action.
  const lowPriority = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    { ...inbound, provider_event_id: "journey-event-3", priority: "low" },
    null,
    { "x-connector-token": secret },
  );
  assert.equal(lowPriority.statusCode, 202);
  const knownRunIds = new Set(twoRuns.runs.map((run: any) => run.id));
  await drain(2);
  const runsAfterLow = await ok("GET", `/automations/runs?workflow_id=${workflowId}`);
  assert.equal(runsAfterLow.runs.length, 3);
  const lowRunId = runsAfterLow.runs.find((run: any) => !knownRunIds.has(run.id)).id;
  const lowRun = await ok("GET", `/automations/runs/${lowRunId}`);
  assert.equal(lowRun.run.status, "succeeded");
  const skipped = lowRun.steps.filter((step: any) => step.step_type === "action");
  assert.ok(
    skipped.every((step: any) => step.status === "skipped"),
    "a failed condition gate must skip every action",
  );
  const lowNotifications = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM notifications WHERE resource_id=$1", [page.id]),
  );
  assert.equal(lowNotifications.c, 2, "only the two high-priority events may act");

  // 10. Revoke the connection and prove a future action fails closed.
  const revoked = await ok("POST", `/connectors/connections/${connection.id}/revoke`);
  assert.equal(revoked.connection.status, "revoked");
  assert.deepEqual(revoked.connection.capabilities_granted, []);
  const remainingCredentials = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM connector_credentials WHERE connection_id=$1 AND revoked_at IS NULL",
      [connection.id],
    ),
  );
  assert.equal(remainingCredentials.c, 0, "revocation must invalidate every credential");
  const readable = await db.tenant(tenant, (q) =>
    readCredential(q, tenant, connection.id, "webhook_secret"),
  );
  assert.equal(readable, null, "a revoked credential must not be readable");

  const revokedIngress = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    { ...inbound, provider_event_id: "journey-event-4" },
    null,
    { "x-connector-token": secret },
  );
  assert.equal(revokedIngress.statusCode, 401, "a revoked connection must not accept events");

  // A workflow that targets the revoked connector now fails closed. It carries no
  // condition gate, so the failure can only come from the connector authorization
  // re-check at execution time.
  const failClosed = await ok("POST", "/automations/workflows", {
    name: "Fail closed on revoked connector",
    definition: {
      schema_version: 1,
      trigger: { id: "manual", type: "manual" },
      conditions: [],
      actions: [
        {
          id: "connector_call",
          operation: "connector.action.invoke",
          config: {
            connection_id: connection.id,
            action: "synthetic.record",
            capability: "message.send",
            payload: { label: "after-revoke" },
          },
        },
      ],
    },
  });
  await ok("POST", `/automations/workflows/${failClosed.workflow.id}/enable`);
  const manual = await ok("POST", `/automations/workflows/${failClosed.workflow.id}/run`, {
    idempotency_key: "journey-after-revoke",
  });
  await drain();
  const failed = await ok("GET", `/automations/runs/${manual.run.id}`);
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.trigger_type, "manual");
  const failedAction = failed.steps.find(
    (step: any) => step.operation === "connector.action.invoke",
  );
  assert.equal(failedAction.status, "failed");
  assert.ok(
    ["authorization_revoked", "capability_missing", "connector_attention_required"].includes(
      failedAction.error_category,
    ),
    `unexpected failure category ${failedAction.error_category}`,
  );
  const finalNotifications = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM notifications WHERE resource_id=$1", [page.id]),
  );
  assert.equal(finalNotifications.c, 2, "the revoked connector must not produce a side effect");

  // A disabled workflow cannot start new runs.
  await ok("POST", `/automations/workflows/${workflowId}/disable`);
  const refused = await DENIED("POST", `/automations/workflows/${workflowId}/run`, {});
  assert.equal(refused.statusCode, 409);
});

test("W30-A journey: revisions are immutable and plans are deterministic", async () => {
  const created = await ok("POST", "/automations/workflows", {
    name: "Determinism",
    definition: {
      schema_version: 1,
      trigger: { id: "manual", type: "manual" },
      conditions: [
        {
          id: "all_of",
          kind: "all",
          conditions: [
            { id: "flag", kind: "leaf", path: "trigger.payload.flag", operator: "boolean", value: true },
          ],
        },
      ],
      actions: [
        { id: "notice", operation: "workspace.notification.create", config: { resource_id: page.id, message: "deterministic" } },
      ],
    },
  });
  const definition = parseWorkflowDefinition(created.draft_definition);
  assert.deepEqual(planSteps(definition), planSteps(definition));
  assert.equal(planSteps(definition).length, 3);
  const enabled = await ok("POST", `/automations/workflows/${created.workflow.id}/enable`);
  const pinned = enabled.workflow.published_revision;

  const run = await ok("POST", `/automations/workflows/${created.workflow.id}/run`, {});
  assert.equal(run.run.revision, pinned);

  // Editing the workflow creates a NEW draft revision and cannot rewrite history.
  await ok("PATCH", `/automations/workflows/${created.workflow.id}`, {
    definition: {
      schema_version: 1,
      trigger: { id: "manual", type: "manual" },
      conditions: [],
      actions: [
        { id: "notice", operation: "workspace.notification.create", config: { resource_id: page.id, message: "edited" } },
      ],
    },
  });
  const revisionRow = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT definition,digest FROM workflow_revisions WHERE workflow_id=$1 AND revision=$2",
      [created.workflow.id, pinned],
    ),
  );
  assert.equal(planSteps(parseWorkflowDefinition(revisionRow.definition)).length, 3);
  const refused = await db.tenant(tenant, (q) =>
    q
      .query("UPDATE workflow_revisions SET digest=$2 WHERE workflow_id=$1", [
        created.workflow.id,
        "0".repeat(64),
      ])
      .then(() => null)
      .catch((error: Error) => error),
  );
  assert.ok(refused instanceof Error, "a published revision must not be updatable");
});

test("W30-A journey: a revoked membership fails closed before any step executes", async () => {
  // The workflow is owned by a second administrator whose membership is the
  // authority under test; the session that TRIGGERS the run stays valid, so the
  // failure can only come from the run's own authority re-check.
  const adminId = randomUUID();
  await db.tenant(tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      adminId,
      `journey-admin-${adminId}@example.test`,
      "Journey admin",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'admin',true)",
      [tenant, adminId],
    );
  });
  const adminToken = await db.tenant(tenant, (q) => createSession(q, tenant, adminId));
  const admin = { cookie: "workspace_session=" + adminToken, csrf: csrf(adminToken) };
  const created = await ok(
    "POST",
    "/automations/workflows",
    {
      name: "Authority",
      definition: {
        schema_version: 1,
        trigger: { id: "manual", type: "manual" },
        conditions: [],
        actions: [
          {
            id: "notice",
            operation: "workspace.notification.create",
            config: { resource_id: page.id, message: "authority" },
          },
        ],
      },
    },
    admin,
  );
  await ok("POST", `/automations/workflows/${created.workflow.id}/enable`, undefined, admin);
  const before = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM notifications WHERE resource_id=$1", [page.id]),
  );
  // Revoke the owning administrator's membership, then trigger the run as the owner.
  await db.tenant(tenant, (q) =>
    q.query("UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2", [tenant, adminId]),
  );
  const run = await ok("POST", `/automations/workflows/${created.workflow.id}/run`, {
    idempotency_key: "authority-check",
  });
  await tick(db);
  const detail = await ok("GET", `/automations/runs/${run.run.id}`);
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.run.error_category, "authorization_revoked");
  assert.equal(detail.steps.length, 0, "no step may execute once authority is gone");
  const after = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM notifications WHERE resource_id=$1", [page.id]),
  );
  assert.equal(after.c, before.c, "a revoked authority must not produce a side effect");
  // Restore so the file is order-independent for later assertions.
  await db.tenant(tenant, async (q) => {
    await q.query("UPDATE memberships SET active=true WHERE tenant_id=$1", [tenant]);
  });
});

test("W29-A journey: a revoked user session cannot read the tenant's connector state", async () => {
  const memberId = randomUUID();
  await db.tenant(tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      memberId,
      `journey-member-${memberId}@example.test`,
      "Journey member",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [tenant, memberId],
    );
  });
  const token = await db.tenant(tenant, (q) => createSession(q, tenant, memberId));
  const member = { cookie: "workspace_session=" + token, csrf: csrf(token) };
  const list = await ok("GET", "/connectors/connections", undefined, member);
  assert.ok(Array.isArray(list.connections));
  // A member may not manage a shared connection.
  const denied = await DENIED("POST", `/connectors/connections`, {
    provider_key: "synthetic-test",
    label: "member shared",
    ownership: "tenant",
  }, member);
  assert.equal(denied.statusCode, 403);
  await db.tenant(tenant, (q) =>
    q.query("UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2", [tenant, memberId]),
  );
  const afterRevoke = await DENIED("GET", "/connectors/connections", undefined, member);
  assert.equal(afterRevoke.statusCode, 401);
});
