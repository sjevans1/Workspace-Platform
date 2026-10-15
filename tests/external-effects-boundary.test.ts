/**
 * W29-P0/A1 boundary acceptance: the atomic pre-I/O decision, allowlisted
 * evidence and truthful reconciliation after revocation.
 *
 * Split from tests/external-effects.test.ts so each file stays inside the CI test
 * timeout; both drive the same shipped lifecycle against a real PostgreSQL cluster
 * with a deterministic fake provider.
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
import type { Actor } from "../packages/auth/index.ts";
import {
  SYNTHETIC_PROVIDER_KEY,
  connectConnection,
  createConnection,
  revokeConnection,
  setConnectionEnabled,
  type ConnectionActionFacts,
} from "../packages/connectors/index.ts";
import {
  cancelRun,
  claimDueExternalEffects,
  commitExternalEffectOutcome,
  createWorkflow,
  deriveEffectRequest,
  effectAuthorityRefusal,
  effectFailureSummary,
  enableWorkflow,
  engineTick,
  externalEffectTick,
  getRunDetail,
  parseWorkflowDefinition,
  prepareExternalEffectIo,
  refuseExternalEffectBeforeIo,
  triggerManualRun,
  type ConnectorActionPort,
  type EngineDeps,
} from "../packages/automation/index.ts";
import { connectorActionPortFor } from "../apps/api/src/connected-work.ts";

let pg: Awaited<ReturnType<typeof testPostgres>>;
let db: Database;

before(async () => {
  process.env.ENCRYPTION_KEY = "f".repeat(64);
  process.env.SETUP_TOKEN = "external-effect-boundary-setup-token";
  process.env.COOKIE_SECURE = "false";
  process.env.STORAGE_LOCAL_PATH = await mkdtemp(
    `${tmpdir()}/workspace-external-effect-boundary-`,
  );
  pg = await testPostgres(55450);
  if (!pg.emulated)
    process.env.RUNTIME_DB_PASSWORD = "external-effect-boundary-password";
  await migrate(pg.url);
  let applicationUrl = pg.url;
  if (!pg.emulated) {
    const runtimeUrl = new URL(pg.url);
    runtimeUrl.username = "workspace_runtime";
    runtimeUrl.password = process.env.RUNTIME_DB_PASSWORD!;
    applicationUrl = runtimeUrl.toString();
  }
  db = new Database(applicationUrl, { serialize: pg.emulated });
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
      provider_reference: `${SYNTHETIC_PROVIDER_KEY}:${input.effect.idempotency_key.slice(0, 16)}`,
    };
  };
  return { ledger, invokeProvider };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
// 7. Sol review corrections: the pre-I/O boundary is atomic, evidence is
//    allowlisted, and a committed effect is reconciled truthfully.
// ---------------------------------------------------------------------------

test("A1: a cancellation committed before the boundary prevents every provider call", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  // The claim happens first, then the cancellation commits, and only then does the
  // phase reach its boundary decision.
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  assert.equal(claims.length, 1);
  await db.tenant(tenant, (q) => cancelRun(q, owner, runId));

  // The SAME claim now reaches the boundary decision.
  const prepared = await db.tenant(tenant, (q) =>
    prepareExternalEffectIo(q, tenant, claims[0], {
      inspectConnection: async () => facts,
    }),
  );
  assert.equal(prepared.ok, false);
  if (prepared.ok === false && "cancelled" in prepared)
    assert.equal(prepared.cancelled, true);
  else assert.fail("expected a cancellation refusal, not a stale claim");
  assert.equal(
    fake.ledger.calls.length,
    0,
    "a cancelled run must never reach the provider",
  );
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "cancelled");
  assert.equal(effect.io_started_at, null, "the boundary must not be marked");
});

test("A1: a connection revocation committed before the boundary prevents every provider call", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  assert.equal(claims.length, 1);
  await db.tenant(tenant, (q) =>
    setConnectionEnabled(q, owner, connection.id, false),
  );

  // The REAL connection read: no injected facts, so the shipped boundary is used.
  const prepared = await db.tenant(tenant, (q) =>
    prepareExternalEffectIo(q, tenant, claims[0]),
  );
  assert.equal(prepared.ok, false);
  if (prepared.ok === false && "category" in prepared)
    assert.equal(prepared.category, "capability_missing");
  else assert.fail("expected a refusal, not a stale claim");
  assert.equal(fake.ledger.calls.length, 0);
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "failed");
  assert.equal(effect.error_category, "capability_missing");
  assert.equal(effect.io_started_at, null);
});

test("A1: an authority revocation committed before the boundary prevents every provider call", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  assert.equal(claims.length, 1);
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
      [tenant, owner.user_id],
    ),
  );

  const prepared = await db.tenant(tenant, (q) =>
    prepareExternalEffectIo(q, tenant, claims[0]),
  );
  assert.equal(prepared.ok, false);
  if (prepared.ok === false && "category" in prepared)
    assert.equal(prepared.category, "authorization_revoked");
  else assert.fail("expected a refusal, not a stale claim");
  assert.equal(fake.ledger.calls.length, 0);
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "failed");
  assert.equal(effect.error_category, "authorization_revoked");
  assert.equal(effect.io_started_at, null);
});

test("A1: the final eligibility check and the boundary mark are one serialized transaction", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  const claim = claims[0];

  // Hold the boundary transaction open, with the real (locked) eligibility read.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const boundary = db.tenant(tenant, async (q) => {
    const prepared = await prepareExternalEffectIo(q, tenant, claim);
    await gate;
    return prepared;
  });
  await sleep(50);

  // A revocation cannot commit while the boundary decision is in flight: it waits
  // on the connection row that transaction holds.
  const revocation = db.tenant(tenant, (q) =>
    setConnectionEnabled(q, owner, connection.id, false),
  );
  const race = await Promise.race([
    revocation.then(() => "committed"),
    sleep(400).then(() => "blocked"),
  ]);
  assert.equal(
    race,
    "blocked",
    "a revocation must not commit between the check and the mark",
  );

  release();
  const prepared = await boundary;
  assert.equal(prepared.ok, true, "the boundary decision commits");
  await revocation;
  const row = await effectRow(tenant, runId);
  assert.equal(row.status, "claimed");
  assert.ok(row.io_started_at, "the boundary was marked before the revocation");

  // The revocation landed AFTER the committed boundary, so the effect is treated
  // as possibly delivered: its real outcome is committed, not cancelled away.
  const committed = await db.tenant(tenant, (q) =>
    commitExternalEffectOutcome(q, tenant, claim, {
      ok: true,
      result: { recorded: true, provider_reference: "after-boundary" },
    }),
  );
  assert.equal(committed, "succeeded");
  assert.equal((await effectRow(tenant, runId)).status, "succeeded");
});

test("A1: raw provider error text never reaches durable evidence", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);

  // A provider/transport exception carrying exactly the material that must never
  // be persisted: an Authorization header, a password and a recipient.
  const fakeCredential = "sk-live-FAKE-9f3a2b7c4d5e6f";
  const fakeRecipient = "secret-recipient@corp.example";
  const hostile = fakeProvider({
    fail: () =>
      Object.assign(
        new Error(
          `SMTP 535 authentication failed: Authorization: Bearer ${fakeCredential} password=${fakeCredential} recipient=${fakeRecipient} body=confidential`,
        ),
        { delivery_state: "not_sent" },
      ),
  });

  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const ticked = await effectTick(tenant, hostile, facts);
  assert.equal(ticked.failed, 1, "a not_sent failure stays retryable");
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "failed");
  assert.equal(
    effect.error_category,
    "transient",
    "retry classification is preserved",
  );
  assert.equal(
    effect.error_summary,
    effectFailureSummary("transient"),
    "only the allowlisted summary is persisted",
  );
  const effectText = JSON.stringify(effect);
  assert.ok(
    !effectText.includes(fakeCredential),
    "the credential must not be stored",
  );
  assert.ok(
    !effectText.includes(fakeRecipient),
    "the recipient must not be stored",
  );
  assert.ok(!/Authorization|password=|SMTP 535/.test(effectText));

  // The engine's own step and run evidence stay clean too.
  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const step = await actionStep(tenant, runId);
  const detail = await db.tenant(tenant, (q) => getRunDetail(q, owner, runId));
  const evidence = JSON.stringify({ step, detail });
  assert.ok(!evidence.includes(fakeCredential));
  assert.ok(!evidence.includes(fakeRecipient));
  assert.ok(!/Authorization|password=|SMTP 535/.test(evidence));

  // An unknown-outcome failure is summarized the same way.
  const unknownFake = fakeProvider({
    fail: () =>
      Object.assign(
        new Error(`dial tcp: Authorization: Bearer ${fakeCredential}`),
        {},
      ),
  });
  const other = await planConnectorRun(
    tenant,
    owner,
    connection.id,
    "UnknownText",
  );
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_external_effects SET provider_idempotent=false WHERE tenant_id=$1 AND run_id=$2",
      [tenant, other.runId],
    ),
  );
  await effectTick(tenant, unknownFake, facts);
  const unknownEffect = await effectRow(tenant, other.runId);
  assert.equal(unknownEffect.status, "outcome_unknown");
  assert.equal(
    unknownEffect.error_summary,
    effectFailureSummary("outcome_unknown"),
  );
  assert.ok(!JSON.stringify(unknownEffect).includes(fakeCredential));
});

test("A1: a hostile provider reference is not persisted", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await externalEffectTick(db, tenant, {
    inspectConnection: async () => facts,
    invokeProvider: async () => ({
      recorded: true,
      provider_reference: "https://user:password@host/x?token=abcdef",
    }),
  });
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "succeeded");
  assert.ok(
    effect.provider_reference === null ||
      /^sha256:[0-9a-f]{32}$/.test(String(effect.provider_reference)),
    `a URL-shaped reference is never stored verbatim (got ${effect.provider_reference})`,
  );
  assert.ok(
    !JSON.stringify(effect).includes("password@host"),
    "the raw reference must not be persisted",
  );
});

test("A1: a succeeded effect is reconciled truthfully after the connection is revoked", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);

  // The provider call happens and the effect is durably succeeded...
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await effectTick(tenant, fake, facts);
  assert.equal((await effectRow(tenant, runId)).status, "succeeded");
  assert.equal(fake.ledger.calls.length, 1);

  // ...and the connection is revoked BEFORE the parked step settles.
  await db.tenant(tenant, (q) => revokeConnection(q, owner, connection.id));

  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const run = await runRow(tenant, runId);
  const step = await actionStep(tenant, runId);
  assert.equal(
    run.status,
    "succeeded",
    "a revocation after the provider call must not rewrite the outcome",
  );
  assert.equal(step.status, "succeeded");
  assert.equal(step.result.recorded, true);
  assert.equal(step.result.external_effect.status, "succeeded");
  assert.equal((await effectRow(tenant, runId)).status, "succeeded");
  assert.equal(
    fake.ledger.calls.length,
    1,
    "reconciliation must never perform a second provider call",
  );

  // A NEW action for that revoked connection still fails closed with no I/O.
  const after = await planConnectorRun(
    tenant,
    owner,
    connection.id,
    "AfterRevoke",
  );
  // The REAL connector port, so the revocation is judged by the shipped read.
  await db.tenant(tenant, (q) =>
    engineTick(q, tenant, { connectorPort: connectorActionPortFor(q) }),
  );
  const afterRow = await runRow(tenant, after.runId);
  assert.equal(afterRow.status, "failed");
  assert.equal(afterRow.error_category, "capability_missing");
  assert.equal(
    await effectRow(tenant, after.runId),
    undefined,
    "a revoked connection must not plan a new effect",
  );
  assert.equal(fake.ledger.calls.length, 1, "and must not reach the provider");
});

test("A1: a terminal run never starts a new external effect", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  // Force the run into a terminal state while its effect is still planned.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE workflow_runs SET status='failed',error_category='validation',completed_at=now()," +
        " lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",
      [tenant, runId],
    ),
  );
  const ticked = await effectTick(tenant, fake, facts);
  assert.equal(ticked.refused, 1);
  assert.equal(ticked.invoked, 0);
  assert.equal(fake.ledger.calls.length, 0);
  assert.equal((await effectRow(tenant, runId)).status, "cancelled");
});

test("A1: a cancellation committed between the unlocked and locked run reads is refused", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const fake = fakeProvider();
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const { claims } = await db.tenant(tenant, (q) =>
    claimDueExternalEffects(q, tenant, 5),
  );
  const claim = claims[0];

  // The exact interleaving: the unlocked read sees an ACTIVE run, the cancellation
  // commits, and only then does the locked read (the authoritative one) run.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decision = db.tenant(tenant, async (q) => {
    const derived = await deriveEffectRequest(q, tenant, claim);
    await gate;
    const denial = await effectAuthorityRefusal(q, tenant, claim, undefined, {
      lock: true,
    });
    if (denial)
      await refuseExternalEffectBeforeIo(q, tenant, claim, {
        category: denial.category,
        summary: denial.summary,
        cancelled: denial.cancelled === true,
      });
    return { derived, denial };
  });
  await sleep(50);
  // No lock is held yet, so the cancellation commits immediately.
  await db.tenant(tenant, (q) => cancelRun(q, owner, runId));
  release();
  const { derived, denial } = await decision;

  assert.equal(
    derived.ok,
    true,
    "the unlocked read legitimately saw an active run",
  );
  assert.ok(denial, "the LOCKED read must see the cancellation");
  assert.equal(denial?.cancelled, true);
  assert.equal(denial?.category, "authorization_revoked");

  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "cancelled");
  assert.equal(
    effect.io_started_at,
    null,
    "the boundary must never be marked for a cancelled run",
  );
  assert.equal(
    fake.ledger.calls.length,
    0,
    "no provider call may happen for a cancelled run",
  );
  const after = await effectTick(tenant, fake, facts);
  assert.equal(after.invoked, 0);
  assert.equal(fake.ledger.calls.length, 0);
});

test("A1: a hostile provider reference is reduced to a safe digest, never stored raw", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));

  // URL/userinfo-shaped, with no obvious keyword and no query string.
  const hostileReference = "https://alice:QX7p9@host/path";
  await externalEffectTick(db, tenant, {
    inspectConnection: async () => facts,
    invokeProvider: async () => ({
      recorded: true,
      provider_reference: hostileReference,
    }),
  });

  const effect = await effectRow(tenant, runId);
  assert.equal(
    effect.status,
    "succeeded",
    "a hostile reference must never strand a successful effect",
  );
  assert.ok(
    effect.provider_reference === null ||
      /^sha256:[0-9a-f]{32}$/.test(String(effect.provider_reference)),
    `only a digest may be persisted (got ${effect.provider_reference})`,
  );
  assert.ok(
    !JSON.stringify(effect).includes(hostileReference),
    "the raw reference must not be persisted",
  );

  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const step = await actionStep(tenant, runId);
  const detail = await db.tenant(tenant, (q) => getRunDetail(q, owner, runId));
  assert.equal(step.status, "succeeded");
  const evidence = JSON.stringify({ step, detail });
  assert.ok(!evidence.includes(hostileReference));
  assert.ok(
    !evidence.includes("QX7p9"),
    "no fragment of the credential appears",
  );
});

test("A1: an injected error category is normalized, never persisted verbatim", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const injected = "password=Secret123";
  const hostile = fakeProvider({
    fail: () =>
      Object.assign(new Error("provider rejected the call"), {
        delivery_state: "not_sent",
        details: { category: injected },
      }),
  });
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await effectTick(tenant, hostile, facts);

  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "failed");
  assert.ok(
    ["transient", "rate_limited", "provider_unavailable"].includes(
      String(effect.error_category),
    ),
    `an unknown category must normalize to a canonical one (got ${effect.error_category})`,
  );
  assert.ok(
    !JSON.stringify(effect).includes(injected),
    "the injected category must not be persisted",
  );

  await forceClaimable(tenant, runId);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  const step = await actionStep(tenant, runId);
  const detail = await db.tenant(tenant, (q) => getRunDetail(q, owner, runId));
  const evidence = JSON.stringify({ step, detail });
  assert.ok(!evidence.includes(injected));
  assert.ok(!evidence.includes("Secret123"));
});

test("A1: a valid adapter category is still honoured and a credential-shaped one is not", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const owner = actors[0];
  const connection = await connectedConnection(tenant, owner);
  const facts = await factsFor(tenant, connection.id);
  const declared = fakeProvider({
    fail: () =>
      Object.assign(new Error("provider said no"), {
        delivery_state: "not_sent",
        details: { category: "validation" },
      }),
  });
  const { runId } = await planConnectorRun(tenant, owner, connection.id);
  await db.tenant(tenant, (q) => engineTick(q, tenant, deps(stubPort(facts))));
  await effectTick(tenant, declared, facts);
  const effect = await effectRow(tenant, runId);
  assert.equal(effect.status, "failed");
  assert.equal(
    effect.error_category,
    "validation",
    "an allowlisted adapter category is honoured",
  );
  assert.equal(
    effect.error_summary,
    effectFailureSummary("validation"),
    "and its summary stays the allowlisted constant",
  );
});
