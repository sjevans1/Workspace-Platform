/**
 * W30-A deterministic workflow runtime acceptance.
 *
 * This is the native, non-journey acceptance for the workflow runtime: the DSL
 * and its hard bounds, determinism, the no-model/no-arbitrary-code posture, the
 * condition operators, timezone and DST schedule semantics, idempotency,
 * retry/dead-letter/restart recovery, revision pinning, authority fail-closed,
 * and retention and limits.
 *
 * The engine is driven through its exported functions with an in-memory
 * ConnectorActionPort, so no provider, network identity or LLM is involved. The
 * HTTP layer is exercised only where the claim is about the API surface. Every
 * assertion records a real observation from the migrated database; where the
 * shipped behaviour disagrees with the intended contract the assertion states
 * what actually happens.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { csrf, type Actor } from "../packages/auth/index.ts";
import {
  RETRY_POLICY,
  SYNTHETIC_PROVIDER_KEY,
  createConnection,
  recordConnectorEvent,
  type NormalizedEvent,
} from "../packages/connectors/index.ts";
import {
  CONDITION_OPERATORS,
  WORKFLOW_LIMITS,
  canonicalDefinition,
  cancelRun,
  createWorkflow,
  definitionDigest,
  disableWorkflow,
  dispatchConnectorEvent,
  enableWorkflow,
  engineTick,
  evaluateCondition,
  evaluateConditions,
  getRunDetail,
  isValidTimezone,
  listRuns,
  nextOccurrence,
  parseCron,
  parseInstant,
  parseWorkflowDefinition,
  planDigest,
  planSteps,
  pruneRuns,
  readPath,
  saveDraft,
  scheduleTick,
  provisionServicePrincipal,
  deprovisionServicePrincipal,
  triggerManualRun,
  type ConditionOperator,
  type ConnectorActionPort,
  type EngineDeps,
  type RunAuthority,
  type WorkflowAction,
  type WorkflowCondition,
} from "../packages/automation/index.ts";

let pg: Awaited<ReturnType<typeof testPostgres>>;
let db: Database;
let app: any;
let httpOwner: { cookie: string; csrf: string };
let httpTenant: string;

before(async () => {
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  process.env.SETUP_TOKEN = "automation-setup-token";
  process.env.COOKIE_SECURE = "false";
  process.env.STORAGE_LOCAL_PATH = await mkdtemp(
    `${tmpdir()}/workspace-automation-`,
  );
  pg = await testPostgres(55448);
  if (!pg.emulated)
    process.env.RUNTIME_DB_PASSWORD = "automation-runtime-password";
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
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    headers: { "x-setup-token": process.env.SETUP_TOKEN },
    payload: {
      organisation: "Automation Co",
      workspace: "HQ",
      name: "Owner",
      email: "automation-owner@example.test",
      password: "test-password-123",
      demo: false,
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"].split(";")[0];
  httpOwner = { cookie, csrf: csrf(cookie.split("=")[1]) };
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: httpOwner.cookie },
  });
  httpTenant = me.json().organisation.id;
});

after(async () => {
  await db?.close();
  await pg?.close();
});

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

function actor(
  tenant: string,
  user_id: string,
  role: Actor["role"],
  name = role,
): Actor {
  return {
    tenant_id: tenant,
    user_id,
    role,
    name,
    email: `${user_id}@example.test`,
    scopes: null,
    expires_at: new Date(Date.now() + 3_600_000),
  };
}

/** A fresh tenant with the requested membership roles, so every test is order-independent. */
async function freshTenantAndActors(
  ...roles: Actor["role"][]
): Promise<{ tenant: string; actors: Actor[] }> {
  const tenant = randomUUID();
  const ids = roles.map(() => randomUUID());
  await db.tenant(tenant, async (q) => {
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      tenant,
      `Automation ${tenant.slice(0, 8)}`,
    ]);
    for (let index = 0; index < roles.length; index++) {
      await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
        ids[index],
        `${ids[index]}@example.test`,
        roles[index],
      ]);
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,$3,true)",
        [tenant, ids[index], roles[index]],
      );
    }
  });
  return {
    tenant,
    actors: roles.map((role, index) => actor(tenant, ids[index], role)),
  };
}

const webhookAction = (
  id: string,
  event_type = "workflow.acceptance",
): WorkflowAction => ({
  id,
  operation: "workspace.webhook.emit",
  config: { event_type },
});

const connectorAction = (
  id: string,
  connection_id: string,
  capability = "message.send",
): WorkflowAction => ({
  id,
  operation: "connector.action.invoke",
  config: {
    connection_id,
    action: "synthetic.record",
    capability,
    payload: { label: id },
  },
});

const delayAction = (id: string, seconds = 60): WorkflowAction => ({
  id,
  operation: "workflow.delay",
  config: { seconds },
});

const manualDefinition = (actions: unknown[], conditions: unknown[] = []) => ({
  schema_version: 1,
  trigger: { id: "manual", type: "manual" },
  conditions,
  actions,
});

const leaf = (
  path: string,
  operator: ConditionOperator,
  value?: unknown,
): WorkflowCondition => ({
  id: `leaf_${path}`,
  kind: "leaf",
  path,
  operator,
  value,
});

const group = (
  kind: "all" | "any",
  conditions: WorkflowCondition[],
  id = `group_${kind}_${conditions.length}`,
): WorkflowCondition => ({ id, kind, conditions });

/** A deterministic in-memory connector port: inspect returns fixed facts, invoke is scripted. */
function stubPort(
  inspect: Awaited<ReturnType<ConnectorActionPort["inspect"]>>,
  invoke: ConnectorActionPort["invoke"] = async () => ({ recorded: true }),
): ConnectorActionPort {
  return { inspect: async () => inspect, invoke };
}

const deps = (
  connectorPort: ConnectorActionPort,
  now?: () => Date,
): EngineDeps => (now ? { connectorPort, now } : { connectorPort });

const tickEngine = (tenant: string, engineDeps: EngineDeps) =>
  db.tenant(tenant, (q) => engineTick(q, tenant, engineDeps));

const forceClaimable = (tenant: string, runId: string) =>
  db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_runs SET next_attempt_at=now(),lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
      [tenant, runId],
    ),
  );

const runRow = (tenant: string, runId: string) =>
  db.tenant(tenant, (q) =>
    one(q, "SELECT * FROM workflow_runs WHERE tenant_id=$1 AND id=$2", [
      tenant,
      runId,
    ]),
  );

const latestActionStep = (tenant: string, runId: string, operation: string) =>
  db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT * FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2 AND step_type='action' AND operation=$3" +
        " ORDER BY attempt DESC LIMIT 1",
      [tenant, runId, operation],
    ),
  );

const outboxCount = async (tenant: string, type: string) =>
  Number(
    (
      await db.tenant(tenant, (q) =>
        one(
          q,
          "SELECT count(*)::int AS c FROM event_outbox WHERE tenant_id=$1 AND type=$2",
          [tenant, type],
        ),
      )
    ).c,
  );

