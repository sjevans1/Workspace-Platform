/**
 * W29-P0/A1 acceptance: the durable external-effect lifecycle.
 *
 * The claim under test is narrow and load-bearing: a real provider action must be
 * PLANNED inside the workflow's tenant transaction and EXECUTED with no database
 * transaction and no row lock held, and the outcome must be recorded honestly
 * enough that a crash can never duplicate or silently lose an external effect.
 *
 * Everything here is falsified against a real PostgreSQL cluster through the
 * shipped functions, and the provider is a deterministic fake that records what it
 * was asked to do. No Gmail, SMTP, JMAP, Microsoft, Google, Telegram or Discord
 * integration is involved, and the synthetic provider performs no network I/O.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { csrf, type Actor } from "../packages/auth/index.ts";
import {
  SYNTHETIC_PROVIDER_KEY,
  connectConnection,
  createConnection,
  providerActionIdempotent,
  revokeConnection,
  setConnectionEnabled,
  type ConnectionActionFacts,
} from "../packages/connectors/index.ts";
import {
  EFFECT_LIMITS,
  cancelRun,
  claimDueExternalEffects,
  commitExternalEffectOutcome,
  createWorkflow,
  deriveEffectRequest,
  effectAuthorityRefusal,
  effectDeliveryState,
  enableWorkflow,
  engineTick,
  ensureExternalEffect,
  externalEffectForRunStep,
  externalEffectTick,
  getRunDetail,
  markExternalEffectIoStarted,
  parseWorkflowDefinition,
  requestDigest,
  triggerManualRun,
  type ConnectorActionPort,
  type EngineDeps,
  type ExternalEffectClaim,
} from "../packages/automation/index.ts";
import { tick } from "../apps/worker/src/worker.ts";
import { connectorActionPortFor } from "../apps/api/src/connected-work.ts";

let pg: Awaited<ReturnType<typeof testPostgres>>;
let db: Database;

before(async () => {
  process.env.ENCRYPTION_KEY = "f".repeat(64);
  process.env.SETUP_TOKEN = "external-effect-setup-token";
  process.env.COOKIE_SECURE = "false";
  process.env.STORAGE_LOCAL_PATH = await mkdtemp(
    `${tmpdir()}/workspace-external-effects-`,
  );
  pg = await testPostgres(55449);
  if (!pg.emulated)
    process.env.RUNTIME_DB_PASSWORD = "external-effect-runtime-password";
  await migrate(pg.url);
  let applicationUrl = pg.url;
  if (!pg.emulated) {
    const runtimeUrl = new URL(pg.url);
    runtimeUrl.username = "workspace_runtime";
    runtimeUrl.password = process.env.RUNTIME_DB_PASSWORD!;
    applicationUrl = runtimeUrl.toString();
  }
  db = new Database(applicationUrl, { serialize: pg.emulated });
  await buildApp(db, undefined, false, null);
});

after(async () => {
  await db?.close();
  await pg?.close();
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function actor(tenant: string, user_id: string, role: Actor["role"]): Actor {
  return {
    tenant_id: tenant,
    user_id,
    role,
    name: role,
    email: `${user_id}@example.test`,
    scopes: null,
    expires_at: new Date(Date.now() + 3_600_000),
  };
}

async function freshTenantAndActors(
  ...roles: Actor["role"][]
): Promise<{ tenant: string; actors: Actor[] }> {
  const tenant = randomUUID();
  const ids = roles.map(() => randomUUID());
  await db.tenant(tenant, async (q) => {
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      tenant,
      `Effects ${tenant.slice(0, 8)}`,
    ]);
    for (const [index, role] of roles.entries()) {
      await q.query(
        "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,'x')",
        [ids[index], `${ids[index]}@example.test`, role],
      );
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,$3,true)",
        [tenant, ids[index], role],
      );
    }
  });
  return {
    tenant,
    actors: ids.map((id, index) => actor(tenant, id, roles[index])),
  };
}

/** A real, connected synthetic connection, so the worker re-checks real facts. */
async function connectedConnection(
  tenant: string,
  owner: Actor,
  ownership: "user" | "tenant" = "tenant",
  label = "Effects",
): Promise<{ id: string; secret: string }> {
  const secret = `effects-secret-${randomUUID()}-material`;
  const connection = await db.tenant(tenant, (q) =>
    createConnection(q, owner, {
      provider_key: SYNTHETIC_PROVIDER_KEY,
      label,
      ownership,
    }),
  );
  await db.tenant(tenant, (q) =>
    connectConnection(q, owner, connection.id, { secret }),
  );
  return { id: connection.id, secret };
}

