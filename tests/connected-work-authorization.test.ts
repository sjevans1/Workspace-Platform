/**
 * W29-A / W30-A corrections: tenant-scoped customer metrics, and the 1.0 workflow
 * visibility and manual-trigger rule.
 *
 * Two properties are proved here, both at the API layer because the API is the
 * authority:
 *
 * 1. The customer metric endpoints report ONLY the caller's own tenant. They are
 *    computed inside the caller's tenant transaction under FORCE RLS and are
 *    owner/admin only, so they never reach the deployment-wide SECURITY DEFINER
 *    aggregates that a platform/operator surface may legitimately use.
 * 2. A workflow is reachable only by its owner and by a tenant owner/admin. A
 *    non-owner gets the same non-enumerating 404 the tenant boundary produces,
 *    for the workflow, its runs, its step evidence and its manual trigger, because
 *    a workflow can execute under a tenant service principal whose authority
 *    exceeds the person pressing Run.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { createSession, csrf } from "../packages/auth/index.ts";
import { testPostgres } from "../scripts/test-postgres.ts";

let pg: any,
  db: Database,
  app: any,
  owner: any,
  tenant: string,
  otherTenant: string;
let admin: any, memberA: any, memberB: any, otherOwner: any;

const req = async (
  method: string,
  path: string,
  data?: any,
  actor = owner,
  extra: Record<string, string> = {},
) =>
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
  let r = await req(method, path, data, actor);
  if (r.statusCode === 429) {
    const retry = Number(r.headers["retry-after"] || 5);
    await new Promise((resolve) => setTimeout(resolve, (retry + 1) * 1000));
    r = await req(method, path, data, actor);
  }
  assert.ok(r.statusCode < 300, `${method} ${path}: ${r.statusCode} ${r.body}`);
  return r.json();
};

/** A denial must be a 4xx, and for a foreign object it must be the non-enumerating 404. */
const denied = async (
  method: string,
  path: string,
  data?: any,
  actor = owner,
) => {
  const r = await req(method, path, data, actor);
  assert.ok(
    r.statusCode >= 400,
    `${method} ${path} unexpectedly allowed: ${r.statusCode}`,
  );
  return r;
};

const sessionFor = async (t: string, userId: string) => {
  const token = await db.tenant(t, (q) => createSession(q, t, userId));
  return {
    id: userId,
    tenant: t,
    cookie: "workspace_session=" + token,
    csrf: csrf(token),
  };
};

async function addUser(t: string, role: string, label: string) {
  const id = randomUUID();
  await db.tenant(t, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      id,
      `${label}-${id}@example.test`,
      label,
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,$3,true)",
      [t, id, role],
    );
  });
  return sessionFor(t, id);
}

const manualWorkflow = (name: string) => ({
  name,
  definition: {
    schema_version: 1,
    trigger: { id: "manual", type: "manual" },
    conditions: [],
    actions: [
      {
        id: "emit",
        operation: "workspace.webhook.emit",
        config: { event_type: "workflow.authorization-check" },
      },
    ],
  },
});

/** Creates an enabled workflow owned by `actor` and returns its id. */
async function ownedEnabledWorkflow(
  actor: any,
  name: string,
  authority?: string,
) {
  const created = await ok(
    "POST",
    "/automations/workflows",
    authority ? { ...manualWorkflow(name), authority } : manualWorkflow(name),
    actor,
  );
  await ok(
    "POST",
    `/automations/workflows/${created.workflow.id}/enable`,
    undefined,
    actor,
  );
  return created.workflow.id;
}

async function runOnce(workflowId: string, actor: any, key: string) {
  const run = await ok(
    "POST",
    `/automations/workflows/${workflowId}/run`,
    { idempotency_key: key },
    actor,
  );
  return run.run;
}

