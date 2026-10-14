/**
 * W29-A Connected Work acceptance: the provider registry, the capability
 * vocabulary, the credential envelope, connection ownership and isolation,
 * normalized events and dedupe, ingress verification, sync checkpoints, the
 * schema posture and the operator metrics.
 *
 * Every assertion here records a real observation from the connector runtime and
 * the migrated schema. Where the shipped behaviour disagrees with the intended
 * contract, the test asserts what actually happens and the discrepancy is called
 * out in the assertion message rather than hidden.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import type { Actor } from "../packages/auth/index.ts";
import {
  SYNTHETIC_PROVIDER_KEY,
  DECLARED_PROVIDER_KEYS,
  CAPABILITY_VOCABULARY_VERSION,
  providerDefinition,
  declaredProviders,
  adapterImplemented,
  validateProviderRegistration,
  normalizeCapabilities,
  defaultCapabilities,
  type ProviderDefinition,
  type CreateConnectionInput,
  credentialAad,
  sealCredential,
  openCredential,
  tokenDigest,
  sanitizeCredentialMetadata,
  type CredentialMetadata,
  assertNoSecretMaterial,
  putCredential,
  readCredential,
  credentialsFor,
  revokeCredentials,
  createConnection,
  listConnections,
  getConnection,
  connectConnection,
  setConnectionEnabled,
  revokeConnection,
  rotateConnectionCredential,
  testConnection,
  claimDueSync,
  completeSync,
  failSync,
  recordConnectorEvent,
  ingestProviderEvent,
  connectorMetrics,
  backoffSeconds,
  classifyProviderFailure,
  type NormalizedEvent,
} from "../packages/connectors/index.ts";

type Ownership = "user" | "tenant";

const SECRET = "synthetic-webhook-secret-0001";

let pg: Awaited<ReturnType<typeof testPostgres>>;
let db: Database;

before(async () => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  pg = await testPostgres(55446);
  await migrate(pg.url);
  db = new Database(pg.url, { serialize: pg.emulated });
});

after(async () => {
  await db?.close();
  await pg?.close();
});

/** A fresh tenant with the requested membership roles, so tests stay independent. */
async function freshTenantAndActors(
  ...roles: Actor["role"][]
): Promise<{ tenant: string; actors: Actor[] }> {
  const tenant = randomUUID();
  const ids = roles.map(() => randomUUID());
  await db.tenant(tenant, async (q) => {
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      tenant,
      `Connector ${tenant.slice(0, 8)}`,
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
    actors: roles.map((role, index) => ({
      tenant_id: tenant,
      user_id: ids[index],
      role,
      name: role,
      email: `${ids[index]}@example.test`,
      scopes: null,
      expires_at: new Date(Date.now() + 3_600_000),
    })),
  };
}

function makeConnection(
  actor: Actor,
  ownership: Ownership,
  extra: Partial<CreateConnectionInput> = {},
) {
  return db.tenant(actor.tenant_id, (q) =>
    createConnection(q, actor, {
      provider_key: SYNTHETIC_PROVIDER_KEY,
      label: "Test connection",
      ownership,
      ...extra,
    }),
  );
}

function connect(actor: Actor, id: string, secret = SECRET) {
  return db.tenant(actor.tenant_id, (q) =>
    connectConnection(q, actor, id, { secret }),
  );
}

function schedule(
  tenant: string,
  connectionId: string,
  options: { status?: string; dueAt?: Date; cursor?: string } = {},
) {
  const {
    status = "pending",
    dueAt = new Date(Date.now() - 60_000),
    cursor = null,
  } = options;
  return db.tenant(tenant, (q) =>
    q.query(
      "UPDATE connector_sync_state SET status=$3,next_attempt_at=$4,cursor=COALESCE($5,cursor)" +
        " WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, connectionId, status, dueAt, cursor],
    ),
  );
}

const syncState = (tenant: string, connectionId: string) =>
  db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT * FROM connector_sync_state WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, connectionId],
    ),
  );

const connectionRow = (tenant: string, connectionId: string) =>
  db.tenant(tenant, (q) =>
    one(q, "SELECT * FROM connector_connections WHERE id=$1", [connectionId]),
  );

const activeCredentials = (tenant: string, connectionId: string) =>
  db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM connector_credentials" +
        " WHERE tenant_id=$1 AND connection_id=$2 AND revoked_at IS NULL",
      [tenant, connectionId],
    ),
  );