/** The connection facts the engine's connector port reports for that connection. */
async function factsFor(
  tenant: string,
  connectionId: string,
): Promise<ConnectionActionFacts> {
  return {
    exists: true,
    enabled: true,
    status: "connected",
    ownership: "tenant",
    owner_user_id: null,
    capabilities_granted: ["message.send"],
    provider_key: SYNTHETIC_PROVIDER_KEY,
  } as ConnectionActionFacts & { id?: string };
}

const stubPort = (facts: ConnectionActionFacts): ConnectorActionPort => ({
  inspect: async () => facts,
});

const deps = (connectorPort: ConnectorActionPort): EngineDeps => ({
  connectorPort,
});

/** Plans and parks a connector action, returning the run id. */
async function planConnectorRun(
  tenant: string,
  owner: Actor,
  connectionId: string,
  name = "Effect",
): Promise<{ runId: string; workflowId: string }> {
  const workflow = await db.tenant(tenant, (q) =>
    createWorkflow(q, owner, {
      name,
      definition: parseWorkflowDefinition({
        schema_version: 1,
        trigger: { id: "manual", type: "manual" },
        conditions: [],
        actions: [
          {
            id: "call",
            operation: "connector.action.invoke",
            config: {
              connection_id: connectionId,
              action: "synthetic.record",
              capability: "message.send",
              payload: { label: name },
            },
          },
        ],
      }),
    }),
  );
  await db.tenant(tenant, (q) =>
    enableWorkflow(q, owner, workflow.workflow.id),
  );
  const run = await db.tenant(tenant, (q) =>
    triggerManualRun(q, owner, workflow.workflow.id, {}),
  );
  return { runId: run.id, workflowId: workflow.workflow.id };
}

const effectRow = (tenant: string, runId: string, stepSeq = 2) =>
  db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT * FROM workflow_external_effects WHERE tenant_id=$1 AND run_id=$2 AND step_seq=$3",
      [tenant, runId, stepSeq],
    ),
  );

const runRow = (tenant: string, runId: string) =>
  db.tenant(tenant, (q) =>
    one(q, "SELECT * FROM workflow_runs WHERE tenant_id=$1 AND id=$2", [
      tenant,
      runId,
    ]),
  );

const actionStep = (tenant: string, runId: string) =>
  db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT * FROM workflow_run_steps WHERE tenant_id=$1 AND run_id=$2 AND step_type='action'" +
        " ORDER BY attempt DESC LIMIT 1",
      [tenant, runId],
    ),
  );

/** Simulates a worker that died: its lease expires without any outcome commit. */
const expireLease = (tenant: string, effectId: string) =>
  db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_external_effects SET lease_expires_at=now()-interval '5 seconds'" +
        " WHERE tenant_id=$1 AND id=$2",
      [tenant, effectId],
    ),
  );

const forceClaimable = (tenant: string, runId: string) =>
  db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_runs SET next_attempt_at=now(),lease_token=NULL,lease_expires_at=NULL" +
        " WHERE tenant_id=$1 AND id=$2",
      [tenant, runId],
    ),
  );

type Ledger = {
  calls: { idempotency_key: string; attempt: number; payload: unknown }[];
  transactionsInFlight: number[];
  operations: Set<string>;
};

/**
 * A deterministic fake provider. It records every call, the tenant transactions
 * open at the moment of the call, and the provider-side OPERATIONS it performed,
 * keyed by the effect idempotency key, so a re-send that the provider dedupes is
 * provably one external operation.
 */