before(async () => {
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  process.env.SETUP_TOKEN = "authorization-setup-token";
  process.env.COOKIE_SECURE = "false";
  pg = await testPostgres(55449);
  if (!pg.emulated)
    process.env.RUNTIME_DB_PASSWORD = "authorization-runtime-password";
  await migrate(pg.url);
  let applicationUrl = pg.url;
  if (!pg.emulated) {
    const runtimeUrl = new URL(pg.url);
    runtimeUrl.username = "workspace_runtime";
    runtimeUrl.password = process.env.RUNTIME_DB_PASSWORD!;
    applicationUrl = runtimeUrl.toString();
  }
  db = new Database(applicationUrl);
  app = await buildApp(db, undefined, false, null);
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    headers: { "x-setup-token": process.env.SETUP_TOKEN },
    payload: {
      organisation: "Authority Co",
      workspace: "HQ",
      name: "Owner",
      email: "authority-owner@example.test",
      password: "test-password-123",
      demo: false,
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"].split(";")[0];
  owner = { cookie, csrf: csrf(cookie.split("=")[1]) };
  const me = await ok("GET", "/me");
  tenant = me.organisation.id;
  admin = await addUser(tenant, "admin", "Authority admin");
  memberA = await addUser(tenant, "member", "Member A");
  memberB = await addUser(tenant, "member", "Member B");
  otherTenant = randomUUID();
  await db.tenant(otherTenant, async (q) => {
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      otherTenant,
      "Other Co",
    ]);
  });
  otherOwner = await addUser(otherTenant, "owner", "Other owner");
});

after(async () => {
  await db?.close();
  await pg?.close();
});

test("W29-A metrics: connector counters are scoped to the caller's tenant", async () => {
  // Baseline: nothing yet in this tenant.
  const empty = await ok("GET", "/connectors/metrics");
  assert.equal(empty.connections, 0);

  // Tenant activity in both tenants.
  const { connection } = await ok("POST", "/connectors/connections", {
    provider_key: "synthetic-test",
    label: "Tenant A connection",
    ownership: "tenant",
  });
  await ok("POST", `/connectors/connections/${connection.id}/connect`, {
    secret: "tenant-a-synthetic-token-0001",
  });
  const aSecret = "tenant-a-synthetic-token-0001";
  const accepted = await req(
    "POST",
    `/connectors/ingress/${connection.id}`,
    {
      event_type: "synthetic.message.received",
      provider_event_id: "a-event-1",
      priority: "high",
    },
    null,
    { "x-connector-token": aSecret },
  );
  assert.equal(accepted.statusCode, 202, accepted.body);

  const other = await ok(
    "POST",
    "/connectors/connections",
    {
      provider_key: "synthetic-test",
      label: "Tenant B connection",
      ownership: "tenant",
    },
    otherOwner,
  );
  await ok(
    "POST",
    `/connectors/connections/${other.connection.id}/connect`,
    {
      secret: "tenant-b-synthetic-token-0002",
    },
    otherOwner,
  );
  const bSecret = "tenant-b-synthetic-token-0002";
  for (let index = 0; index < 3; index++) {
    const acceptedByB = await req(
      "POST",
      `/connectors/ingress/${other.connection.id}`,
      {
        event_type: "synthetic.message.received",
        provider_event_id: `b-event-${index}`,
        priority: "low",
      },
      null,
      { "x-connector-token": bSecret },
    );
    assert.equal(acceptedByB.statusCode, 202, acceptedByB.body);
  }

  const a = await ok("GET", "/connectors/metrics");
  assert.equal(a.connections, 1, "tenant A sees only its own connection");
  assert.equal(a.events_received, 1, "tenant A sees only its own events");

  const b = await ok("GET", "/connectors/metrics", undefined, otherOwner);
  assert.equal(b.connections, 1);
  assert.equal(b.events_received, 3, "tenant B sees only its own events");

  // More tenant B activity must not move tenant A's counters.
  const third = await ok(
    "POST",
    "/connectors/connections",
    {
      provider_key: "synthetic-test",
      label: "Tenant B second",
      ownership: "tenant",
    },
    otherOwner,
  );
  await ok(
    "POST",
    `/connectors/connections/${third.connection.id}/connect`,
    {
      secret: "tenant-b-synthetic-token-0003",
    },
    otherOwner,
  );
  const aAfter = await ok("GET", "/connectors/metrics");
  assert.deepEqual(
    aAfter,
    a,
    "tenant B activity must not change tenant A's connector counters",
  );
  const bAfter = await ok("GET", "/connectors/metrics", undefined, otherOwner);
  assert.equal(bAfter.connections, 2);
  assert.notDeepEqual(bAfter, aAfter);
});