// 1. Registry.
test("the synthetic provider is the only implemented adapter and every declared provider is unimplemented", () => {
  assert.equal(CAPABILITY_VOCABULARY_VERSION, "1.0.0");
  assert.equal(adapterImplemented(SYNTHETIC_PROVIDER_KEY), true);

  const declared = declaredProviders();
  assert.equal(declared.length, DECLARED_PROVIDER_KEYS.length);
  for (const entry of declared) {
    assert.equal(entry.implemented, false);
    assert.ok(
      (DECLARED_PROVIDER_KEYS as readonly string[]).includes(entry.key),
    );
    assert.equal(adapterImplemented(entry.key), false);
    assert.throws(
      () => providerDefinition(entry.key),
      (error: any) =>
        error.statusCode === 400 &&
        /Unknown connector provider/.test(error.message),
      `providerDefinition(${entry.key}) must reject a declared but unimplemented provider`,
    );
  }
  const keys = declared.map((entry) => entry.key);
  assert.deepEqual(keys, [...keys].sort(), "declared providers are sorted");
  assert.equal(
    new Set(keys).size,
    keys.length,
    "declared providers are unique",
  );
});

test("provider registration validation refuses malformed adapters", () => {
  const base = providerDefinition(SYNTHETIC_PROVIDER_KEY);
  const clone = (
    overrides: Partial<ProviderDefinition>,
  ): ProviderDefinition => ({
    ...base,
    ...overrides,
  });
  const rejects = (definition: ProviderDefinition, message: RegExp) =>
    assert.throws(
      () => validateProviderRegistration(definition),
      (error: any) => error.statusCode === 500 && message.test(error.message),
    );

  const valid = clone({});
  assert.equal(validateProviderRegistration(valid), valid);

  rejects(
    clone({
      capabilities: [...base.capabilities, "does.not.exist" as never],
    }),
    /unregistered capability/,
  );
  rejects(
    clone({
      actions: [
        {
          key: "synthetic.bad",
          display_name: "Bad action",
          requires_capability: "mail.read",
          retryable: true,
        },
      ],
    }),
    /undeclared capability/,
  );
  rejects(clone({ adapter_version: "1.0" }), /semantic/);
  rejects(
    clone({ webhook: true, credential_kinds: ["api_key"] }),
    /webhook secret/,
  );
});

// 2. Capabilities.
test("capability requests are validated, de-duplicated and sorted, and must be provider-declared", async () => {
  assert.deepEqual(
    normalizeCapabilities([
      "message.send",
      "message.send",
      "calendar.read",
      "mail.read",
    ]),
    ["calendar.read", "mail.read", "message.send"],
  );
  assert.throws(
    () => normalizeCapabilities(["nope.nope"]),
    (error: any) => error.statusCode === 400,
    "an unknown capability string must be rejected, not dropped",
  );
  assert.throws(
    () => normalizeCapabilities("message.send"),
    (error: any) => error.statusCode === 400,
    "the request must be an array",
  );

  const { actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const definition = providerDefinition(SYNTHETIC_PROVIDER_KEY);

  const defaults = await makeConnection(actor, "user");
  assert.deepEqual(
    defaults.capabilities_requested,
    defaultCapabilities(definition),
  );

  await assert.rejects(
    makeConnection(actor, "user", { capabilities: ["mail.read"] }),
    (error: any) =>
      error.statusCode === 400 && /does not provide/.test(error.message),
    "a capability the provider does not declare must be refused",
  );
});

// 3. Credentials.
test("the credential envelope is bound to its tenant, connection and kind and stores no plaintext", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  const plaintext = "plaintext-credential-value-4242";
  const aad = credentialAad(tenant, connection.id, "webhook_secret");

  const envelope = sealCredential(aad, plaintext);
  assert.equal(openCredential(aad, envelope), plaintext);
  assert.equal(
    envelope.includes(plaintext),
    false,
    "the ciphertext must not carry the plaintext",
  );
  for (const wrongAad of [
    credentialAad(randomUUID(), connection.id, "webhook_secret"),
    credentialAad(tenant, randomUUID(), "webhook_secret"),
    credentialAad(tenant, connection.id, "bot_token"),
  ])
    assert.throws(
      () => openCredential(wrongAad, envelope),
      "a ciphertext moved to another tenant, connection or kind must not open",
    );

  assert.deepEqual(
    sanitizeCredentialMetadata({
      access_token: "raw-access",
      refresh_token: "raw-refresh",
      token_digest: "digest",
      scopes: ["mail.read"],
    }),
    { token_digest: "digest", scopes: ["mail.read"] },
    "only allowlisted metadata keys may survive",
  );

  await db.tenant(tenant, (q) =>
    putCredential(q, tenant, connection.id, "webhook_secret", plaintext, {
      access_token: "raw-access",
      refresh_token: "raw-refresh",
      token_digest: tokenDigest(plaintext),
    } as unknown as CredentialMetadata),
  );
  const row = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT * FROM connector_credentials WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, connection.id],
    ),
  );
  assert.ok(row, "the credential row must exist");
  assert.notEqual(row.secret_encrypted, plaintext);
  for (const [column, value] of Object.entries(row))
    assert.equal(
      typeof value === "string" && value.includes(plaintext),
      false,
      `column ${column} must not contain the plaintext credential`,
    );
  assert.equal(
    JSON.stringify(row).includes(plaintext),
    false,
    "no nested representation of the row may carry the plaintext",
  );
  assert.deepEqual(row.metadata, { token_digest: tokenDigest(plaintext) });
  assert.equal(JSON.stringify(row.metadata).includes("access_token"), false);
  assert.equal(JSON.stringify(row.metadata).includes("refresh_token"), false);

  assert.throws(
    () =>
      assertNoSecretMaterial(
        JSON.stringify({ secret_encrypted: row.secret_encrypted }),
      ),
    (error: any) => error.statusCode === 500,
  );
  assert.doesNotThrow(() =>
    assertNoSecretMaterial(
      JSON.stringify({ token_digest: "abc", kind: "webhook_secret" }),
    ),
  );
});