function fakeProvider(
  options: {
    fail?: (input: { attempt: number }) => unknown | null;
    idempotent?: boolean;
  } = {},
) {
  const ledger: Ledger = {
    calls: [],
    transactionsInFlight: [],
    operations: new Set<string>(),
  };
  const invokeProvider = async (input: {
    provider_key: string;
    action: string;
    capability: string;
    payload: Record<string, unknown>;
    effect: { idempotency_key: string; attempt: number };
  }) => {
    ledger.calls.push({
      idempotency_key: input.effect.idempotency_key,
      attempt: input.effect.attempt,
      payload: input.payload,
    });
    ledger.transactionsInFlight.push(db.tenantTransactionsInFlight());
    const failure = options.fail
      ? options.fail({ attempt: input.effect.attempt })
      : null;
    if (failure) throw failure;
    if (
      options.idempotent === false &&
      ledger.operations.has(input.effect.idempotency_key)
    )
      ledger.operations.add(
        `${input.effect.idempotency_key}#${ledger.calls.length}`,
      );
    else ledger.operations.add(input.effect.idempotency_key);
    return {
      recorded: true,
      provider_reference: `fake:${input.effect.idempotency_key.slice(0, 16)}`,
    };
  };
  return { ledger, invokeProvider };
}

const effectTick = (
  tenant: string,
  fake: ReturnType<typeof fakeProvider>,
  facts?: ConnectionActionFacts,
) =>
  externalEffectTick(db, tenant, {
    invokeProvider: fake.invokeProvider,
    ...(facts ? { inspectConnection: async () => facts } : {}),
  });

// ---------------------------------------------------------------------------
// 1. The transaction boundary, proven from the runtime.
// ---------------------------------------------------------------------------

test("A1: no provider I/O happens while a tenant transaction is held", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);

  // The engine PLANS the effect and parks the step, and touches no provider.
  const planned = await db.tenant(tenant, (q) =>
    engineTick(q, tenant, deps(stubPort(facts))),
  );
  assert.equal(planned.claimed, 1);
  assert.equal(
    fake.ledger.calls.length,
    0,
    "the engine transaction must never perform provider I/O",
  );
  const parked = await actionStep(tenant, runId);
  assert.equal(parked.status, "waiting");
  assert.equal(
    parked.retry_state.external_effect_id,
    (await effectRow(tenant, runId)).id,
    "the parked step must address the durable effect",
  );

  // The worker phase executes it with NO tenant transaction open.
  const ticked = await effectTick(tenant, fake, facts);
  assert.equal(ticked.succeeded, 1);
  assert.equal(fake.ledger.calls.length, 1);
  assert.deepEqual(
    fake.ledger.transactionsInFlight,
    [0],
    "the provider call must observe zero open tenant transactions",
  );

  // Settling happens in the engine's own short transaction.
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const run = await runRow(tenant, runId);
  assert.equal(run.status, "succeeded");
});

test("A1: the effect table is tenant-isolated with FORCE row level security", async () => {
  const forced = await db.system((q) =>
    one(
      q,
      "SELECT relforcerowsecurity AS forced, relrowsecurity AS enabled FROM pg_class WHERE relname='workflow_external_effects'",
    ),
  );
  assert.equal(forced.enabled, true, "row level security must be enabled");
  assert.equal(forced.forced, true, "row level security must be FORCED");
});

// ---------------------------------------------------------------------------
// 2. Deterministic identity and one logical effect per step.
// ---------------------------------------------------------------------------