test("W30-A metrics: workflow counters are scoped to the caller's tenant", async () => {
  const empty = await ok("GET", "/automations/metrics");
  assert.equal(empty.runs_started, 0);

  const aWorkflow = await ownedEnabledWorkflow(owner, "Tenant A workflow");
  const aRun = await runOnce(aWorkflow, owner, "metrics-a-1");
  await ok("POST", "/automations/dev/tick", {});
  const a = await ok("GET", "/automations/metrics");
  assert.equal(a.workflows_enabled, 1);
  assert.equal(a.runs_started, 1);

  const bWorkflow = await ownedEnabledWorkflow(otherOwner, "Tenant B workflow");
  await runOnce(bWorkflow, otherOwner, "metrics-b-1");
  await ok("POST", "/automations/dev/tick", {}, otherOwner);

  const aAfter = await ok("GET", "/automations/metrics");
  assert.deepEqual(
    aAfter,
    a,
    "tenant B workflow activity must not change tenant A's counters",
  );
  const b = await ok("GET", "/automations/metrics", undefined, otherOwner);
  assert.equal(b.workflows_enabled, 1);
  assert.equal(b.runs_started, 1);
  assert.equal(
    (await ok("GET", `/automations/runs/${aRun.id}`)).run.id,
    aRun.id,
  );
});

test("customer metrics and the automation identity are owner/admin only", async () => {
  const connectorMetrics = await denied(
    "GET",
    "/connectors/metrics",
    undefined,
    memberA,
  );
  assert.equal(connectorMetrics.statusCode, 403);
  const workflowMetrics = await denied(
    "GET",
    "/automations/metrics",
    undefined,
    memberA,
  );
  assert.equal(workflowMetrics.statusCode, 403);
  const identity = await denied(
    "GET",
    "/automations/service-principal",
    undefined,
    memberA,
  );
  assert.equal(identity.statusCode, 403);
  const guest = await addUser(tenant, "guest", "Authority guest");
  assert.equal(
    (await denied("GET", "/connectors/metrics", undefined, guest)).statusCode,
    403,
  );

  // An owner and an admin both read them.
  assert.equal(
    (await ok("GET", "/connectors/metrics", undefined, admin)).connections,
    1,
  );
  assert.equal(
    (await ok("GET", "/automations/metrics", undefined, admin))
      .workflows_enabled,
    1,
  );
  const asOwner = await ok("GET", "/automations/service-principal");
  assert.equal(typeof asOwner.service_principal.configured, "boolean");
});