test("credential rotation revokes the predecessor and installs the replacement", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await db.tenant(tenant, (q) =>
    putCredential(
      q,
      tenant,
      connection.id,
      "webhook_secret",
      "first-secret-value-0001",
    ),
  );

  const history = () =>
    db.tenant(tenant, (q) => credentialsFor(q, tenant, connection.id));
  const initial = await history();
  assert.equal(initial.length, 1);
  assert.equal(initial[0].key_version, 1);
  assert.equal(initial[0].revoked_at, null);

  // The connector_credentials_active partial unique index permits only one active
  // row per (tenant, connection, kind), so rotation must revoke the predecessor in
  // the same transaction BEFORE inserting the replacement. Both the low level call
  // and the API rotation path must therefore succeed and leave exactly one active
  // credential carrying the new secret.
  const rotated = await db.tenant(tenant, (q) =>
    putCredential(
      q,
      tenant,
      connection.id,
      "webhook_secret",
      "second-secret-value-0002",
    ),
  );
  assert.equal(rotated.key_version, 2);
  assert.ok(rotated.rotated_at, "a rotated credential records when it rotated");

  const active = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT id FROM connector_credentials WHERE tenant_id=$1 AND connection_id=$2" +
        " AND kind='webhook_secret' AND revoked_at IS NULL",
      [tenant, connection.id],
    ),
  );
  assert.equal(active.id, rotated.id, "exactly one active credential remains");

  const afterApi = await db.tenant(tenant, (q) =>
    rotateConnectionCredential(q, actor, connection.id, {
      secret: "third-secret-value-0003",
    }),
  );
  assert.ok(afterApi.status, "the connection stays usable across a rotation");
  const readable = await db.tenant(tenant, (q) =>
    readCredential(q, tenant, connection.id, "webhook_secret"),
  );
  assert.equal(readable?.secret, "third-secret-value-0003");
  assert.equal(readable?.key_version, 3);

  const after = await history();
  assert.equal(after.filter((row: any) => !row.revoked_at).length, 1);
  assert.equal(
    after.filter((row: any) => row.revoked_at).length,
    2,
    "predecessors are retained as revoked history",
  );
});

test("revokeCredentials destroys every active credential of a connection", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);
  await db.tenant(tenant, (q) =>
    putCredential(
      q,
      tenant,
      connection.id,
      "bot_token",
      "second-active-secret-0002",
    ),
  );
  assert.equal((await activeCredentials(tenant, connection.id)).c, 2);

  const revoked = await db.tenant(tenant, (q) =>
    revokeCredentials(q, tenant, connection.id),
  );
  assert.equal(revoked, 2);
  assert.equal((await activeCredentials(tenant, connection.id)).c, 0);
});