// ---------------------------------------------------------------------------
// 1. DSL validation and bounds.
// ---------------------------------------------------------------------------

test("W30-A DSL: strict parsing rejects unknown operations, types, keys and every exceeded bound", () => {
  const valid = manualDefinition([webhookAction("act")]);
  assert.equal(parseWorkflowDefinition(valid).schema_version, 1);

  const rejects = (definition: unknown, label: string) =>
    assert.throws(
      () => parseWorkflowDefinition(definition),
      (error: any) =>
        error.statusCode === 400 &&
        /Invalid workflow definition|Unknown workflow operation|too large/.test(
          error.message,
        ),
      label,
    );

  rejects(
    manualDefinition([{ id: "x", operation: "does.not.exist", config: {} }]),
    "an unknown action operation must be rejected",
  );
  rejects(
    {
      schema_version: 1,
      trigger: { id: "t", type: "webhook" },
      conditions: [],
      actions: [webhookAction("a")],
    },
    "an unknown trigger type must be rejected",
  );

  // Strict everywhere: an unknown key on the definition, the trigger, a leaf and an action.
  rejects(
    { ...valid, extra: true },
    "an unknown top-level key must be rejected",
  );
  rejects(
    { ...valid, trigger: { id: "manual", type: "manual", extra: 1 } },
    "an unknown trigger key must be rejected",
  );
  rejects(
    manualDefinition(
      [webhookAction("a")],
      [
        {
          id: "c",
          kind: "leaf",
          path: "trigger.payload.x",
          operator: "equals",
          value: 1,
          extra: 1,
        },
      ],
    ),
    "an unknown condition key must be rejected",
  );
  rejects(
    manualDefinition([{ ...webhookAction("a"), extra: 1 }]),
    "an unknown action key must be rejected",
  );

  // Bounds: max_actions, max_conditions, max_condition_depth, max_definition_bytes.
  const tooManyActions = manualDefinition(
    Array.from({ length: WORKFLOW_LIMITS.max_actions + 1 }, (_, i) =>
      webhookAction(`a${i}`),
    ),
  );
  rejects(
    tooManyActions,
    `${WORKFLOW_LIMITS.max_actions + 1} actions must exceed max_actions`,
  );

  const tooManyConditions = manualDefinition(
    [webhookAction("a")],
    Array.from({ length: WORKFLOW_LIMITS.max_conditions + 1 }, (_, i) =>
      leaf(`p${i}`, "empty"),
    ),
  );
  rejects(
    tooManyConditions,
    `${WORKFLOW_LIMITS.max_conditions + 1} conditions must exceed max_conditions`,
  );

  const tooDeep = manualDefinition(
    [webhookAction("a")],
    [group("all", [group("all", [group("all", [leaf("p", "empty")])])])],
  );
  rejects(tooDeep, "nesting deeper than max_condition_depth must be rejected");

  const oversized = manualDefinition(
    [webhookAction("a")],
    [
      leaf(
        "trigger.payload.big",
        "equals",
        "x".repeat(WORKFLOW_LIMITS.max_definition_bytes + 8),
      ),
    ],
  );
  rejects(
    oversized,
    "a definition larger than max_definition_bytes must be rejected",
  );

  // The workspace event vocabulary is a real allowlist, not free text.
  rejects(
    {
      schema_version: 1,
      trigger: {
        id: "w",
        type: "workspace_event",
        event_types: ["resource.created"],
      },
      conditions: [],
      actions: [webhookAction("a")],
    },
    "an event type the product never emits must be rejected",
  );
  rejects(
    {
      schema_version: 1,
      trigger: {
        id: "w",
        type: "workspace_event",
        event_types: ["workflow.*"],
      },
      conditions: [],
      actions: [webhookAction("a")],
    },
    "the workflow.* namespace must be unreachable from a workspace event trigger",
  );
  const family = parseWorkflowDefinition({
    schema_version: 1,
    trigger: { id: "w", type: "workspace_event", event_types: ["comment.*"] },
    conditions: [],
    actions: [webhookAction("a")],
  });
  assert.deepEqual((family.trigger as any).event_types, ["comment.*"]);
});

test("W30-A DSL: a valid definition round-trips and canonical form and digest are stable", () => {
  const parsed = parseWorkflowDefinition(
    manualDefinition(
      [webhookAction("act", "workflow.one")],
      [leaf("trigger.payload.priority", "equals", "high")],
    ),
  );
  assert.deepEqual(
    parseWorkflowDefinition(parsed),
    parsed,
    "the parsed form must be a fixed point",
  );

  const canonical = canonicalDefinition(parsed);
  assert.equal(
    canonicalDefinition(parsed),
    canonical,
    "canonical JSON is stable",
  );
  assert.equal(canonicalDefinition(parseWorkflowDefinition(parsed)), canonical);
  assert.equal(definitionDigest(parsed), definitionDigest(parsed));
  assert.match(definitionDigest(parsed), /^[a-f0-9]{64}$/);

  const reordered = parseWorkflowDefinition({
    actions: [webhookAction("act", "workflow.one")],
    conditions: [leaf("trigger.payload.priority", "equals", "high")],
    trigger: { type: "manual", id: "manual" },
    schema_version: 1,
  });
  assert.equal(
    canonicalDefinition(reordered),
    canonical,
    "key order must not change the digest",
  );
});

// ---------------------------------------------------------------------------
// 2. Determinism.
// ---------------------------------------------------------------------------

test("W30-A determinism: the plan is byte-identical and survives a revision read-back", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const definition = manualDefinition(
    [webhookAction("act", "workflow.one")],
    [leaf("trigger.payload.priority", "equals", "high")],
  );
  const result = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, { name: "Deterministic", definition }),
  );
  const workflowId = result.workflow.id;

  const first = planSteps(result.definition);
  assert.equal(
    JSON.stringify(planSteps(result.definition)),
    JSON.stringify(first),
  );
  assert.deepEqual(planSteps(result.definition), first);
  assert.equal(planDigest(planSteps(result.definition)), planDigest(first));

  // Read the SAME revision back from the database and compile it again.
  const revision = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT definition FROM workflow_revisions WHERE tenant_id=$1 AND workflow_id=$2 AND revision=1",
      [tenant, workflowId],
    ),
  );
  const readBack = planSteps(parseWorkflowDefinition(revision.definition));
  assert.deepEqual(
    readBack,
    first,
    "the same (revision, trigger, state) plans the same sequence",
  );
  assert.equal(
    JSON.stringify(readBack),
    JSON.stringify(first),
    "the plan is byte-identical",
  );
});

// ---------------------------------------------------------------------------
// 3. No model, no arbitrary code.
// ---------------------------------------------------------------------------