test("workflow visibility: members see their own work, owner/admin govern the tenant", async () => {
  const ownedByA = await ownedEnabledWorkflow(memberA, "Member A workflow");
  const ownedByB = await ownedEnabledWorkflow(memberB, "Member B workflow");

  const listA = await ok("GET", "/automations/workflows", undefined, memberA);
  assert.deepEqual(
    listA.workflows.map((workflow: any) => workflow.id),
    [ownedByA],
    "member A lists only their own workflow",
  );
  const listB = await ok("GET", "/automations/workflows", undefined, memberB);
  assert.deepEqual(
    listB.workflows.map((workflow: any) => workflow.id),
    [ownedByB],
    "member B lists only their own workflow",
  );
  const listOwner = await ok("GET", "/automations/workflows");
  const ownerIds = listOwner.workflows.map((workflow: any) => workflow.id);
  assert.ok(ownerIds.includes(ownedByA) && ownerIds.includes(ownedByB));
  const listAdmin = await ok("GET", "/automations/workflows", undefined, admin);
  const adminIds = listAdmin.workflows.map((workflow: any) => workflow.id);
  assert.ok(adminIds.includes(ownedByA) && adminIds.includes(ownedByB));

  // A member can still read and run their OWN workflow.
  const ownDetail = await ok(
    "GET",
    `/automations/workflows/${ownedByA}`,
    undefined,
    memberA,
  );
  assert.equal(ownDetail.workflow.id, ownedByA);
  const ownRun = await runOnce(ownedByA, memberA, "member-a-own-run");
  await ok("POST", "/automations/dev/tick", {}, memberA);
  assert.equal(
    (await ok("GET", `/automations/runs/${ownRun.id}`, undefined, memberA)).run
      .status,
    "succeeded",
    "a member's own delegated workflow still runs",
  );

  // Direct reads of another member's workflow are non-enumerating.
  const foreignDetail = await denied(
    "GET",
    `/automations/workflows/${ownedByB}`,
    undefined,
    memberA,
  );
  assert.equal(foreignDetail.statusCode, 404);
  assert.match(foreignDetail.json().error, /not found/i);
  const foreignEdit = await denied(
    "PATCH",
    `/automations/workflows/${ownedByB}`,
    { definition: manualWorkflow("hijack").definition },
    memberA,
  );
  assert.equal(foreignEdit.statusCode, 404);
  const foreignDelete = await denied(
    "DELETE",
    `/automations/workflows/${ownedByB}`,
    undefined,
    memberA,
  );
  assert.equal(foreignDelete.statusCode, 404);

  // Run history and step evidence of another member's workflow are unreachable.
  const foreignRun = await runOnce(ownedByB, memberB, "member-b-own-run");
  await ok("POST", "/automations/dev/tick", {}, memberB);
  const foreignRunRead = await denied(
    "GET",
    `/automations/runs/${foreignRun.id}`,
    undefined,
    memberA,
  );
  assert.equal(foreignRunRead.statusCode, 404);
  const filtered = await denied(
    "GET",
    `/automations/runs?workflow_id=${ownedByB}`,
    undefined,
    memberA,
  );
  assert.equal(filtered.statusCode, 404);
  const ownList = await ok(
    "GET",
    `/automations/runs?workflow_id=${ownedByA}`,
    undefined,
    memberA,
  );
  assert.ok(ownList.runs.every((run: any) => run.workflow_id === ownedByA));
  const unfilteredA = await ok("GET", "/automations/runs", undefined, memberA);
  assert.ok(
    unfilteredA.runs.every((run: any) => run.workflow_id === ownedByA),
    "an unfiltered run list carries only the caller's own runs",
  );

  // An owner/admin sees both members' runs.
  const ownerRuns = await ok("GET", "/automations/runs");
  const ownerRunWorkflows = new Set(
    ownerRuns.runs.map((run: any) => run.workflow_id),
  );
  assert.ok(ownerRunWorkflows.has(ownedByA) && ownerRunWorkflows.has(ownedByB));
  assert.equal(
    (await ok("GET", `/automations/runs/${foreignRun.id}`)).run.id,
    foreignRun.id,
  );
});