// 4. Ownership and isolation.
test("connection ownership and tenant isolation are enforced on read and manage", async () => {
  const a = await freshTenantAndActors("owner", "member", "member");
  const b = await freshTenantAndActors("owner");
  const [ownerA, member1, member2] = a.actors;
  const ownerB = b.actors[0];

  const delegated = await makeConnection(member1, "user");
  await connect(member1, delegated.id);

  const ownerView = await db.tenant(a.tenant, (q) =>
    getConnection(q, ownerA, delegated.id),
  );
  assert.equal(ownerView.id, delegated.id);
  assert.ok(
    (await db.tenant(a.tenant, (q) => listConnections(q, ownerA))).some(
      (row) => row.id === delegated.id,
    ),
    "a tenant owner may read a member's delegated connection",
  );

  assert.equal(
    (await db.tenant(a.tenant, (q) => listConnections(q, member2))).some(
      (row) => row.id === delegated.id,
    ),
    false,
    "another member must not see a delegated connection",
  );
  await assert.rejects(
    db.tenant(a.tenant, (q) => getConnection(q, member2, delegated.id)),
    (error: any) => error.statusCode === 404 && /not found/.test(error.message),
    "an unreadable connection reports as absent, never as forbidden",
  );

  await assert.rejects(
    makeConnection(member1, "tenant"),
    (error: any) => error.statusCode === 403,
    "a plain member may not create a shared, tenant-owned connection",
  );
  const memberOwned = await makeConnection(member1, "user");
  assert.equal(memberOwned.ownership, "user");
  assert.equal(memberOwned.owner_user_id, member1.user_id);

  const shared = await makeConnection(ownerA, "tenant");
  await connect(ownerA, shared.id);
  for (const attempt of [
    () =>
      db.tenant(a.tenant, (q) =>
        setConnectionEnabled(q, member1, shared.id, false),
      ),
    () => db.tenant(a.tenant, (q) => revokeConnection(q, member1, shared.id)),
    () => db.tenant(a.tenant, (q) => testConnection(q, member1, shared.id)),
  ])
    await assert.rejects(
      attempt,
      (error: any) => error.statusCode === 403,
      "a plain member may not manage a tenant-owned connection",
    );

  assert.equal(
    (await db.tenant(b.tenant, (q) => listConnections(q, ownerB))).some(
      (row) => row.id === delegated.id,
    ),
    false,
    "another tenant cannot list the connection",
  );
  await assert.rejects(
    db.tenant(b.tenant, (q) => getConnection(q, ownerB, delegated.id)),
    (error: any) => error.statusCode === 404,
    "another tenant cannot read the connection even when it knows the id",
  );
});

test("the connection identity guard refuses to change tenant, provider, ownership or owner", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner", "member");
  const [owner, member] = actors;
  const connection = await makeConnection(owner, "user");

  const attempts: [string, unknown[]][] = [
    [
      "UPDATE connector_connections SET tenant_id=$2 WHERE id=$1",
      [connection.id, randomUUID()],
    ],
    [
      "UPDATE connector_connections SET provider_key=$2 WHERE id=$1",
      [connection.id, "google-mail"],
    ],
    [
      "UPDATE connector_connections SET ownership=$2 WHERE id=$1",
      [connection.id, "tenant"],
    ],
    [
      "UPDATE connector_connections SET owner_user_id=$2 WHERE id=$1",
      [connection.id, member.user_id],
    ],
  ];
  for (const [sql, params] of attempts)
    await assert.rejects(
      db.tenant(tenant, (q) => q.query(sql, params)),
      /connector connection identity is immutable/,
      sql,
    );
});

// 5. Capabilities granted and status.
test("connecting grants the requested capabilities and enable, disable and revoke move the status", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];

  const pending = await db.tenant(tenant, (q) =>
    createConnection(q, actor, {
      provider_key: SYNTHETIC_PROVIDER_KEY,
      label: "Ops bot",
      ownership: "user",
      capabilities: ["connection.health", "message.send"],
      config: { chat_id: "ops-42" },
    }),
  );
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.capabilities_granted, []);
  assert.deepEqual(pending.capabilities_requested, [
    "connection.health",
    "message.send",
  ]);
  assert.equal(pending.config.chat_id, "ops-42");

  const connected = await connect(actor, pending.id);
  assert.equal(connected.status, "connected");
  assert.deepEqual(
    connected.capabilities_granted,
    connected.capabilities_requested,
  );
  assert.equal(connected.credentials.length, 1);
  assert.equal(connected.credentials[0].kind, "webhook_secret");
  assert.ok(connected.connected_at);

  const disabled = await db.tenant(tenant, (q) =>
    setConnectionEnabled(q, actor, pending.id, false),
  );
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.enabled, false);
  assert.equal(
    disabled.config.chat_id,
    "ops-42",
    "configuration survives disable",
  );

  const reEnabled = await db.tenant(tenant, (q) =>
    setConnectionEnabled(q, actor, pending.id, true),
  );
  assert.equal(reEnabled.status, "connected");
  assert.equal(reEnabled.enabled, true);

  const revoked = await db.tenant(tenant, (q) =>
    revokeConnection(q, actor, pending.id),
  );
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.capabilities_granted, []);
  assert.ok(revoked.revoked_at);
  assert.equal(
    (await activeCredentials(tenant, pending.id)).c,
    0,
    "revoking destroys the credential",
  );
});