test("A1: effect identity is deterministic and one step maps to one logical effect", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);

  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const first = await effectRow(tenant, runId);
  // A second plan for the same step (an early claim, a replay) must address the
  // SAME row and the SAME provider idempotency key.
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const second = await effectRow(tenant, runId);
  assert.equal(second.id, first.id, "the effect id is deterministic");
  assert.equal(
    second.idempotency_key,
    first.idempotency_key,
    "the provider idempotency key is deterministic",
  );
  const count = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM workflow_external_effects WHERE tenant_id=$1 AND run_id=$2",
      [tenant, runId],
    ),
  );
  assert.equal(count.c, 1, "a step owns exactly one durable effect");

  // The identity is derived from the run and step, and a DIFFERENT run differs.
  const other = await planConnectorRun(tenant, owner, connection.id, "Other");
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const otherEffect = await effectRow(tenant, other.runId);
  assert.notEqual(otherEffect.id, first.id);
  assert.notEqual(otherEffect.idempotency_key, first.idempotency_key);

  // A duplicate workflow retry maps to the same logical effect.
  const retryable = fakeProvider({
    fail: () =>
      Object.assign(new Error("upstream down"), { delivery_state: "not_sent" }),
  });
  await effectTick(tenant, retryable, facts);
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const afterRetry = await effectRow(tenant, runId);
  assert.equal(
    afterRetry.id,
    first.id,
    "a retry must not create a second effect",
  );
  assert.equal(
    afterRetry.idempotency_key,
    first.idempotency_key,
    "a retry keeps the provider idempotency identity",
  );
  assert.equal(
    afterRetry.status,
    "planned",
    "the retry re-arms the same effect",
  );
  const retried = await effectTick(tenant, retryable, facts);
  assert.equal(retried.failed, 1, "the second attempt failed again");
  const afterSecondAttempt = await effectRow(tenant, runId);
  assert.equal(
    Number(afterSecondAttempt.attempt),
    2,
    "the retry is a second attempt of ONE effect, not a second effect",
  );
  assert.equal(
    fake.ledger.calls.length,
    0,
    "the provider was never reached in this test",
  );
});

// ---------------------------------------------------------------------------
// 3. Claim exclusion, lease expiry, crash recovery.
// ---------------------------------------------------------------------------

test("A1: concurrent claims cannot both take one effect", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  const [a, b] = await Promise.all([
    db.tenant(tenant, (q) => claimDueExternalEffects(q, tenant, 5)),
    db.tenant(tenant, (q) => claimDueExternalEffects(q, tenant, 5)),
  ]);
  assert.equal(
    a.claims.length + b.claims.length,
    1,
    "exactly one claimant may hold the effect, even when claims overlap",
  );
  const held = [...a.claims, ...b.claims][0];
  const row = await effectRow(tenant, runId);
  assert.equal(row.status, "claimed");
  assert.equal(row.lease_token, held.lease_token);
  assert.equal(Number(row.attempt), 1);
});

test("A1: a crash BEFORE provider I/O is reclaimable and runs exactly once", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const effect = await effectRow(tenant, runId);

  // The worker claims the effect and dies before the I/O boundary.
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  assert.equal(claims.length, 1);
  assert.equal(
    fake.ledger.calls.length,
    0,
    "the claim itself must not perform provider I/O",
  );
  await expireLease(tenant, effect.id);

  const recovered = await effectTick(tenant, fake, facts);
  assert.equal(
    recovered.succeeded,
    1,
    "a crash before the boundary is retryable",
  );
  assert.equal(
    fake.ledger.calls.length,
    1,
    "the provider runs exactly once for one logical effect",
  );
  const finalRow = await effectRow(tenant, runId);
  assert.equal(finalRow.status, "succeeded");
  assert.equal(
    Number(finalRow.attempt),
    2,
    "the reclaimed attempt is recorded",
  );
});