test("manual trigger is never broader than visibility", async () => {
  const ownedByA = await ownedEnabledWorkflow(memberA, "Member A triggerable");
  const ownedByB = await ownedEnabledWorkflow(memberB, "Member B triggerable");

  const crossTrigger = await denied(
    "POST",
    `/automations/workflows/${ownedByB}/run`,
    { idempotency_key: "member-a-cross-trigger" },
    memberA,
  );
  assert.equal(
    crossTrigger.statusCode,
    404,
    "a member may not trigger a colleague's workflow",
  );

  // A tenant service-principal workflow is owned by an administrator and executes
  // with the tenant automation identity, so a member may not trigger it.
  await ok("POST", "/automations/service-principal", {
    capabilities: ["webhook.emit"],
  });
  const principalWorkflow = await ownedEnabledWorkflow(
    owner,
    "Service principal workflow",
    "service_principal",
  );
  const memberOnPrincipal = await denied(
    "POST",
    `/automations/workflows/${principalWorkflow}/run`,
    { idempotency_key: "member-on-principal" },
    memberA,
  );
  assert.equal(memberOnPrincipal.statusCode, 404);
  const adminOnMember = await denied(
    "POST",
    `/automations/workflows/${ownedByA}/run`,
    { idempotency_key: "admin-on-member" },
    memberB,
  );
  assert.equal(adminOnMember.statusCode, 404);

  // The owner and an administrator may trigger any enabled workflow in the tenant.
  const asOwner = await ok(
    "POST",
    `/automations/workflows/${principalWorkflow}/run`,
    { idempotency_key: "owner-on-principal" },
  );
  assert.ok(asOwner.run.id);
  const asAdmin = await ok(
    "POST",
    `/automations/workflows/${ownedByA}/run`,
    { idempotency_key: "admin-trigger" },
    admin,
  );
  assert.ok(asAdmin.run.id);
  const adminOnPrincipal = await ok(
    "POST",
    `/automations/workflows/${principalWorkflow}/run`,
    { idempotency_key: "admin-on-principal" },
    admin,
  );
  assert.ok(adminOnPrincipal.run.id);

  // ... and the engine executes the service-principal run under the provisioned
  // identity, with no member able to reach it.
  await ok("POST", "/automations/dev/tick", {});
  const executed = await ok("GET", `/automations/runs/${asOwner.run.id}`);
  assert.equal(executed.run.status, "succeeded");
  const executedRow = await db.tenant(tenant, (q) =>
    one(q, "SELECT authority FROM workflow_runs WHERE tenant_id=$1 AND id=$2", [
      tenant,
      asOwner.run.id,
    ]),
  );
  assert.equal(executedRow.authority.kind, "service_principal");
  // The run executes under the operator-provisioned identity, not under the person
  // who pressed Run.
  const principal = await ok("GET", "/automations/service-principal");
  assert.equal(
    executedRow.authority.user_id,
    principal.service_principal.user_id,
  );

  // Run history stays visible to the owner and to the workflow's own owner.
  assert.equal(
    (await ok("GET", `/automations/runs/${asOwner.run.id}`)).run.id,
    asOwner.run.id,
  );
});

test("cross-tenant reach stays impossible after the visibility rule", async () => {
  const foreignWorkflow = await ownedEnabledWorkflow(
    otherOwner,
    "Other tenant workflow",
  );
  const read = await denied("GET", `/automations/workflows/${foreignWorkflow}`);
  assert.equal(read.statusCode, 404);
  const run = await denied(
    "POST",
    `/automations/workflows/${foreignWorkflow}/run`,
    {},
  );
  assert.equal(run.statusCode, 404);
  const ownList = await ok("GET", "/automations/workflows");
  assert.ok(
    !ownList.workflows.some((workflow: any) => workflow.id === foreignWorkflow),
    "another tenant's workflow never appears",
  );
  assert.equal(
    (await ok("GET", "/connectors/connections", undefined, otherOwner))
      .connections.length,
    2,
    "each tenant sees only its own connections",
  );
  assert.equal(
    (await ok("GET", "/connectors/connections")).connections.length,
    1,
  );
});

test("the routes never reach the deployment-wide aggregates", async () => {
  // A structural check, not a behavioural one: the customer routes must not name
  // the SECURITY DEFINER fleet aggregates, which remain the platform surface used
  // by the token-protected /metrics endpoint.
  const source = await readFile(
    new URL("../apps/api/src/connected-work.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !source.includes("workspace_connector_health"),
    "the connector customer route must not call the deployment-wide aggregate",
  );
  assert.ok(
    !source.includes("workspace_workflow_health"),
    "the workflow customer route must not call the deployment-wide aggregate",
  );
  assert.ok(source.includes("connectorMetricsForTenant"));
  assert.ok(source.includes("workflowMetricsForTenant"));

  // The platform surface keeps them.
  const app = await readFile(
    new URL("../apps/api/src/app.ts", import.meta.url),
    "utf8",
  );
  assert.ok(app.includes("workspace_connector_health"));
  assert.ok(app.includes("workspace_workflow_health"));

  // And the tenant-scoped counters really are computed under RLS: a tenant-less
  // connection sees nothing, while the tenant transaction sees its own rows.
  const systemCount = await db.system((q) =>
    one(q, "SELECT count(*)::int AS c FROM connector_connections"),
  );
  assert.equal(
    systemCount.c,
    0,
    "no tenant context means no rows without the definer function",
  );
  const tenantCount = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM connector_connections WHERE tenant_id=$1",
      [tenant],
    ),
  );
  assert.equal(tenantCount.c, 1);
});