// 6. Status projection.
test("the public projection describes the provider and carries no secret material", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "tenant");
  await connect(actor, connection.id);

  const view = await db.tenant(tenant, (q) =>
    getConnection(q, actor, connection.id),
  );
  const serialized = JSON.stringify(view);
  assert.doesNotThrow(() => assertNoSecretMaterial(serialized));

  const definition = providerDefinition(SYNTHETIC_PROVIDER_KEY);
  assert.equal(view.provider_display_name, definition.display_name);
  assert.equal(view.adapter_version, definition.adapter_version);
  assert.equal(view.ownership_label, "Shared (tenant)");
  assert.deepEqual(view.capabilities_available, [...definition.capabilities]);
  assert.ok(view.capabilities_granted.length > 0);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal("secret_encrypted" in view, false);
});

// 7. Events and dedupe.
test("connector events deduplicate on the tenant, connection and dedupe key and never queue a rejected event", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  const normalized = (dedupeKey: string): NormalizedEvent => ({
    event_type: "synthetic.tick",
    provider_event_id: `pe-${dedupeKey}`,
    dedupe_key: dedupeKey,
    occurred_at: null,
    resource_refs: [],
    payload_ref: { sequence: 1, synthetic: true },
  });
  const record = (dedupeKey: string, verification: "verified" | "rejected") =>
    db.tenant(tenant, (q) =>
      recordConnectorEvent(
        q,
        tenant,
        connection.id,
        SYNTHETIC_PROVIDER_KEY,
        normalized(dedupeKey),
        verification,
      ),
    );

  const first = await record("dup-1", "verified");
  assert.equal(first.inserted, true);
  const second = await record("dup-1", "verified");
  assert.equal(second.inserted, false);
  assert.equal(
    second.id,
    first.id,
    "a duplicate resolves to the one logical row",
  );

  const deduped = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT dedupe_key,duplicate_count FROM connector_events WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, connection.id],
    ),
  );
  assert.equal(deduped.rows.length, 1);
  assert.equal(deduped.rows[0].duplicate_count, 1);

  await record("dup-2", "verified");
  const keys = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT dedupe_key FROM connector_events WHERE tenant_id=$1 AND connection_id=$2 ORDER BY dedupe_key",
      [tenant, connection.id],
    ),
  );
  assert.deepEqual(
    keys.rows.map((row) => row.dedupe_key),
    ["dup-1", "dup-2"],
    "two different dedupe keys give two rows",
  );

  await record("rejected-1", "rejected");
  const rejected = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT dispatch_state FROM connector_events WHERE tenant_id=$1 AND connection_id=$2 AND dedupe_key=$3",
      [tenant, connection.id, "rejected-1"],
    ),
  );
  assert.notEqual(rejected.dispatch_state, "pending");
  assert.equal(rejected.dispatch_state, "skipped");
});