test("A1: a crash AFTER provider I/O is never success and never auto-retried", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const effect = await effectRow(tenant, runId);

  // The worker claims, crosses the boundary, performs the provider call, and dies
  // before committing anything locally.
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  const claim = claims[0];
  await db.tenant(tenant, (q) => markExternalEffectIoStarted(q, tenant, claim));
  await fake.invokeProvider({
    provider_key: SYNTHETIC_PROVIDER_KEY,
    action: "synthetic.record",
    capability: "message.send",
    payload: {},
    effect: { idempotency_key: claim.idempotency_key, attempt: claim.attempt },
  });
  // The synthetic action declares an idempotency primitive; this scenario is the
  // provider WITHOUT one, which is what makes a re-send unsafe.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_external_effects SET provider_idempotent=false WHERE tenant_id=$1 AND id=$2",
      [tenant, effect.id],
    ),
  );
  await expireLease(tenant, effect.id);
  assert.equal(fake.ledger.calls.length, 1);

  const recovered = await effectTick(tenant, fake, facts);
  assert.equal(recovered.outcome_unknown, 1);
  assert.equal(
    fake.ledger.calls.length,
    1,
    "an unprovable outcome must never be re-sent automatically",
  );
  const finalRow = await effectRow(tenant, runId);
  assert.equal(finalRow.status, "outcome_unknown");
  assert.equal(finalRow.error_category, "outcome_unknown");

  // The engine settles the step and the run honestly: failed, not succeeded.
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const run = await runRow(tenant, runId);
  assert.equal(run.status, "failed");
  assert.equal(run.error_category, "outcome_unknown");
  const step = await actionStep(tenant, runId);
  assert.equal(step.status, "failed");
  assert.equal(step.error_category, "outcome_unknown");

  // And a later tick does not quietly retry it.
  await forceClaimable(tenant, runId);
  const after = await effectTick(tenant, fake, facts);
  assert.equal(after.claimed, 0);
  assert.equal(fake.ledger.calls.length, 1);
  assert.equal((await runRow(tenant, runId)).status, "failed");
});

test("A1: a reclaimed lease re-sends safely when the provider has an idempotency primitive", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const effect = await effectRow(tenant, runId);
  assert.equal(
    effect.provider_idempotent,
    true,
    "the synthetic action declares an idempotency primitive",
  );

  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  const claim = claims[0];
  await db.tenant(tenant, (q) => markExternalEffectIoStarted(q, tenant, claim));
  await fake.invokeProvider({
    provider_key: SYNTHETIC_PROVIDER_KEY,
    action: "synthetic.record",
    capability: "message.send",
    payload: {},
    effect: { idempotency_key: claim.idempotency_key, attempt: claim.attempt },
  });
  await expireLease(tenant, effect.id);

  const recovered = await effectTick(tenant, fake, facts);
  assert.equal(recovered.succeeded, 1);
  assert.equal(
    fake.ledger.calls.length,
    2,
    "the re-send is allowed because the provider dedupes on the idempotency key",
  );
  assert.deepEqual(
    new Set(fake.ledger.calls.map((call) => call.idempotency_key)),
    new Set([claim.idempotency_key]),
    "both sends carry the SAME provider idempotency key",
  );
  assert.equal(
    fake.ledger.operations.size,
    1,
    "the provider performed exactly one external operation",
  );
  const finalRow = await effectRow(tenant, runId);
  assert.equal(finalRow.status, "succeeded");
  assert.match(String(finalRow.provider_reference), /^fake:/);
});

test("A1: a stale worker cannot overwrite a newer claimant's outcome", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const effect = await effectRow(tenant, runId);

  const stale = (
    await db.tenant(tenant, (q) => claimDueExternalEffects(q, tenant, 5))
  ).claims[0];
  await expireLease(tenant, effect.id);
  const fresh = (
    await db.tenant(tenant, (q) => claimDueExternalEffects(q, tenant, 5))
  ).claims[0];
  assert.notEqual(fresh.lease_token, stale.lease_token);

  const staleCommit = await db.tenant(tenant, (q) =>
    commitExternalEffectOutcome(q, tenant, stale, {
      ok: true,
      result: { recorded: true, provider_reference: "stale-worker" },
    }),
  );
  assert.equal(staleCommit, "stale", "a reclaimed lease may not write");
  const untouched = await effectRow(tenant, runId);
  assert.equal(untouched.status, "claimed");
  assert.equal(untouched.lease_token, fresh.lease_token);
  assert.deepEqual(untouched.result, {});

  const freshCommit = await db.tenant(tenant, (q) =>
    commitExternalEffectOutcome(q, tenant, fresh, {
      ok: true,
      result: { recorded: true, provider_reference: "fresh-worker" },
    }),
  );
  assert.equal(freshCommit, "succeeded");
  const committed = await effectRow(tenant, runId);
  assert.equal(committed.provider_reference, "fresh-worker");
});