test("W30-A posture: the automation package has no model call, no eval, no shell and no third-party import", () => {
  const directory = fileURLToPath(
    new URL("../packages/automation", import.meta.url),
  );
  const files = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  assert.ok(
    files.length >= 6,
    `expected the package sources, found ${files.join(", ")}`,
  );

  const forbidden = /eval\(|new Function|child_process/;
  const httpOrModel =
    /(?:^|\/)(?:http|https|net|tls|dgram|child_process)$|openai|anthropic|axios|node-fetch|got|undici|langchain|cohere|mistral/i;

  for (const name of files) {
    const source = readFileSync(`${directory}/${name}`, "utf8");
    assert.equal(
      forbidden.test(source),
      false,
      `${name} must not contain eval/new Function/shell`,
    );

    const specifiers = [
      ...source.matchAll(/(?:^|[^\w])(?:from|import)\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.equal(
        httpOrModel.test(specifier),
        false,
        `${name} must not import an HTTP or model client (${specifier})`,
      );
      const allowed =
        specifier.startsWith("node:") ||
        specifier === "zod" ||
        specifier.startsWith("./") ||
        specifier.startsWith("../");
      assert.equal(
        allowed,
        true,
        `${name} imports a dependency outside node:/zod/repository (${specifier})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Conditions.
// ---------------------------------------------------------------------------

test("W30-A conditions: every operator, missing paths, groups and numeric/date comparison", () => {
  const context = {
    value: "hello",
    number: 5,
    flag: true,
    date: "2026-01-02T00:00:00Z",
    blank: "",
  };

  const cases: [ConditionOperator, string, unknown, boolean][] = [
    ["equals", "value", "hello", true],
    ["equals", "value", "world", false],
    ["not_equals", "value", "world", true],
    ["not_equals", "value", "hello", false],
    ["contains", "value", "ell", true],
    ["contains", "value", "zzz", false],
    ["starts_with", "value", "he", true],
    ["starts_with", "value", "lo", false],
    ["gt", "number", 3, true],
    ["gt", "number", 9, false],
    ["gte", "number", 5, true],
    ["gte", "number", 6, false],
    ["lt", "number", 9, true],
    ["lt", "number", 3, false],
    ["lte", "number", 5, true],
    ["lte", "number", 4, false],
    ["empty", "blank", undefined, true],
    ["empty", "value", undefined, false],
    ["not_empty", "value", undefined, true],
    ["not_empty", "blank", undefined, false],
    ["boolean", "flag", true, true],
    ["boolean", "flag", false, false],
    // ISO-date comparison: strings are parsed as dates when both sides parse.
    ["gt", "date", "2026-01-01T00:00:00Z", true],
    ["gt", "date", "2026-01-03T00:00:00Z", false],
    ["lt", "date", "2026-01-03T00:00:00Z", true],
    ["gte", "date", "2026-01-02T00:00:00Z", true],
  ];
  for (const [operator, path, value, expected] of cases)
    assert.equal(
      evaluateCondition(leaf(path, operator, value), context),
      expected,
      `${operator}(${path})`,
    );

  // A missing path is empty-true and false for every other operator.
  assert.equal(evaluateCondition(leaf("missing.path", "empty"), context), true);
  assert.equal(readPath("missing.path", context), undefined);
  for (const operator of CONDITION_OPERATORS) {
    if (operator === "empty") continue;
    assert.equal(
      evaluateCondition(leaf("missing.path", operator, "x"), context),
      false,
      `a missing path must be false for ${operator}`,
    );
  }

  // Groups: all = AND, any = OR, an empty group is true.
  assert.equal(
    evaluateCondition(
      group("all", [
        leaf("value", "equals", "hello"),
        leaf("flag", "boolean", true),
      ]),
      context,
    ),
    true,
  );
  assert.equal(
    evaluateCondition(
      group("all", [
        leaf("value", "equals", "hello"),
        leaf("flag", "boolean", false),
      ]),
      context,
    ),
    false,
  );
  assert.equal(
    evaluateCondition(
      group("any", [leaf("value", "equals", "world"), leaf("number", "gt", 1)]),
      context,
    ),
    true,
  );
  assert.equal(
    evaluateCondition(
      group("any", [
        leaf("value", "equals", "world"),
        leaf("number", "gt", 99),
      ]),
      context,
    ),
    false,
  );
  assert.equal(evaluateCondition(group("all", []), context), true);
  assert.equal(evaluateCondition(group("any", []), context), true);
  // Nested groups.
  assert.equal(
    evaluateCondition(
      group("any", [
        group("all", [
          leaf("value", "equals", "hello"),
          leaf("number", "gt", 1),
        ]),
        leaf("value", "equals", "world"),
      ]),
      context,
    ),
    true,
  );
  assert.equal(
    evaluateCondition(
      group("all", [
        group("any", [leaf("value", "equals", "world")]),
        leaf("flag", "boolean", true),
      ]),
      context,
    ),
    false,
  );

  const gate = evaluateConditions(
    [leaf("value", "equals", "hello"), leaf("number", "gt", 1)],
    context,
  );
  assert.equal(gate.passed, true);
  assert.equal(gate.evaluated.length, 2);
  assert.ok(
    gate.evaluated.every(
      (entry) => typeof entry.reason === "string" && entry.reason.length > 0,
    ),
  );
  assert.equal(
    evaluateConditions([leaf("value", "equals", "world")], context).passed,
    false,
  );
});

// ---------------------------------------------------------------------------
// 5. Schedule semantics.
// ---------------------------------------------------------------------------

test("W30-A schedule: cron parsing, one_time, interval bases and DST resolution", () => {
  // parseCron accepts and rejects validly.
  assert.ok(parseCron("*/5 * * * *"));
  assert.ok(parseCron("0 9 * * 1-5"));
  assert.deepEqual(parseCron("0 9 * * 1-5")!.minute, [0]);
  assert.deepEqual(parseCron("0 9 * * 1-5")!.dow, [1, 2, 3, 4, 5]);
  assert.equal(parseCron("not a cron"), null);
  assert.equal(parseCron("60 * * * *"), null, "minute 60 is out of range");
  assert.equal(parseCron("* * * *"), null, "four fields is not a cron");
  assert.equal(parseCron("* * * * * *"), null, "six fields is not a cron");

  assert.equal(isValidTimezone("America/New_York"), true);
  assert.equal(isValidTimezone("Not/AZone"), false);

  // one_time fires once, then null.
  const once = {
    kind: "one_time" as const,
    at: "2026-01-01T00:00:00Z",
    timezone: "UTC",
    missed_policy: "skip" as const,
  };
  assert.equal(
    nextOccurrence({
      ...once,
      after: new Date("2025-12-31T00:00:00Z"),
    })!.toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(
    nextOccurrence({ ...once, after: new Date("2026-01-01T00:00:00Z") }),
    null,
  );
  assert.equal(
    nextOccurrence({ ...once, after: new Date("2026-06-01T00:00:00Z") }),
    null,
  );

  // interval advances by exactly its interval from the declared base.
  const base = "2026-01-01T00:00:00Z";
  const interval = {
    kind: "interval" as const,
    at: base,
    every_seconds: 600,
    timezone: "UTC",
    missed_policy: "skip" as const,
    from: null,
  };
  assert.equal(
    nextOccurrence({
      ...interval,
      after: new Date("2025-12-31T23:00:00Z"),
    })!.toISOString(),
    "2026-01-01T00:10:00.000Z",
  );

  // missed_policy 'skip' advances past every missed occurrence.
  const anchorStart = new Date("2026-01-01T00:00:00Z");
  const skipped = nextOccurrence({
    kind: "interval",
    at: base,
    every_seconds: 60,
    timezone: "UTC",
    missed_policy: "skip",
    after: new Date(anchorStart.getTime() + 330_000),
    from: anchorStart,
  });
  assert.equal(skipped!.getTime(), anchorStart.getTime() + 360_000);
  assert.ok(skipped!.getTime() > anchorStart.getTime() + 330_000);

  // missed_policy 'catch_up_once' returns at most one, the oldest missed occurrence.
  const firstCatchUp = nextOccurrence({
    kind: "interval",
    at: base,
    every_seconds: 60,
    timezone: "UTC",
    missed_policy: "catch_up_once",
    after: new Date(anchorStart.getTime() + 330_000),
    from: anchorStart,
  });
  assert.equal(firstCatchUp!.getTime(), anchorStart.getTime() + 60_000);
  const secondCatchUp = nextOccurrence({
    kind: "interval",
    at: base,
    every_seconds: 60,
    timezone: "UTC",
    missed_policy: "catch_up_once",
    after: new Date(anchorStart.getTime() + 330_000),
    from: firstCatchUp,
  });
  assert.equal(secondCatchUp!.getTime(), anchorStart.getTime() + 120_000);

  // DST spring forward: a non-existent local time resolves to the first instant that exists.
  assert.equal(
    parseInstant("2026-03-08T02:30", "America/New_York")!.toISOString(),
    "2026-03-08T07:00:00.000Z",
  );
  const springCron = nextOccurrence({
    kind: "cron",
    expression: "30 2 8 3 *",
    timezone: "America/New_York",
    missed_policy: "skip",
    after: new Date("2026-03-01T00:00:00Z"),
  });
  assert.equal(springCron!.toISOString(), "2026-03-08T07:00:00.000Z");

  // DST fall back: an ambiguous local time resolves to the earlier UTC instant.
  assert.equal(
    parseInstant("2026-11-01T01:30", "America/New_York")!.toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  const fallCron = nextOccurrence({
    kind: "cron",
    expression: "30 1 1 11 *",
    timezone: "America/New_York",
    missed_policy: "skip",
    after: new Date("2026-10-25T00:00:00Z"),
  });
  assert.equal(fallCron!.toISOString(), "2026-11-01T05:30:00.000Z");

  // Repeated calls are identical.
  const reference = new Date("2026-06-01T00:00:00Z");
  const stable = {
    kind: "cron" as const,
    expression: "0 9 * * *",
    timezone: "America/New_York",
    missed_policy: "skip" as const,
    after: reference,
  };
  const first = nextOccurrence(stable)!;
  assert.equal(nextOccurrence(stable)!.getTime(), first.getTime());

  // A schedule declared in another zone is never resolved to a UTC-only instant.
  assert.notEqual(first.toISOString(), "2026-06-01T09:00:00.000Z");
  assert.equal(first.toISOString(), "2026-06-01T13:00:00.000Z");
  const newYorkHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(first),
  );
  assert.equal(
    newYorkHour,
    9,
    "the resolved instant reads 09:00 in the declared zone",
  );
});

// ---------------------------------------------------------------------------
// 6. Idempotency.
// ---------------------------------------------------------------------------

test("W30-A idempotency: duplicate connector events, repeated manual keys, retry and schedule fan-out give one run", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];

  // Two identical connector deliveries (same dedupe key) are one event and one run.
  const connection = await db.tenant(tenant, (q) =>
    createConnection(q, owner, {
      provider_key: SYNTHETIC_PROVIDER_KEY,
      label: "Idempotency",
      ownership: "user",
    }),
  );
  const event: NormalizedEvent = {
    event_type: "synthetic.tick",
    provider_event_id: "pe-1",
    dedupe_key: "dedupe-1",
    occurred_at: null,
    resource_refs: [],
    payload_ref: { priority: "high" },
  };
  const record = () =>
    db.tenant(tenant, (q) =>
      recordConnectorEvent(
        q,
        tenant,
        connection.id,
        SYNTHETIC_PROVIDER_KEY,
        event,
        "verified",
      ),
    );
  assert.equal((await record()).inserted, true);
  assert.equal((await record()).inserted, false);
  const eventRows = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM connector_events WHERE tenant_id=$1",
      [tenant],
    ),
  );
  assert.equal(
    eventRows.c,
    1,
    "a duplicate delivery must not create a second event",
  );

  const connectorWorkflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "On connector event",
      definition: {
        schema_version: 1,
        trigger: {
          id: "evt",
          type: "connector_event",
          event_types: ["synthetic.tick"],
        },
        conditions: [],
        actions: [webhookAction("act")],
      },
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, connectorWorkflow.workflow.id),
  );
  const dispatched = await db.tenant(tenant, (q) =>
    dispatchConnectorEvent(q, tenant, deps(stubPort(null))),
  );
  assert.equal(
    dispatched.runs.length,
    1,
    "one logical event maps to exactly one run",
  );
  const runs = await db.tenant(tenant, (q) =>
    listRuns(q, owner, { workflow_id: connectorWorkflow.workflow.id }),
  );
  assert.equal(runs.length, 1);

  // The same manual idempotency key returns the SAME run rather than an error.
  const manualWorkflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Manual",
      definition: manualDefinition([webhookAction("act")]),
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, manualWorkflow.workflow.id),
  );
  const manualA = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, manualWorkflow.workflow.id, {
      idempotency_key: "manual-dup",
    }),
  );
  const manualB = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, manualWorkflow.workflow.id, {
      idempotency_key: "manual-dup",
    }),
  );
  assert.equal(
    manualA.id,
    manualB.id,
    "a repeated manual key must return the original run",
  );
  const manualRuns = await db.tenant(tenant, (q) =>
    listRuns(q, owner, { workflow_id: manualWorkflow.workflow.id }),
  );
  assert.equal(manualRuns.length, 1);

  // A schedule fan-out at the same instant produces one run.
  const future = "2030-01-01T00:00:00Z";
  const scheduled = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "One time",
      definition: {
        schema_version: 1,
        trigger: {
          id: "sched",
          type: "schedule",
          kind: "one_time",
          at: future,
          timezone: "UTC",
          missed_policy: "skip",
        },
        conditions: [],
        actions: [webhookAction("act")],
      },
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, scheduled.workflow.id),
  );
  const instant = new Date(Date.now() - 60_000);
  const forceDue = () =>
    db.tenant(tenant, (q) =>
      q.query(
        "UPDATE workflow_schedule_state SET next_at=$2 WHERE tenant_id=$1 AND workflow_id=$3",
        [tenant, instant, scheduled.workflow.id],
      ),
    );
  await forceDue();
  const scheduleDeps = deps(stubPort(null), () => instant);
  const fireOne = await db.tenant(tenant, (q) =>
    scheduleTick(q, tenant, scheduleDeps),
  );
  assert.equal(fireOne.fired, 1);
  await forceDue();
  const fireTwo = await db.tenant(tenant, (q) =>
    scheduleTick(q, tenant, scheduleDeps),
  );
  assert.equal(
    fireTwo.fired,
    0,
    "a second fan-out at the same instant is a duplicate",
  );
  const scheduleRuns = await db.tenant(tenant, (q) =>
    listRuns(q, owner, { workflow_id: scheduled.workflow.id }),
  );
  assert.equal(scheduleRuns.length, 1);
  assert.equal(scheduleRuns[0].trigger_type, "schedule");
});

// ---------------------------------------------------------------------------
// 7. Failure, retry, restart, delay and cancellation.
// ---------------------------------------------------------------------------

test("W30-A recovery: retryable backoff, dead letter, restart persistence, delay waiting and cancel", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const transient = stubPort(
    {
      exists: true,
      enabled: true,
      status: "connected",
      ownership: "tenant",
      owner_user_id: null,
      capabilities_granted: ["message.send"],
      provider_key: SYNTHETIC_PROVIDER_KEY,
    },
    async () => {
      throw new Error("upstream transient failure");
    },
  );

  // A retryable failure leaves the step failed with the category, persists the
  // attempt, and leaves the run queued with a bounded backoff.
  const workflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Retry",
      definition: manualDefinition([
        webhookAction("first", "workflow.first"),
        connectorAction("call", randomUUID()),
      ]),
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, workflow.workflow.id),
  );
  const run = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, workflow.workflow.id, {}),
  );

  const tickOne = await tickEngine(tenant, deps(transient));
  assert.equal(tickOne.claimed, 1);
  const afterFirst = await runRow(tenant, run.id);
  assert.equal(
    afterFirst.status,
    "queued",
    "a retryable failure re-queues the run",
  );
  assert.equal(afterFirst.error_category, "transient");
  const stepOne = await latestActionStep(
    tenant,
    run.id,
    "connector.action.invoke",
  );
  assert.equal(stepOne.operation, "connector.action.invoke");
  assert.equal(stepOne.status, "failed");
  assert.equal(stepOne.error_category, "transient");
  assert.equal(stepOne.attempt, 1);
  const backoffMs = new Date(afterFirst.next_attempt_at).getTime() - Date.now();
  assert.ok(backoffMs > 0, "the retry is scheduled in the future");
  assert.ok(
    backoffMs <= RETRY_POLICY.cap_seconds * 1000 + 5000,
    "the backoff is bounded by the retry policy cap",
  );

  // Worker restart: clearing the lease and re-ticking never re-executes the
  // durably succeeded action and never resets the persisted attempt count.
  await forceClaimable(tenant, run.id);
  const tickTwo = await tickEngine(tenant, deps(transient));
  assert.equal(tickTwo.claimed, 1);
  assert.equal(
    await outboxCount(tenant, "workflow.first"),
    1,
    "a completed action must not repeat",
  );
  const stepTwo = await latestActionStep(
    tenant,
    run.id,
    "connector.action.invoke",
  );
  assert.equal(
    stepTwo.attempt,
    2,
    "the persisted attempt count continues, it does not reset",
  );
  assert.equal(stepTwo.status, "failed");

  // Exhausting RETRY_POLICY.max_attempts moves the step and run to dead_letter.
  for (let attempt = 3; attempt <= RETRY_POLICY.max_attempts; attempt++) {
    await forceClaimable(tenant, run.id);
    await tickEngine(tenant, deps(transient));
    const step = await latestActionStep(
      tenant,
      run.id,
      "connector.action.invoke",
    );
    assert.equal(step.attempt, attempt);
  }
  const exhaustedRun = await runRow(tenant, run.id);
  const exhaustedStep = await latestActionStep(
    tenant,
    run.id,
    "connector.action.invoke",
  );
  assert.equal(exhaustedRun.status, "dead_letter");
  assert.equal(exhaustedStep.status, "dead_letter");
  assert.equal(exhaustedStep.attempt, RETRY_POLICY.max_attempts);
  assert.equal(await outboxCount(tenant, "workflow.first"), 1);

  // A non-retryable failure fails the run immediately.
  const denied = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Denied",
      definition: manualDefinition([connectorAction("call", randomUUID())]),
    }),
  );
  await db.tenant(tenant, (q) => enableWorkflow(q, owner, denied.workflow.id));
  const deniedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, denied.workflow.id, {}),
  );
  await tickEngine(tenant, deps(stubPort(null)));
  const deniedRow = await runRow(tenant, deniedRun.id);
  assert.equal(deniedRow.status, "failed");
  assert.equal(deniedRow.error_category, "capability_missing");
  const deniedStep = await latestActionStep(
    tenant,
    deniedRun.id,
    "connector.action.invoke",
  );
  assert.equal(deniedStep.status, "failed");
  assert.equal(deniedStep.attempt, 1, "a non-retryable failure is not retried");
  const deniedAttempts = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2 AND step_type='action'",
      [tenant, deniedRun.id],
    ),
  );
  assert.equal(deniedAttempts.c, 1);

  // workflow.delay puts the run in waiting. A step that asked to wait COMPLETES on
  // the first tick at or after its own deadline; without that the wait would re-arm
  // forever and the later action could never run.
  const delayed = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Delay",
      definition: manualDefinition([
        delayAction("wait", 60),
        webhookAction("after"),
      ]),
    }),
  );
  await db.tenant(tenant, (q) => enableWorkflow(q, owner, delayed.workflow.id));
  const delayedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, delayed.workflow.id, {}),
  );
  await tickEngine(tenant, deps(stubPort(null)));
  const waitingRow = await runRow(tenant, delayedRun.id);
  assert.equal(waitingRow.status, "waiting");
  const waitingStep = await latestActionStep(
    tenant,
    delayedRun.id,
    "workflow.delay",
  );
  assert.equal(waitingStep.status, "waiting");
  assert.equal(waitingStep.operation, "workflow.delay");

  // Before the deadline the wait is honoured: a tick changes nothing.
  await forceClaimable(tenant, delayedRun.id);
  const early = await db.tenant(tenant, (q) => {
    const before = q.query(
      "SELECT count(*)::int AS c FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2",
      [tenant, delayedRun.id],
    );
    return before;
  });
  await tickEngine(tenant, deps(stubPort(null)));
  assert.equal((await runRow(tenant, delayedRun.id)).status, "waiting");
  assert.equal(
    (
      await db.tenant(tenant, (q) =>
        one(
          q,
          "SELECT count(*)::int AS c FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2",
          [tenant, delayedRun.id],
        ),
      )
    ).c,
    early.rows[0].c,
    "a wait that has not elapsed adds no step attempt",
  );

  // Once the deadline passes the SAME step completes and the run finishes.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_run_steps SET retry_state=jsonb_set(retry_state,'{waiting_until}','\"2000-01-01T00:00:00.000Z\"')" +
        " WHERE tenant_id=$1 AND run_id=$2 AND step_type='action'",
      [tenant, delayedRun.id],
    ),
  );
  await forceClaimable(tenant, delayedRun.id);
  await tickEngine(tenant, deps(stubPort(null)));
  const finished = await runRow(tenant, delayedRun.id);
  assert.equal(
    finished.status,
    "succeeded",
    "the run finishes after its wait elapses",
  );
  const delayStep = await latestActionStep(
    tenant,
    delayedRun.id,
    "workflow.delay",
  );
  assert.equal(delayStep.status, "succeeded");
  assert.equal(
    delayStep.attempt,
    waitingStep.attempt,
    "the wait is completed, not retried",
  );
  const afterStep = await latestActionStep(
    tenant,
    delayedRun.id,
    "workspace.webhook.emit",
  );
  assert.equal(afterStep.status, "succeeded", "the step after the wait runs");
  const attempts = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT max(attempt)::int AS max_attempt FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2 AND operation='workflow.delay'",
      [tenant, delayedRun.id],
    ),
  );
  assert.equal(
    attempts.max_attempt,
    1,
    "the delay step was attempted exactly once",
  );

  // cancelRun marks a run cancelled and a cancelled run is never claimed again.
  const cancellable = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Cancel",
      definition: manualDefinition([webhookAction("act")]),
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, cancellable.workflow.id),
  );
  const cancellableRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, cancellable.workflow.id, {}),
  );
  const cancelled = await db.tenant(tenant, (q) =>
    cancelRun(q, owner, cancellableRun.id),
  );
  assert.equal(cancelled.status, "cancelled");
  const tickAfterCancel = await tickEngine(tenant, deps(stubPort(null)));
  assert.equal(
    tickAfterCancel.claimed,
    0,
    "a cancelled run must not be claimed",
  );
  assert.equal((await runRow(tenant, cancellableRun.id)).status, "cancelled");
});

// ---------------------------------------------------------------------------
// 8. Revision pinning.
// ---------------------------------------------------------------------------

test("W30-A pinning: editing a draft after a run started never changes the running revision", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const first = manualDefinition([
    webhookAction("act", "workflow.first_revision"),
  ]);
  const created = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, { name: "Pinned", definition: first }),
  );
  const workflowId = created.workflow.id;
  const enabled = await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, workflowId),
  );
  const pinned = enabled.published_revision;
  assert.equal(pinned, 1);

  const run = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, workflowId, {}),
  );
  assert.equal(run.revision, pinned);

  // Edit the draft: this appends revision 2 but must not repin the open run.
  const edited = manualDefinition([
    webhookAction("act", "workflow.second_revision"),
  ]);
  const saved = await db.tenant(tenant, (q) =>
    saveDraft(q, owner, workflowId, { definition: edited }),
  );
  const draftRow = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT current_draft_revision,published_revision FROM workflow_definitions WHERE tenant_id=$1 AND id=$2",
      [tenant, workflowId],
    ),
  );
  assert.equal(
    draftRow.current_draft_revision,
    2,
    "editing appends a new revision",
  );
  assert.equal(
    draftRow.published_revision,
    pinned,
    "the published revision is unchanged",
  );
  assert.deepEqual(
    parseWorkflowDefinition(saved.draft_definition),
    parseWorkflowDefinition(edited),
  );

  await tickEngine(tenant, deps(stubPort(null)));
  assert.equal(await outboxCount(tenant, "workflow.first_revision"), 1);
  assert.equal(await outboxCount(tenant, "workflow.second_revision"), 0);

  const liveRun = await runRow(tenant, run.id);
  assert.equal(liveRun.status, "succeeded");
  assert.equal(liveRun.revision, pinned);
  const pinnedRow = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT definition,digest FROM workflow_revisions WHERE tenant_id=$1 AND workflow_id=$2 AND revision=$3",
      [tenant, workflowId, liveRun.revision],
    ),
  );
  assert.deepEqual(
    parseWorkflowDefinition(pinnedRow.definition),
    parseWorkflowDefinition(first),
    "the run's revision still resolves to the original revision row",
  );
  assert.equal(
    pinnedRow.digest,
    definitionDigest(parseWorkflowDefinition(first)),
  );

  // workflow_revisions is append-only at the database layer.
  const refused = await db
    .tenant(tenant, (q) =>
      q.query("UPDATE workflow_revisions SET digest=$2 WHERE workflow_id=$1", [
        workflowId,
        "0".repeat(64),
      ]),
    )
    .then(() => null)
    .catch((error: Error) => error);
  assert.ok(
    refused instanceof Error,
    "a published revision must not be updatable",
  );
  assert.match(refused!.message, /immutable|permission denied/i);
});

// ---------------------------------------------------------------------------
// 9. Authority.
// ---------------------------------------------------------------------------

test("W30-A authority: a revoked membership fails closed before any step executes", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner", "admin");
  const [owner, admin] = actors;
  const workflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, admin, {
      name: "Authority",
      definition: manualDefinition([webhookAction("act")]),
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, admin, workflow.workflow.id),
  );
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
      [tenant, admin.user_id],
    ),
  );
  const run = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, workflow.workflow.id, {}),
  );
  await tickEngine(tenant, deps(stubPort(null)));
  const detail = await db.tenant(tenant, (q) => getRunDetail(q, owner, run.id));
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.run.error_category, "authorization_revoked");
  assert.equal(
    detail.steps.length,
    0,
    "no step may execute once authority is gone",
  );
  assert.equal(await outboxCount(tenant, "workflow.acceptance"), 0);
});

test("W30-A authority: a service principal is bounded by the operator allowlist and delegated runs respect reach", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner", "member");
  const [owner, member] = actors;

  const shared = stubPort({
    exists: true,
    enabled: true,
    status: "connected",
    ownership: "tenant",
    owner_user_id: null,
    capabilities_granted: ["message.send"],
    provider_key: SYNTHETIC_PROVIDER_KEY,
  });

  const insertServiceWorkflow = async (name: string) => {
    const id = randomUUID();
    const definition = parseWorkflowDefinition(
      manualDefinition([connectorAction("call", randomUUID())]),
    );
    await db.tenant(tenant, async (q) => {
      await q.query(
        "INSERT INTO workflow_definitions(id,tenant_id,name,description,status,owner_user_id,authority," +
          " current_draft_revision,published_revision,created_by)" +
          " VALUES($1,$2,$3,'','enabled',$4,'service_principal',1,1,$4)",
        [id, tenant, name, owner.user_id],
      );
      // The revision deliberately names the OWNER as its authority user. The engine
      // must ignore that and use the operator-provisioned identity instead, or a
      // workflow author could nominate any user (including an owner) as its own
      // execution authority.
      await q.query(
        "INSERT INTO workflow_revisions(tenant_id,workflow_id,revision,schema_version,definition,digest," +
          " authority,authority_user_id,created_by) VALUES($1,$2,1,1,$3,$4,'service_principal',$5,$6)",
        [
          tenant,
          id,
          JSON.stringify(definition),
          definitionDigest(definition),
          owner.user_id,
          owner.user_id,
        ],
      );
    });
    return id;
  };

  // Provision the identity with a capability that does NOT cover the action this
  // workflow calls. This is the privilege boundary: it must fail closed, and the
  // connector must never be touched.
  const narrow = await db.tenant(tenant, (q) =>
    provisionServicePrincipal(q, owner, {
      capabilities: ["notification.create"],
    }),
  );
  assert.deepEqual(narrow.capabilities, ["notification.create"]);
  assert.equal(narrow.configured, true);

  let invocations = 0;
  const countingPort = stubPort(await shared.inspect({} as any), async () => {
    invocations += 1;
    return { recorded: true };
  });

  const denied = await insertServiceWorkflow("Outside the allowlist");
  const deniedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, denied, { idempotency_key: "denied-run" }),
  );
  await tickEngine(tenant, deps(countingPort));
  const deniedRow = await runRow(tenant, deniedRun.id);
  assert.equal(deniedRow.status, "failed");
  assert.equal(deniedRow.error_category, "authorization_revoked");
  assert.equal(
    invocations,
    0,
    "an unlisted action must never reach the connector",
  );

  // Widening the allowlist lets the same workflow run, and the run records exactly
  // the provisioned capability and the provisioned identity, not the nominated one.
  const wide = await db.tenant(tenant, (q) =>
    provisionServicePrincipal(q, owner, { capabilities: ["connector.action"] }),
  );
  assert.equal(wide.configured, true);
  assert.notEqual(wide.user_id, owner.user_id);
  const allowed = await insertServiceWorkflow("Inside the allowlist");
  const allowedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, allowed, { idempotency_key: "allowed-run" }),
  );
  await tickEngine(tenant, deps(countingPort));
  const allowedRow = await runRow(tenant, allowedRun.id);
  assert.equal(allowedRow.status, "succeeded");
  const runAuthority = allowedRow.authority as RunAuthority;
  assert.equal(runAuthority.kind, "service_principal");
  assert.equal(runAuthority.user_id, wide.user_id);
  assert.deepEqual(runAuthority.capabilities, ["connector.action"]);
  assert.equal(invocations, 1);

  // Removing the allowlist stops the workflow entirely: no provisioned identity, no run.
  await db.tenant(tenant, (q) => deprovisionServicePrincipal(q, owner));
  const orphaned = await insertServiceWorkflow("After deprovisioning");
  const orphanedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, orphaned, { idempotency_key: "orphaned-run" }),
  );
  await tickEngine(tenant, deps(countingPort));
  const orphanedRow = await runRow(tenant, orphanedRun.id);
  assert.equal(orphanedRow.status, "failed");
  assert.equal(orphanedRow.error_category, "authorization_revoked");
  assert.equal(
    invocations,
    1,
    "a deprovisioned identity must not reach the connector",
  );

  // Only an administrator may provision or use the authority.
  await assert.rejects(
    db.tenant(tenant, (q) =>
      provisionServicePrincipal(q, member, {
        capabilities: ["connector.action"],
      }),
    ),
    (error: any) => error.statusCode === 403,
  );
  await assert.rejects(
    db.tenant(tenant, (q) =>
      createWorkflow(q, member, {
        name: "Member service workflow",
        definition: manualDefinition([connectorAction("call", randomUUID())]),
        authority: "service_principal",
      }),
    ),
    (error: any) => error.statusCode === 403,
  );
  await assert.rejects(
    db.tenant(tenant, (q) =>
      provisionServicePrincipal(q, owner, {
        capabilities: ["invented.capability"],
      }),
    ),
    (error: any) => error.statusCode === 400,
  );

  // A delegated run may act on a delegated connection it owns, but not on another
  // user's connection, and a plain member may not reach a shared connection.
  const delegated = await db.tenant(tenant, (q) =>
    createWorkflow(q, member, {
      name: "Delegated",
      definition: manualDefinition([connectorAction("call", randomUUID())]),
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, member, delegated.workflow.id),
  );

  const ownedPort = stubPort({
    exists: true,
    enabled: true,
    status: "connected",
    ownership: "user",
    owner_user_id: member.user_id,
    capabilities_granted: ["message.send"],
    provider_key: SYNTHETIC_PROVIDER_KEY,
  });
  const foreignPort = stubPort({
    exists: true,
    enabled: true,
    status: "connected",
    ownership: "user",
    owner_user_id: randomUUID(),
    capabilities_granted: ["message.send"],
    provider_key: SYNTHETIC_PROVIDER_KEY,
  });

  const ownedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, member, delegated.workflow.id, {
      idempotency_key: "owned",
    }),
  );
  await tickEngine(tenant, deps(ownedPort));
  assert.equal((await runRow(tenant, ownedRun.id)).status, "succeeded");

  const foreignRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, member, delegated.workflow.id, {
      idempotency_key: "foreign",
    }),
  );
  await tickEngine(tenant, deps(foreignPort));
  const foreignRow = await runRow(tenant, foreignRun.id);
  assert.equal(foreignRow.status, "failed");
  assert.equal(foreignRow.error_category, "capability_missing");

  const sharedRun = await db.tenant(tenant, (q) =>
    triggerManualRun(q, member, delegated.workflow.id, {
      idempotency_key: "shared",
    }),
  );
  await tickEngine(tenant, deps(shared));
  const sharedRow = await runRow(tenant, sharedRun.id);
  assert.equal(sharedRow.status, "failed");
  assert.equal(sharedRow.error_category, "capability_missing");
});

// ---------------------------------------------------------------------------
// 10. Bounds and retention.
// ---------------------------------------------------------------------------

test("W30-A bounds: prune keeps live runs, the workflow limit bites and a disabled workflow refuses a run", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];

  // Retention: prune deletes only terminal runs older than the window.
  const workflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Retention",
      definition: manualDefinition([webhookAction("act")]),
    }),
  );
  const workflowId = workflow.workflow.id;
  await db.tenant(tenant, async (q) => {
    const insert = (id: string, status: string, ageDays: number) =>
      q.query(
        "INSERT INTO workflow_runs(id,tenant_id,workflow_id,revision,trigger_type,idempotency_key,status," +
          " created_at,next_attempt_at) VALUES($1,$2,$3,1,'manual',$4,$5,now()-($6::int * interval '1 day')," +
          " now()-(CASE WHEN $5 IN ('queued','running','waiting') THEN $6::int * interval '1 day' ELSE interval '0' END))",
        [id, tenant, workflowId, `key-${id}`, status, ageDays],
      );
    await insert(
      randomUUID(),
      "succeeded",
      WORKFLOW_LIMITS.run_retention_days + 10,
    );
    await insert(
      randomUUID(),
      "queued",
      WORKFLOW_LIMITS.run_retention_days + 10,
    );
    await insert(randomUUID(), "succeeded", 1);
  });
  const beforePrune = await db.tenant(tenant, (q) =>
    one(q, "SELECT count(*)::int AS c FROM workflow_runs WHERE tenant_id=$1", [
      tenant,
    ]),
  );
  assert.equal(beforePrune.c, 3);
  const pruned = await db.tenant(tenant, (q) => pruneRuns(q, tenant));
  assert.equal(pruned.deleted, 1, "only the aged terminal run is pruned");
  const remaining = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT status FROM workflow_runs WHERE tenant_id=$1 ORDER BY status",
      [tenant],
    ),
  );
  assert.deepEqual(
    remaining.rows.map((row: any) => row.status),
    ["queued", "succeeded"],
    "the live queued run and the recent terminal run survive",
  );

  // Per-tenant workflow limit: prefill to the cap, then the next create is refused.
  const limited = randomUUID();
  await db.tenant(limited, async (q) => {
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      limited,
      "Limited",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'owner',true)",
      [limited, owner.user_id],
    );
    for (
      let index = 0;
      index < WORKFLOW_LIMITS.max_workflows_per_tenant;
      index++
    )
      await q.query(
        "INSERT INTO workflow_definitions(id,tenant_id,name,description,status,owner_user_id,authority," +
          " current_draft_revision,created_by) VALUES($1,$2,$3,'','draft',$4,'delegated_user',1,$4)",
        [randomUUID(), limited, `wf ${index}`, owner.user_id],
      );
  });
  const limitedOwner = actor(limited, owner.user_id, "owner");
  await assert.rejects(
    db.tenant(limited, (q) =>
      createWorkflow(q, limitedOwner, {
        name: "Overflow",
        definition: manualDefinition([webhookAction("act")]),
      }),
    ),
    (error: any) => error.statusCode === 409 && /limit/i.test(error.message),
  );

  // A disabled workflow refuses a new run. Runs already running keep going.
  await db.tenant(tenant, (q) => enableWorkflow(q, owner, workflowId));
  const disabled = await db.tenant(tenant, (q) =>
    disableWorkflow(q, owner, workflowId),
  );
  assert.equal(disabled.workflow.status, "disabled");
  await assert.rejects(
    db.tenant(tenant, (q) => triggerManualRun(q, owner, workflowId, {})),
    (error: any) => error.statusCode === 409,
  );
});

test("W30-A schedule: an interval trigger fires from its publish instant and advances by exactly its interval", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const workflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name: "Interval",
      definition: {
        schema_version: 1,
        trigger: {
          id: "sched",
          type: "schedule",
          kind: "interval",
          every_seconds: 60,
          timezone: "UTC",
          missed_policy: "skip",
        },
        conditions: [],
        actions: [webhookAction("act")],
      },
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, workflow.workflow.id),
  );
  // The DSL forbids `at` on an interval trigger and there is no previous firing to
  // measure from, so the first occurrence is the publish instant plus one interval.
  const state = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT next_at,extract(epoch from (now() + interval '60 seconds' - next_at))::float AS delta_seconds" +
        " FROM workflow_schedule_state WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflow.workflow.id],
    ),
  );
  assert.notEqual(state.next_at, "infinity");
  assert.ok(
    Math.abs(Number(state.delta_seconds)) < 5,
    `the first interval occurrence is one interval away, delta ${state.delta_seconds}s`,
  );

  // Make it due, then let one tick fire it and advance by exactly one interval.
  const dueAt = new Date(Date.now() - 1000);
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_schedule_state SET next_at=$3 WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflow.workflow.id, dueAt],
    ),
  );
  const fired = await db.tenant(tenant, (q) =>
    scheduleTick(q, tenant, deps(stubPort(null))),
  );
  assert.equal(fired.fired, 1, "a due interval schedule fires");
  const after = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT next_at,last_at FROM workflow_schedule_state WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflow.workflow.id],
    ),
  );
  assert.equal(
    new Date(after.next_at).getTime() - new Date(after.last_at).getTime(),
    60000,
    "the next occurrence is exactly one interval after the fired instant",
  );
  const runs = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT idempotency_key FROM workflow_runs WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflow.workflow.id],
    ),
  );
  assert.equal(runs.rows.length, 1);
  assert.equal(
    runs.rows[0].idempotency_key,
    `schedule:${workflow.workflow.id}:sched:${dueAt.toISOString()}`,
  );

  // A second tick at an unchanged next_at is idempotent, not a second run.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_schedule_state SET next_at=$3 WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflow.workflow.id, dueAt],
    ),
  );
  await db.tenant(tenant, (q) => scheduleTick(q, tenant, deps(stubPort(null))));
  const again = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM workflow_runs WHERE tenant_id=$1 AND workflow_id=$2",
      [tenant, workflow.workflow.id],
    ),
  );
  assert.equal(again.c, 1, "the same scheduled instant produces one run");
});

// ---------------------------------------------------------------------------
// HTTP layer.
// ---------------------------------------------------------------------------

test("W30-A API: the automation catalog is exposed and an unknown operation is rejected at the edge", async () => {
  const auth = { cookie: httpOwner.cookie, "x-csrf-token": httpOwner.csrf };
  const catalog = await app.inject({
    method: "GET",
    url: "/api/v1/automations/catalog",
    headers: { cookie: httpOwner.cookie },
  });
  assert.equal(catalog.statusCode, 200);
  const body = catalog.json();
  assert.equal(body.triggers.length, 4);
  assert.deepEqual(body.operators, CONDITION_OPERATORS);
  assert.equal(body.limits.max_actions, WORKFLOW_LIMITS.max_actions);
  assert.equal(
    body.limits.max_definition_bytes,
    WORKFLOW_LIMITS.max_definition_bytes,
  );

  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/automations/workflows",
    headers: auth,
    payload: {
      name: "Bad",
      definition: manualDefinition([
        { id: "x", operation: "nope.nope", config: {} },
      ]),
    },
  });
  assert.equal(rejected.statusCode, 400, rejected.body);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/automations/workflows",
    headers: auth,
    payload: {
      name: "Good",
      definition: manualDefinition([webhookAction("act")]),
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().plan.length, 2);
  assert.match(httpTenant, /^[0-9a-f-]{36}$/);
});