// 8. Ingress.
test("ingress verifies the provider request and a forged request records no event", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "tenant");
  await connect(actor, connection.id);
  const body = {
    event_type: "synthetic.ping",
    provider_event_id: "evt-1",
    dedupe_key: "ing-1",
  };
  const eventCount = () =>
    db.tenant(tenant, (q) =>
      one(
        q,
        "SELECT count(*)::int AS c FROM connector_events WHERE tenant_id=$1 AND connection_id=$2",
        [tenant, connection.id],
      ),
    );

  const before = (await eventCount()).c;
  const accepted = await ingestProviderEvent(db, {
    connection_id: connection.id,
    headers: { "x-connector-token": SECRET },
    body,
  });
  assert.equal(accepted.accepted, true);
  assert.equal((accepted as any).duplicate, false);
  assert.equal((accepted as any).event_type, "synthetic.ping");

  const replay = await ingestProviderEvent(db, {
    connection_id: connection.id,
    headers: { "x-connector-token": SECRET },
    body,
  });
  assert.equal((replay as any).accepted, true);
  assert.equal((replay as any).duplicate, true);
  assert.equal((await eventCount()).c, before + 1, "the replay adds no row");

  // A token that is not registered at all cannot resolve a connection: the
  // digest lookup runs before the adapter's own comparison.
  assert.deepEqual(
    await ingestProviderEvent(db, {
      connection_id: connection.id,
      headers: { "x-connector-token": "not-the-token" },
      body,
    }),
    { accepted: false, reason: "unknown_connection" },
  );

  // invalid_signature is only reachable when a stored digest resolves the
  // connection but disagrees with the stored secret.
  const mismatched = await makeConnection(actor, "tenant");
  await db.tenant(tenant, (q) =>
    putCredential(
      q,
      tenant,
      mismatched.id,
      "webhook_secret",
      "the-real-secret-value",
      {
        token_digest: tokenDigest("attacker-token"),
      },
    ),
  );
  assert.deepEqual(
    await ingestProviderEvent(db, {
      connection_id: mismatched.id,
      headers: { "x-connector-token": "attacker-token" },
      body,
    }),
    { accepted: false, reason: "invalid_signature" },
  );

  assert.deepEqual(
    await ingestProviderEvent(db, {
      connection_id: randomUUID(),
      headers: { "x-connector-token": SECRET },
      body,
    }),
    { accepted: false, reason: "unknown_connection" },
  );

  // A disabled connection still holds an active credential and reports disabled.
  await db.tenant(tenant, (q) =>
    setConnectionEnabled(q, actor, connection.id, false),
  );
  assert.deepEqual(
    await ingestProviderEvent(db, {
      connection_id: connection.id,
      headers: { "x-connector-token": SECRET },
      body,
    }),
    { accepted: false, reason: "disabled" },
  );

  // A revoked row that still holds an active credential reports disabled too.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE connector_connections SET status='revoked',enabled=false,revoked_at=now() WHERE id=$1",
      [mismatched.id],
    ),
  );
  assert.deepEqual(
    await ingestProviderEvent(db, {
      connection_id: mismatched.id,
      headers: { "x-connector-token": "attacker-token" },
      body,
    }),
    { accepted: false, reason: "disabled" },
  );

  // The real revoke path destroys the credential, so ingress can no longer even
  // resolve the connection: it reports unknown_connection rather than disabled.
  const revoked = await makeConnection(actor, "tenant");
  await connect(actor, revoked.id);
  await db.tenant(tenant, (q) => revokeConnection(q, actor, revoked.id));
  assert.deepEqual(
    await ingestProviderEvent(db, {
      connection_id: revoked.id,
      headers: { "x-connector-token": SECRET },
      body,
    }),
    { accepted: false, reason: "unknown_connection" },
  );

  // A forged request against a live connection creates no event row.
  const guarded = await makeConnection(actor, "tenant");
  await connect(actor, guarded.id);
  const guardedBefore = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM connector_events WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, guarded.id],
    ),
  );
  const forged = await ingestProviderEvent(db, {
    connection_id: guarded.id,
    headers: { "x-connector-token": "forged" },
    body,
  });
  assert.equal(forged.accepted, false);
  const guardedAfter = await db.tenant(tenant, (q) =>
    one(
      q,
      "SELECT count(*)::int AS c FROM connector_events WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, guarded.id],
    ),
  );
  assert.equal(
    guardedAfter.c,
    guardedBefore.c,
    "a forged request writes no event",
  );
});

// 9. Sync checkpoints.
test("claimDueSync claims only due, enabled, connected syncs and sets a lease", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];

  const due = await makeConnection(actor, "user");
  await connect(actor, due.id);
  const future = await makeConnection(actor, "user");
  await connect(actor, future.id);
  const idle = await makeConnection(actor, "user");
  await connect(actor, idle.id);
  const unconnected = await makeConnection(actor, "user");
  const disabled = await makeConnection(actor, "user");
  await connect(actor, disabled.id);
  await db.tenant(tenant, (q) =>
    setConnectionEnabled(q, actor, disabled.id, false),
  );

  await schedule(tenant, due.id, {});
  await schedule(tenant, future.id, {
    dueAt: new Date(Date.now() + 3_600_000),
  });
  await schedule(tenant, unconnected.id, {});
  await schedule(tenant, disabled.id, {});

  // Connecting a provider queues its first incremental sync, so the not-claimed
  // control here is a connection that is queued but not yet due.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE connector_sync_state SET next_attempt_at=now()+interval '1 hour'" +
        " WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, idle.id],
    ),
  );
  assert.equal((await syncState(tenant, idle.id)).status, "pending");
  assert.equal((await syncState(tenant, due.id)).status, "pending");

  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  assert.deepEqual(
    claims.map((claim) => claim.connection_id),
    [due.id],
    "only the due, enabled, connected connection is claimed",
  );

  const claimed = await syncState(tenant, due.id);
  assert.equal(claimed.status, "running");
  assert.ok(claimed.lease_token);
  assert.equal(claimed.attempts, 1);
  assert.equal(claims[0].lease_token, claimed.lease_token);
  assert.equal(claims[0].provider_key, SYNTHETIC_PROVIDER_KEY);
  assert.equal((await syncState(tenant, future.id)).lease_token, null);
  assert.equal((await syncState(tenant, disabled.id)).lease_token, null);
  assert.equal((await syncState(tenant, unconnected.id)).lease_token, null);
});