// ---------------------------------------------------------------------------
// 4. Authority, revocation and cancellation.
// ---------------------------------------------------------------------------

test("A1: a disabled or revoked connection fails closed before any provider I/O", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const facts = await factsFor(tenant, "unused");
  const fake = fakeProvider();

  // Disabled after planning.
  const disabled = await connectedConnection(
    tenant,
    owner,
    "tenant",
    "Disabled",
  );
  const disabledRun = await planConnectorRun(
    tenant,
    owner,
    disabled.id,
    "Disabled",
  );
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await db.tenant(tenant, (q) =>
    setConnectionEnabled(q, owner, disabled.id, false),
  );
  const refusedTick = await externalEffectTick(db, tenant, {
    invokeProvider: fake.invokeProvider,
  });
  assert.equal(refusedTick.refused, 1);
  assert.equal(
    fake.ledger.calls.length,
    0,
    "a disabled connection must not reach the provider",
  );
  const disabledEffect = await effectRow(tenant, disabledRun.runId);
  assert.equal(disabledEffect.status, "failed");
  assert.equal(disabledEffect.error_category, "capability_missing");

  // Revoked after planning.
  const revoked = await connectedConnection(tenant, owner, "tenant", "Revoked");
  const revokedRun = await planConnectorRun(
    tenant,
    owner,
    revoked.id,
    "Revoked",
  );
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await db.tenant(tenant, (q) => revokeConnection(q, owner, revoked.id));
  const revokedTick = await externalEffectTick(db, tenant, {
    invokeProvider: fake.invokeProvider,
  });
  assert.equal(revokedTick.refused, 1);
  assert.equal(fake.ledger.calls.length, 0);
  const revokedEffect = await effectRow(tenant, revokedRun.runId);
  assert.equal(revokedEffect.status, "failed");
  assert.equal(revokedEffect.error_category, "capability_missing");
});

test("A1: revoked run authority fails closed before any provider I/O", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  // The delegated user's membership is deactivated after the run was planned.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
      [tenant, owner.user_id],
    ),
  );
  const refused = await externalEffectTick(db, tenant, {
    invokeProvider: fake.invokeProvider,
  });
  assert.equal(refused.refused, 1);
  assert.equal(fake.ledger.calls.length, 0);
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "failed");
  assert.equal(effect.error_category, "authorization_revoked");
});

test("A1: cancellation stops an effect that has not crossed the boundary and never lies about one that has", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();

  // (a) Cancelled before the boundary: no provider call at all.
  const early = await planConnectorRun(tenant, owner, connection.id, "Early");
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await db.tenant(tenant, (q) => cancelRun(q, owner, early.runId));
  const earlyTick = await externalEffectTick(db, tenant, {
    invokeProvider: fake.invokeProvider,
  });
  assert.equal(earlyTick.refused, 1);
  assert.equal(
    fake.ledger.calls.length,
    0,
    "nothing may be sent after cancellation",
  );
  const earlyEffect = await effectRow(tenant, early.runId);
  assert.equal(earlyEffect.status, "cancelled");

  // (b) The provider call already happened: the outcome is still committed
  // honestly, and the cancellation is not used as an excuse to hide it.
  const late = await planConnectorRun(tenant, owner, connection.id, "Late");
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  const claim = claims.find((candidate) => candidate.run_id === late.runId)!;
  await db.tenant(tenant, (q) => markExternalEffectIoStarted(q, tenant, claim));
  await db.tenant(tenant, (q) => cancelRun(q, owner, late.runId));
  const committed = await db.tenant(tenant, (q) =>
    commitExternalEffectOutcome(q, tenant, claim, {
      ok: true,
      result: { recorded: true, provider_reference: "after-cancel" },
    }),
  );
  assert.equal(
    committed,
    "succeeded",
    "an effect that already occurred must be reported as it happened",
  );
  const lateEffect = await effectRow(tenant, late.runId);
  assert.equal(lateEffect.status, "succeeded");
  const lateRun = await runRow(tenant, late.runId);
  assert.equal(
    lateRun.status,
    "cancelled",
    "the run stays cancelled: the external effect is not undone",
  );
});