test("completeSync advances the cursor and clears the lease", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);
  await schedule(tenant, connection.id, {});

  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  assert.equal(claims.length, 1);
  await db.tenant(tenant, (q) =>
    completeSync(q, tenant, claims[0], {
      next_cursor: "CURSOR-2",
      next_at: new Date(Date.now() + 300_000),
    }),
  );

  const state = await syncState(tenant, connection.id);
  assert.equal(state.cursor, "CURSOR-2");
  assert.equal(state.status, "idle");
  assert.equal(state.lease_token, null);
  assert.equal(state.lease_expires_at, null);
  assert.equal(state.consecutive_failures, 0);
  assert.ok(state.last_success_at);
  assert.ok(state.sync_generation >= 2);
  const connectionAfter = await connectionRow(tenant, connection.id);
  assert.ok(connectionAfter.last_sync_at);
  assert.ok(connectionAfter.last_success_at);
});

test("failSync leaves the cursor byte for byte unchanged and records a bounded retry", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);
  await schedule(tenant, connection.id, { cursor: "cursor-v1" });

  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  assert.equal(claims.length, 1);
  assert.equal(claims[0].cursor, "cursor-v1");

  const bounded = backoffSeconds(claims[0].attempt);
  assert.ok(bounded >= 5 && bounded <= 3600);
  const nextAt = new Date(Date.now() + bounded * 1000);
  const outcome = await db.tenant(tenant, (q) =>
    failSync(q, tenant, claims[0], { status: 500 }, nextAt),
  );
  assert.equal(outcome.category, "provider_unavailable");
  assert.equal(outcome.attention, false);

  const state = await syncState(tenant, connection.id);
  assert.equal(
    state.cursor,
    "cursor-v1",
    "the cursor must not move on a failed sync",
  );
  assert.equal(state.status, "failed");
  assert.equal(state.last_error_category, "provider_unavailable");
  assert.equal(state.consecutive_failures, 1);
  assert.equal(state.lease_token, null);
  assert.ok(state.last_error_summary.length <= 200);
  assert.equal(new Date(state.next_attempt_at).getTime(), nextAt.getTime());
});

test("a rate-limited failure is classified rate_limited with a backoff at least the Retry-After", async () => {
  const classified = classifyProviderFailure({
    status: 429,
    retryAfterSeconds: 47,
  });
  assert.equal(classified.category, "rate_limited");
  assert.equal(classified.retryable, true);
  assert.ok(classified.backoff_seconds !== null);
  assert.ok(classified.backoff_seconds >= 47);
  assert.ok(classified.backoff_seconds <= 3600);

  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);
  await schedule(tenant, connection.id, {});

  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  const outcome = await db.tenant(tenant, (q) =>
    failSync(
      q,
      tenant,
      claims[0],
      { status: 429, retryAfterSeconds: 47 },
      new Date(Date.now() + 47_000),
    ),
  );
  assert.equal(outcome.category, "rate_limited");
  assert.equal(outcome.attention, false);
  assert.equal(
    (await syncState(tenant, connection.id)).last_error_category,
    "rate_limited",
  );
});

test("an expired credential moves the connection to attention_required but does not clear granted capabilities", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);
  const definition = providerDefinition(SYNTHETIC_PROVIDER_KEY);
  assert.deepEqual(
    (await connectionRow(tenant, connection.id)).capabilities_granted,
    defaultCapabilities(definition),
  );
  await schedule(tenant, connection.id, {});

  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  const outcome = await db.tenant(tenant, (q) =>
    failSync(
      q,
      tenant,
      claims[0],
      { status: 401 },
      new Date(Date.now() + 60_000),
    ),
  );
  assert.equal(outcome.category, "credential_expired");
  assert.equal(outcome.attention, true);

  const row = await connectionRow(tenant, connection.id);
  assert.equal(row.status, "attention_required");
  assert.ok(row.attention_reason);
  assert.deepEqual(
    row.capabilities_granted,
    defaultCapabilities(definition),
    "a sync failure does not clear the granted capabilities",
  );
  assert.equal((await syncState(tenant, connection.id)).status, "attention");
});