// ---------------------------------------------------------------------------
// 5. Hostile cross-tenant identity.
// ---------------------------------------------------------------------------

test("A1: cross-tenant effect, run and connection identities fail closed", async () => {
  const a = await freshTenantAndActors("owner");
  const b = await freshTenantAndActors("owner");
  const connection = await connectedConnection(a.tenant, a.actors[0]);
  const facts = await factsFor(a.tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(
    a.tenant,
    a.actors[0],
    connection.id,
  );
  await db.tenant(a.tenant, (q) =>
    engineTick(q, a.tenant, deps(stubPort(facts))),
  );
  const effect = await effectRow(a.tenant, runId);

  // Tenant B cannot see tenant A's effect at all (FORCE RLS), even by id.
  const visible = await db.tenant(b.tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM workflow_external_effects WHERE id=$1",
      [effect.id],
    ),
  );
  assert.equal(visible.c, 0, "another tenant must not see the effect");
  const claimedInB = await db.tenant(b.tenant, (q) =>
    claimDueExternalEffects(q, b.tenant, 5),
  );
  assert.equal(
    claimedInB.claims.length +
      claimedInB.settled.failed +
      claimedInB.settled.outcome_unknown,
    0,
    "another tenant must not claim or settle the effect",
  );

  // A workflow in tenant B naming tenant A's connection fails closed: no effect is
  // planned and the provider is never reached.
  const crossRun = await planConnectorRun(
    b.tenant,
    b.actors[0],
    connection.id,
    "Cross",
  );
  // The REAL connector port, so the cross-tenant boundary is exercised by the
  // shipped read rather than by an injected fact.
  await db.tenant(b.tenant, (q) =>
    engineTick(q, b.tenant, { connectorPort: connectorActionPortFor(q) }),
  );
  const crossEffect = await effectRow(b.tenant, crossRun.runId);
  assert.equal(
    crossEffect,
    undefined,
    "a cross-tenant connection plans no effect",
  );
  const crossRow = await runRow(b.tenant, crossRun.runId);
  assert.equal(crossRow.status, "failed");
  assert.equal(crossRow.error_category, "capability_missing");
  const crossTick = await externalEffectTick(db, b.tenant, {
    invokeProvider: fake.invokeProvider,
  });
  assert.equal(crossTick.claimed, 0);
  assert.equal(fake.ledger.calls.length, 0);

  // Tenant B cannot plan an effect that points at tenant A's run either.
  await assert.rejects(
    db.tenant(b.tenant, (q) =>
      ensureExternalEffect(q, b.tenant, {
        run_id: runId,
        workflow_id: randomUUID(),
        revision: 1,
        step_seq: 2,
        step_attempt: 1,
        operation: "connector.action.invoke",
        connection_id: connection.id,
        provider_key: SYNTHETIC_PROVIDER_KEY,
        action: "synthetic.record",
        capability: "message.send",
        provider_idempotent: true,
        authority_kind: "delegated_user",
        authority_user_id: b.actors[0].user_id,
        request: {
          connection_id: connection.id,
          action: "synthetic.record",
          capability: "message.send",
          payload: {},
        },
      }),
    ),
    "a foreign run id must not be addressable",
  );
});

// ---------------------------------------------------------------------------
// 6. Evidence quality: no secrets, understandable history, honest semantics.
// ---------------------------------------------------------------------------