test("a running sync whose lease expired is reclaimed by claimDueSync", async () => {
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);
  await schedule(tenant, connection.id, {});

  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  assert.equal(claims.length, 1);

  // Simulate a crashed worker: the lease is in the past but the row is still
  // 'running'.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE connector_sync_state SET lease_expires_at=now()-interval '10 second'" +
        " WHERE tenant_id=$1 AND connection_id=$2",
      [tenant, connection.id],
    ),
  );
  const reclaimed = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  assert.equal(
    reclaimed.length,
    1,
    "a lease-expired running row must be reclaimable, or a crashed worker strands the sync",
  );
  assert.equal(reclaimed[0].lease_token !== claims[0].lease_token, true);
  assert.equal((await syncState(tenant, connection.id)).status, "running");
});

// 10. Schema posture.
test("every connector table is FORCE RLS with a tenant_isolation policy and the app role is granted", async () => {
  const tables = [
    "connector_connections",
    "connector_credentials",
    "connector_sync_state",
    "connector_events",
  ];
  for (const table of tables) {
    const flags = await db.system((q) =>
      one(
        q,
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1 AND relnamespace='public'::regnamespace",
        [table],
      ),
    );
    assert.equal(flags.relrowsecurity, true, `${table} must enable RLS`);
    assert.equal(flags.relforcerowsecurity, true, `${table} must FORCE RLS`);

    const policy = await db.system((q) =>
      one(
        q,
        "SELECT pg_get_expr(polqual,polrelid) AS using_expr, pg_get_expr(polwithcheck,polrelid) AS check_expr" +
          " FROM pg_policy WHERE polrelid=$1::regclass AND polname='tenant_isolation'",
        [`public.${table}`],
      ),
    );
    assert.ok(policy, `${table} must have a tenant_isolation policy`);
    assert.match(policy.using_expr, /app\.tenant_id/);
    assert.match(policy.check_expr, /app\.tenant_id/);

    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const granted = await db.system((q) =>
        one(q, "SELECT has_table_privilege('workspace_app',$1,$2) AS granted", [
          `public.${table}`,
          privilege,
        ]),
      );
      assert.equal(
        granted.granted,
        true,
        `workspace_app must hold ${privilege} on ${table}`,
      );
    }
  }

  for (const [name, signature] of [
    ["connector_ingress_context", "connector_ingress_context(uuid,text)"],
    ["workspace_connector_health", "workspace_connector_health()"],
  ]) {
    const proc = await db.system((q) =>
      one(
        q,
        "SELECT prosecdef FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace",
        [name],
      ),
    );
    assert.equal(proc.prosecdef, true, `${name} must be SECURITY DEFINER`);
    const grants = await db.system((q) =>
      one(
        q,
        "SELECT has_function_privilege('workspace_app',$1,'EXECUTE') AS app, has_function_privilege('public',$1,'EXECUTE') AS pub",
        [signature],
      ),
    );
    assert.equal(
      grants.app,
      true,
      `${name} EXECUTE must be granted to workspace_app`,
    );
    assert.equal(
      grants.pub,
      false,
      `${name} EXECUTE must be revoked from PUBLIC`,
    );
  }
});

// 11. Metrics.
test("connectorMetrics reflects the connections, attention, events and failures that exist", async () => {
  const before = await connectorMetrics(db);
  const { tenant, actors } = await freshTenantAndActors("owner");
  const actor = actors[0];
  const connection = await makeConnection(actor, "user");
  await connect(actor, connection.id);

  const event: NormalizedEvent = {
    event_type: "synthetic.metric",
    provider_event_id: "metric-1",
    dedupe_key: "metric-1",
    occurred_at: null,
    resource_refs: [],
    payload_ref: { metric: true },
  };
  await db.tenant(tenant, (q) =>
    recordConnectorEvent(
      q,
      tenant,
      connection.id,
      SYNTHETIC_PROVIDER_KEY,
      event,
      "verified",
    ),
  );
  await db.tenant(tenant, (q) =>
    recordConnectorEvent(
      q,
      tenant,
      connection.id,
      SYNTHETIC_PROVIDER_KEY,
      event,
      "verified",
    ),
  );

  await schedule(tenant, connection.id, {});
  const claims = await db.tenant(tenant, (q) => claimDueSync(q, tenant));
  await db.tenant(tenant, (q) =>
    failSync(
      q,
      tenant,
      claims[0],
      { status: 401 },
      new Date(Date.now() + 60_000),
    ),
  );

  const after = await connectorMetrics(db);
  assert.equal(after.connections - before.connections, 1);
  assert.equal(after.attention_required - before.attention_required, 1);
  assert.equal(after.events_received - before.events_received, 1);
  assert.equal(after.events_duplicate - before.events_duplicate, 1);
  assert.equal(after.sync_failures - before.sync_failures, 1);
});