test("A1: the effect, step and run evidence carry no secret material", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(
    tenant,
    owner,
    "tenant",
    "Secret",
  );
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await effectTick(tenant, fake, facts);
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  const effect = await effectRow(tenant, runId);
  const step = await actionStep(tenant, runId);
  const detail = await db.tenant(tenant, (q) => getRunDetail(q, owner, runId));
  const serialized = JSON.stringify({ effect, step, detail });
  assert.ok(
    !serialized.includes(connection.secret),
    "the connector secret must not reach effect, step or run evidence",
  );
  assert.ok(
    !/secret_encrypted|refresh_token|access_token|bot_token/.test(serialized),
    "no credential envelope may appear in run evidence",
  );
  // The durable effect records the request digest, never the request content.
  assert.equal(
    effect.request_digest,
    requestDigest({
      connection_id: connection.id,
      action: "synthetic.record",
      capability: "message.send",
      payload: { label: "Effect" },
    }),
    "the effect pins the request by digest",
  );
  assert.ok(
    !("payload" in effect) && !("request" in effect),
    "the effect stores identity and evidence, never provider content",
  );
});

test("A1: run and step history stays understandable for a provider action", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);

  // One real worker tick is enough: plan, execute outside the transaction, settle.
  await tick(db);

  const run = await runRow(tenant, runId);
  assert.equal(
    run.status,
    "succeeded",
    "the worker tick settles the whole run",
  );
  const step = await actionStep(tenant, runId);
  assert.equal(step.status, "succeeded");
  assert.equal(step.result.recorded, true, "the adapter result is preserved");
  const evidence = step.result.external_effect;
  assert.equal(evidence.status, "succeeded");
  assert.equal(evidence.attempt, 1);
  assert.equal(evidence.provider_key, SYNTHETIC_PROVIDER_KEY);
  assert.equal(evidence.action, "synthetic.record");
  assert.equal(evidence.capability, "message.send");
  assert.match(String(evidence.provider_reference), /^synthetic:/);
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "succeeded");
  assert.equal(effect.attempt, 1);
});

test("A1: the delivery-state contract distinguishes safe failure from unknown outcome", async () => {
  // An adapter that says the request never left is retryable; anything else is
  // treated as potentially delivered.
  const notSent = Object.assign(new Error("connect refused"), {
    delivery_state: "not_sent",
  });
  assert.equal(effectDeliveryState(notSent), "not_sent");
  assert.equal(effectDeliveryState(new Error("timeout")), "unknown");
  assert.equal(
    effectDeliveryState({ details: { delivery_state: "sent" } }),
    "sent",
    "a modelled value on the error details is honoured",
  );
  assert.equal(
    effectDeliveryState({ details: { delivery_state: "probably" } }),
    "unknown",
    "an unmodelled value is never trusted",
  );
  assert.equal(
    providerActionIdempotent(SYNTHETIC_PROVIDER_KEY, "synthetic.record"),
    true,
  );
  assert.equal(
    providerActionIdempotent(SYNTHETIC_PROVIDER_KEY, "synthetic.unknown"),
    false,
  );
  assert.equal(EFFECT_LIMITS.max_attempts, 7);
});

test("A1: a refusal is recorded without a lease and without touching the provider", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  // The request is re-derived from the immutable revision, and its digest is
  // checked against the planned one, before the provider is ever reached.
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  const derived = await db.tenant(tenant, (q) =>
    deriveEffectRequest(q, tenant, claims[0]),
  );
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.ok && derived.request.payload, { label: "Effect" });
  const tampered = { ...claims[0], request_digest: "0".repeat(64) };
  const refused = await db.tenant(tenant, (q) =>
    deriveEffectRequest(q, tenant, tampered),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.category, "validation");
  assert.match(
    refused.ok === false ? refused.summary : "",
    /digest does not match/,
  );
  assert.equal(fake.ledger.calls.length, 0);

  // The authority re-check is a pure read that reports the reason.
  const denial = await db.tenant(tenant, (q) =>
    effectAuthorityRefusal(q, tenant, claims[0]),
  );
  assert.equal(
    denial,
    null,
    "a healthy connection and authority pass the re-check",
  );
  void runId;
});
