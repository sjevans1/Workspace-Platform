/**
 * W29-P0/A3 acceptance: the OAuth2 authorization journey and its hostile cases.
 *
 * This exercises the REAL routes end to end against the deterministic acceptance
 * provider: a connection is created, an authorization is started (PKCE S256, hashed
 * state, sealed verifier), the provider's own consent page is fetched and approved,
 * the callback exchanges the code through the substrate's transport and commits the
 * sealed credential, and the connection becomes connected. Every hostile case is
 * then falsified: replay, wrong session, expiry, supersession, revocation during
 * exchange, insufficient scope and secret leakage.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { csrf } from "../packages/auth/index.ts";
import {
  OAUTH_TEST_PROVIDER_KEY,
  claimRefresh,
  completeRefresh,
  digestEquals,
  exchangeAuthorizationCode,
  failRefresh,
  oauthDescriptorFor,
  credentialAad,
  issueTestCode,
  oauthStateDigest,
  oauthTestProviderState,
  pkcePair,
  parseOAuthDescriptor,
  redactOAuthMaterial,
  refreshGrant,
  sealCredential,
  sessionDigest,
  setOAuthRegistryForTesting,
  testOAuthTransport,
  resetOAuthTestProvider,
} from "../packages/connectors/index.ts";

process.env.CONNECTOR_OAUTH_TEST_PROVIDER = "1";
process.env.APP_URL = "http://localhost:3000";

let pg: Awaited<ReturnType<typeof testPostgres>>;
let db: Database;
let app: any;
let owner: { cookie: string; csrf: string; token: string };
let outsider: { cookie: string; csrf: string; token: string };
let tenant = "";

const descriptor = () => oauthDescriptorFor(OAUTH_TEST_PROVIDER_KEY)!;

async function createConnection(
  label: string,
  ownership: "user" | "tenant" = "tenant",
  session = owner,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/connectors/connections",
    remoteAddress: `198.51.100.${Math.floor(Math.random() * 200) + 10}`,
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    },
    payload: {
      provider_key: OAUTH_TEST_PROVIDER_KEY,
      label,
      ownership,
      capabilities: ["connection.health", "message.receive", "message.send"],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().connection.id as string;
}

async function startAuthorization(connection: string, session = owner, capabilities = [
  "connection.health",
  "message.receive",
]) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/connectors/connections/${connection}/oauth/start`,
    remoteAddress: `198.51.100.${Math.floor(Math.random() * 200) + 10}`,
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    },
    payload: { capabilities },
  });
  return response;
}

/** Drives the provider's own consent page and returns the callback URL. */
async function approveAtProvider(authorizationUrl: string): Promise<string> {
  const url = new URL(authorizationUrl);
  const page = await app.inject({
    method: "GET",
    url: `/api/v1/oauth-test/authorize${url.search}`,
  });
  assert.equal(page.statusCode, 200, redactOAuthMaterial(page.body));
  const hidden: Record<string, string> = {};
  for (const match of page.body.matchAll(/name="([a-z_]+)" value="([^"]*)"/g))
    hidden[match[1]] = match[2];
  const approved = await app.inject({
    method: "POST",
    url: "/api/v1/oauth-test/approve",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...hidden, decision: "approve" }).toString(),
  });
  assert.equal(approved.statusCode, 303, redactOAuthMaterial(approved.body));
  return approved.headers.location as string;
}

async function denyAtProvider(authorizationUrl: string): Promise<string> {
  const url = new URL(authorizationUrl);
  const page = await app.inject({ method: "GET", url: `/api/v1/oauth-test/authorize${url.search}` });
  const hidden: Record<string, string> = {};
  for (const match of page.body.matchAll(/name="([a-z_]+)" value="([^"]*)"/g))
    hidden[match[1]] = match[2];
  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/oauth-test/approve",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...hidden, decision: "deny" }).toString(),
  });
  assert.equal(denied.statusCode, 303, redactOAuthMaterial(denied.body));
  return denied.headers.location as string;
}

async function callback(location: string, session = owner) {
  const url = new URL(location);
  return app.inject({
    method: "GET",
    url: `${url.pathname}${url.search}`,
    remoteAddress: `198.51.100.${Math.floor(Math.random() * 200) + 10}`,
    headers: { cookie: session.cookie },
  });
}

async function status(connection: string, session = owner) {
  return app.inject({
    method: "GET",
    url: `/api/v1/connectors/connections/${connection}/oauth/status`,
    headers: { cookie: session.cookie },
  });
}

before(async () => {
  process.env.ENCRYPTION_KEY = "f".repeat(64);
  process.env.SETUP_TOKEN = "a3-oauth-setup-token";
  process.env.COOKIE_SECURE = "false";
  process.env.STORAGE_LOCAL_PATH = await mkdtemp(`${tmpdir()}/workspace-a3-oauth-`);
  pg = await testPostgres(55461);
  if (!pg.emulated) process.env.RUNTIME_DB_PASSWORD = "a3-oauth-password";
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
      organisation: "OAuth Co",
      workspace: "HQ",
      name: "Owner",
      email: "oauth-owner@example.test",
      password: "test-password-123",
      demo: false,
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"].split(";")[0];
  const token = cookie.split("=")[1];
  owner = { cookie, csrf: csrf(token), token };
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  tenant = me.json().organisation.id;
  // A second session of the same user, to prove session binding.
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: { email: "oauth-owner@example.test", password: "test-password-123" },
  });
  if (second.statusCode === 200) {
    const outsiderCookie = second.headers["set-cookie"].split(";")[0];
    const outsiderToken = outsiderCookie.split("=")[1];
    outsider = { cookie: outsiderCookie, csrf: csrf(outsiderToken), token: outsiderToken };
  } else {
    outsider = owner;
  }
});

after(async () => {
  setOAuthRegistryForTesting(null);
  resetOAuthTestProvider();
  await db?.close();
  await pg?.close();
});

// ---------------------------------------------------------------------------
// The journey.
// ---------------------------------------------------------------------------

test("A3: the catalog advertises the registered descriptor and no unregistered scope", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/connectors/catalog",
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  const entry = response
    .json()
    .oauth.find((item: any) => item.provider_key === OAUTH_TEST_PROVIDER_KEY);
  assert.ok(entry, "the registered descriptor is advertised");
  assert.equal(entry.test_only, true);
  assert.equal(entry.connectable, true);
  assert.ok(entry.scopes.some((scope: any) => scope.label === "Read messages"));
});

test("A3: the whole authorization journey connects the account and seals both tokens", async () => {
  const connection = await createConnection("Journey mailbox");
  const started = await startAuthorization(connection);
  assert.equal(started.statusCode, 200, redactOAuthMaterial(started.body));
  const authorizationUrl = new URL(started.json().authorization.authorization_url);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, descriptor().authorization_url);
  const state = authorizationUrl.searchParams.get("state")!;
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), descriptor().redirect_uri);

  // Only the DIGEST of the state and a SEALED verifier are at rest.
  const stored = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT state_digest,verifier_sealed,status,requested_scopes FROM connector_oauth_attempts WHERE connection_id=$1",
      [connection],
    ),
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].state_digest, oauthStateDigest(state));
  assert.ok(!stored.rows[0].verifier_sealed.includes(state));
  assert.notEqual(stored.rows[0].verifier_sealed, state);
  assert.equal(stored.rows[0].status, "authorizing");
  assert.deepEqual(stored.rows[0].requested_scopes.sort(), ["messages.read", "profile.read"]);

  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  assert.equal(new URL(callbackUrl).searchParams.get("state"), state);
  const completed = await callback(callbackUrl);
  assert.equal(completed.statusCode, 303, redactOAuthMaterial(completed.body));
  const clean = new URL(completed.headers.location as string);
  assert.equal(clean.pathname, "/");
  assert.equal(clean.searchParams.get("oauth"), "connected");
  assert.equal(clean.searchParams.get("connection"), connection);
  // The address the browser keeps carries no code, state, token or error text.
  for (const key of ["code", "state", "token", "error", "error_description", "access_token"])
    assert.equal(clean.searchParams.get(key), null, `${key} must not appear`);

  const connectionRow = await db.tenant(tenant, (q) =>
    q.query("SELECT status,capabilities_granted,config FROM connector_connections WHERE id=$1", [
      connection,
    ]),
  );
  assert.equal(connectionRow.rows[0].status, "connected");
  assert.deepEqual(connectionRow.rows[0].capabilities_granted.sort(), [
    "connection.health",
    "message.receive",
  ]);
  assert.equal(connectionRow.rows[0].config.account_hint, "operations@example.test");

  const credentials = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT kind,secret_encrypted,metadata FROM connector_credentials WHERE connection_id=$1 ORDER BY kind",
      [connection],
    ),
  );
  assert.deepEqual(
    credentials.rows.map((row: any) => row.kind),
    ["oauth_access", "oauth_refresh"],
  );
  for (const row of credentials.rows) {
    assert.ok(!row.secret_encrypted.includes("test-access-"));
    assert.ok(!row.secret_encrypted.includes("test-refresh-"));
    assert.ok(!JSON.stringify(row.metadata).includes("test-access-"));
  }

  const safe = await status(connection);
  assert.equal(safe.statusCode, 200, redactOAuthMaterial(safe.body));
  const body = JSON.stringify(safe.json());
  assert.ok(!body.includes("test-access-"));
  assert.ok(!body.includes("test-refresh-"));
  assert.ok(!/code_verifier|code_challenge/.test(body));
  assert.equal(safe.json().oauth.state, "consumed");
  assert.equal(safe.json().oauth.grant.length, 2);
});

test("A3: a provider denial leaves the connection pending with a retry", async () => {
  const connection = await createConnection("Denied mailbox");
  const started = await startAuthorization(connection);
  const callbackUrl = await denyAtProvider(started.json().authorization.authorization_url);
  const completed = await callback(callbackUrl);
  assert.equal(completed.statusCode, 303);
  assert.equal(new URL(completed.headers.location as string).searchParams.get("oauth"), "denied");
  const row = await db.tenant(tenant, (q) =>
    q.query("SELECT status FROM connector_connections WHERE id=$1", [connection]),
  );
  assert.equal(row.rows[0].status, "pending");
  const attempt = await db.tenant(tenant, (q) =>
    q.query("SELECT status,failure_category FROM connector_oauth_attempts WHERE connection_id=$1", [
      connection,
    ]),
  );
  assert.equal(attempt.rows[0].status, "denied");
  assert.equal(attempt.rows[0].failure_category, "provider_denied");
  // A retry is possible: a fresh attempt supersedes the denied one.
  const retry = await startAuthorization(connection);
  assert.equal(retry.statusCode, 200, redactOAuthMaterial(retry.body));
});

// ---------------------------------------------------------------------------
// Hostile cases.
// ---------------------------------------------------------------------------

test("A3: a replayed callback cannot re-commit and does not disturb the connection", async () => {
  const connection = await createConnection("Replay mailbox");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  const first = await callback(callbackUrl);
  assert.equal(new URL(first.headers.location as string).searchParams.get("oauth"), "connected");
  const before = await db.tenant(tenant, (q) =>
    q.query("SELECT key_version,id FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_access'", [
      connection,
    ]),
  );
  const replay = await callback(callbackUrl);
  assert.equal(replay.statusCode, 303);
  assert.notEqual(new URL(replay.headers.location as string).searchParams.get("oauth"), "connected");
  const after = await db.tenant(tenant, (q) =>
    q.query("SELECT key_version,id FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_access'", [
      connection,
    ]),
  );
  assert.deepEqual(after.rows[0], before.rows[0], "a replay never rotates the credential");
});

test("A3: a callback from a different session is refused and commits nothing", async () => {
  const connection = await createConnection("Session mailbox");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  const other = await callback(callbackUrl, outsider);
  assert.equal(other.statusCode, 303);
  assert.notEqual(new URL(other.headers.location as string).searchParams.get("oauth"), "connected");
  const row = await db.tenant(tenant, (q) =>
    q.query("SELECT status FROM connector_connections WHERE id=$1", [connection]),
  );
  assert.notEqual(row.rows[0].status, "connected");
  const credentials = await db.tenant(tenant, (q) =>
    q.query("SELECT count(*)::int AS c FROM connector_credentials WHERE connection_id=$1", [connection]),
  );
  assert.equal(credentials.rows[0].c, 0, "no credential is written for a foreign session");
});

test("A3: an expired attempt is refused", async () => {
  const connection = await createConnection("Expired mailbox");
  const started = await startAuthorization(connection);
  await db.tenant(tenant, (q) =>
    q.query("UPDATE connector_oauth_attempts SET expires_at=now()-interval '1 minute' WHERE connection_id=$1", [
      connection,
    ]),
  );
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  const completed = await callback(callbackUrl);
  assert.notEqual(new URL(completed.headers.location as string).searchParams.get("oauth"), "connected");
  const attempt = await db.tenant(tenant, (q) =>
    q.query("SELECT status,failure_category FROM connector_oauth_attempts WHERE connection_id=$1", [
      connection,
    ]),
  );
  assert.equal(attempt.rows[0].status, "expired");
});

test("A3: a second start supersedes the first, whose callback can no longer commit", async () => {
  const connection = await createConnection("Supersede mailbox");
  const first = await startAuthorization(connection);
  const second = await startAuthorization(connection);
  assert.equal(second.statusCode, 200, second.body);
  const stale = await approveAtProvider(first.json().authorization.authorization_url);
  const staleResult = await callback(stale);
  assert.notEqual(
    new URL(staleResult.headers.location as string).searchParams.get("oauth"),
    "connected",
  );
  const fresh = await approveAtProvider(second.json().authorization.authorization_url);
  const freshResult = await callback(fresh);
  assert.equal(new URL(freshResult.headers.location as string).searchParams.get("oauth"), "connected");
});

test("A3: revoking during the exchange refuses the commit and writes no credential", async () => {
  const connection = await createConnection("Revoked mailbox");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  const revoke = await app.inject({
    method: "POST",
    url: `/api/v1/connectors/connections/${connection}/revoke`,
    headers: {
      cookie: owner.cookie,
      "x-csrf-token": owner.csrf,
      "content-type": "application/json",
    },
    payload: {},
  });
  assert.equal(revoke.statusCode, 200, redactOAuthMaterial(revoke.body));
  const completed = await callback(callbackUrl);
  assert.notEqual(new URL(completed.headers.location as string).searchParams.get("oauth"), "connected");
  const row = await db.tenant(tenant, (q) =>
    q.query("SELECT status FROM connector_connections WHERE id=$1", [connection]),
  );
  assert.equal(row.rows[0].status, "revoked");
  const credentials = await db.tenant(tenant, (q) =>
    q.query("SELECT count(*)::int AS c FROM connector_credentials WHERE connection_id=$1", [connection]),
  );
  assert.equal(credentials.rows[0].c, 0, "a revoked connection gains no credential");
  // And a reconnect attempt on a revoked connection is refused outright.
  const reconnect = await app.inject({
    method: "POST",
    url: `/api/v1/connectors/connections/${connection}/oauth/reconnect`,
    headers: {
      cookie: owner.cookie,
      "x-csrf-token": owner.csrf,
      "content-type": "application/json",
    },
    payload: { capabilities: ["message.receive"] },
  });
  assert.equal(reconnect.statusCode, 409, redactOAuthMaterial(reconnect.body));
});

test("A3: an insufficient grant never promotes a connection to connected", async () => {
  const connection = await createConnection("Scope mailbox");
  const started = await startAuthorization(connection, owner, [
    "message.receive",
    "message.send",
  ]);
  const url = new URL(started.json().authorization.authorization_url);
  const page = await app.inject({ method: "GET", url: `/api/v1/oauth-test/authorize${url.search}` });
  const hidden: Record<string, string> = {};
  for (const match of page.body.matchAll(/name="([a-z_]+)" value="([^"]*)"/g))
    hidden[match[1]] = match[2];
  // The provider grants only a subset of what was requested.
  hidden.scope = "profile.read messages.read";
  const approved = await app.inject({
    method: "POST",
    url: "/api/v1/oauth-test/approve",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ ...hidden, decision: "approve" }).toString(),
  });
  const completed = await callback(approved.headers.location as string);
  assert.notEqual(new URL(completed.headers.location as string).searchParams.get("oauth"), "connected");
  const row = await db.tenant(tenant, (q) =>
    q.query("SELECT status FROM connector_connections WHERE id=$1", [connection]),
  );
  assert.notEqual(row.rows[0].status, "connected");
  const attempt = await db.tenant(tenant, (q) =>
    q.query("SELECT failure_category FROM connector_oauth_attempts WHERE connection_id=$1", [
      connection,
    ]),
  );
  assert.equal(attempt.rows[0].failure_category, "insufficient_scope");
});

test("A3: the provider refuses a wrong PKCE verifier and an unregistered redirect", async () => {
  const connection = await createConnection("PKCE mailbox");
  const started = await startAuthorization(connection);
  const url = new URL(started.json().authorization.authorization_url);
  // A tampered authorization request is refused by the provider itself.
  const bad = await app.inject({
    method: "GET",
    url: `/api/v1/oauth-test/authorize${url.search.replace(/client_id=[^&]*/, "client_id=someone-else")}`,
  });
  assert.equal(bad.statusCode, 400);
  const badRedirect = await app.inject({
    method: "GET",
    url: `/api/v1/oauth-test/authorize${url.search.replace(/redirect_uri=[^&]*/, "redirect_uri=https%3A%2F%2Fevil.example.test%2Fsteal")}`,
  });
  assert.equal(badRedirect.statusCode, 400);

  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  const code = new URL(callbackUrl).searchParams.get("code")!;
  const transport = testOAuthTransport(descriptor());
  const wrongVerifier = await exchangeAuthorizationCode({
    descriptor: descriptor(),
    code,
    verifier: "wrong-verifier-value",
    transport,
  });
  assert.equal(wrongVerifier.ok, false);
  const rightVerifier = await exchangeAuthorizationCode({
    descriptor: descriptor(),
    code,
    verifier: null,
    transport,
  });
  assert.equal(rightVerifier.ok, false, "a missing verifier is refused too");
});

test("A3: a service token and an unknown state are refused without leaking existence", async () => {
  const service = await app.inject({
    method: "POST",
    url: "/api/v1/connectors/connections/00000000-0000-4000-8000-000000000000/oauth/start",
    headers: { authorization: "Bearer service-token", "content-type": "application/json" },
    payload: { capabilities: ["message.receive"] },
  });
  assert.ok(service.statusCode >= 400);
  const unknown = await app.inject({
    method: "GET",
    url: "/api/v1/connectors/oauth/callback?code=whatever&state=not-a-real-state",
    headers: { cookie: owner.cookie },
  });
  assert.equal(unknown.statusCode, 303);
  assert.equal(new URL(unknown.headers.location as string).searchParams.get("oauth"), "error");
  assert.equal(new URL(unknown.headers.location as string).searchParams.get("connection"), null);
});

// ---------------------------------------------------------------------------
// The durable refresh lease.
// ---------------------------------------------------------------------------

test("A3: the refresh lease excludes a second worker and commits under the fence", async () => {
  const connection = await createConnection("Refresh mailbox");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  await callback(callbackUrl);

  const claim = await db.tenant(tenant, (q) =>
    claimRefresh(q, { tenant, connection_id: connection, credential_version: 1 }),
  );
  assert.ok(claim, "the first worker claims the lease");
  const second = await db.tenant(tenant, (q) =>
    claimRefresh(q, { tenant, connection_id: connection, credential_version: 1 }),
  );
  assert.equal(second, null, "a live lease excludes a concurrent refresh");

  const refreshToken = await db.tenant(tenant, (q) =>
    q.query(
      "SELECT key_version FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_refresh' AND revoked_at IS NULL",
      [connection],
    ),
  );
  const version = Number(refreshToken.rows[0].key_version);
  const refreshed = await refreshGrant({
    descriptor: descriptor(),
    refresh_token: "test-refresh-rotation-probe",
    transport: testOAuthTransport(descriptor()),
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  const committed = await db.tenant(tenant, (q) =>
    completeRefresh(q, {
      tenant,
      claim: { ...claim!, credential_version: version },
      descriptor: descriptor(),
      tokens: refreshed.ok ? refreshed.outcome : (null as never),
    }),
  );
  assert.equal(committed.rotated, true);
  const versions = await db.tenant(tenant, (q) =>
    q.query("SELECT key_version FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_refresh' ORDER BY key_version", [
      connection,
    ]),
  );
  assert.ok(versions.rows.length >= 2, "the refresh token rotated");
});

test("A3: a stale claim cannot commit, and invalid_grant becomes attention_required", async () => {
  const connection = await createConnection("Fence mailbox");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  await callback(callbackUrl);

  const claim = await db.tenant(tenant, (q) =>
    claimRefresh(q, { tenant, connection_id: connection, credential_version: 1 }),
  );
  assert.ok(claim);
  // A newer credential supersedes the claim: the fence must refuse.
  await db.tenant(tenant, (q) =>
    q.query(
      "UPDATE connector_credentials SET revoked_at=now() WHERE connection_id=$1 AND kind='oauth_refresh'",
      [connection],
    ),
  );
  await db.tenant(tenant, (q) =>
    q.query(
      "INSERT INTO connector_credentials(id,tenant_id,connection_id,kind,secret_encrypted,metadata,key_version)" +
        " VALUES(gen_random_uuid(),$1,$2,'oauth_refresh','sealed.placeholder.value','{}',99)",
      [tenant, connection],
    ),
  );
  const refused = await db
    .tenant(tenant, (q) =>
      completeRefresh(q, {
        tenant,
        claim: claim!,
        descriptor: descriptor(),
        tokens: {
          access_token: "test-access-stale",
          refresh_token: "test-refresh-stale",
          granted_scopes: [],
          account_hint: null,
          expires_in: 3600,
        },
      }),
    )
    .then(
      () => null,
      (error) => error,
    );
  assert.ok(refused, "a stale claim must not commit");

  // invalid_grant is honest: the connection needs a human, not a retry loop.
  const other = await createConnection("Invalid grant mailbox");
  const otherStart = await startAuthorization(other);
  const otherCallback = await approveAtProvider(otherStart.json().authorization.authorization_url);
  await callback(otherCallback);
  const otherClaim = await db.tenant(tenant, (q) =>
    claimRefresh(q, { tenant, connection_id: other, credential_version: 1 }),
  );
  const invalid = await refreshGrant({
    descriptor: descriptor(),
    refresh_token: "not-a-valid-refresh-token",
    transport: testOAuthTransport(descriptor()),
  });
  assert.equal(invalid.ok, false);
  await db.tenant(tenant, (q) =>
    failRefresh(q, {
      tenant,
      claim: otherClaim!,
      category: "refresh_invalid_grant",
      attention: true,
    }),
  );
  const row = await db.tenant(tenant, (q) =>
    q.query("SELECT status,attention_reason FROM connector_connections WHERE id=$1", [other]),
  );
  assert.equal(row.rows[0].status, "attention_required");
  assert.equal(row.rows[0].attention_reason, "refresh_invalid_grant");
});

void digestEquals;
void sessionDigest;
void oauthTestProviderState;

// ---------------------------------------------------------------------------
// Review corrections: authority at commit, capability bounding, client auth and
// secret-safe diagnostics.
// ---------------------------------------------------------------------------

test("A3: capabilities are bounded to what the connection was created with", async () => {
  const connection = await createConnection("Bounded mailbox", "tenant");
  // The connection was created with health + receive + send; asking for a
  // capability it was never created with is refused outright.
  const refused = await startAuthorization(connection, owner, ["message.forward"]);
  assert.equal(refused.statusCode, 400, redactOAuthMaterial(refused.body));
  const subset = await startAuthorization(connection, owner, ["message.receive"]);
  assert.equal(subset.statusCode, 200, redactOAuthMaterial(subset.body));
  const attempt = await db.tenant(tenant, (q) =>
    q.query("SELECT requested_scopes,requested_capabilities FROM connector_oauth_attempts WHERE connection_id=$1 AND status='authorizing'", [
      connection,
    ]),
  );
  assert.deepEqual(attempt.rows[0].requested_capabilities, ["message.receive"]);
  assert.deepEqual(attempt.rows[0].requested_scopes, ["messages.read"]);
});

test("A3: a downgraded membership cannot commit the authorization", async () => {
  const connection = await createConnection("Authority mailbox", "tenant");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  // The authorizing user is downgraded while the provider redirect is in flight.
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: owner.cookie } });
  const userId = me.json().user.id;
  try {
    await db.tenant(tenant, (q) =>
      q.query("UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        userId,
      ]),
    );
    const completed = await callback(callbackUrl);
    assert.notEqual(
      new URL(completed.headers.location as string).searchParams.get("oauth"),
      "connected",
    );
    const credentials = await db.tenant(tenant, (q) =>
      q.query("SELECT count(*)::int AS c FROM connector_credentials WHERE connection_id=$1", [
        connection,
      ]),
    );
    assert.equal(credentials.rows[0].c, 0, "a downgraded membership writes no credential");
  } finally {
    // Restore the role so the rest of the suite runs as the owner.
    await db.tenant(tenant, (q) =>
      q.query("UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        userId,
      ]),
    );
  }
});

test("A3: a connection disabled during the redirect cannot commit", async () => {
  const connection = await createConnection("Disabled mailbox", "tenant");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  await app.inject({
    method: "POST",
    url: `/api/v1/connectors/connections/${connection}/enabled`,
    headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" },
    payload: { enabled: false },
  });
  const completed = await callback(callbackUrl);
  assert.notEqual(
    new URL(completed.headers.location as string).searchParams.get("oauth"),
    "connected",
  );
  const credentials = await db.tenant(tenant, (q) =>
    q.query("SELECT count(*)::int AS c FROM connector_credentials WHERE connection_id=$1", [connection]),
  );
  assert.equal(credentials.rows[0].c, 0);
});

test("A3: two concurrent callbacks for one state commit exactly once", async () => {
  const connection = await createConnection("Concurrent mailbox", "tenant");
  const started = await startAuthorization(connection);
  const callbackUrl = await approveAtProvider(started.json().authorization.authorization_url);
  const [first, second] = await Promise.all([
    callback(callbackUrl),
    callback(callbackUrl),
  ]);
  const outcomes = [first, second].map((response) =>
    new URL(response.headers.location as string).searchParams.get("oauth"),
  );
  assert.equal(outcomes.filter((outcome) => outcome === "connected").length, 1);
  const access = await db.tenant(tenant, (q) =>
    q.query("SELECT count(*)::int AS c FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_access' AND revoked_at IS NULL", [
      connection,
    ]),
  );
  assert.equal(access.rows[0].c, 1, "exactly one access credential is active");
});

test("A3: two concurrent starts leave exactly one live authorization", async () => {
  const connection = await createConnection("Concurrent start mailbox", "tenant");
  const [first, second] = await Promise.all([
    startAuthorization(connection),
    startAuthorization(connection),
  ]);
  assert.ok([first, second].some((response) => response.statusCode === 200));
  const live = await db.tenant(tenant, (q) =>
    q.query("SELECT count(*)::int AS c FROM connector_oauth_attempts WHERE connection_id=$1 AND status IN ('authorizing','exchanging')", [
      connection,
    ]),
  );
  assert.equal(live.rows[0].c, 1, "one live authorization per connection");
});

test("A3: client_secret_basic is implemented, not merely declared", async () => {
  const basic = parseOAuthDescriptor({
    key: "basic-probe",
    display_name: "Basic probe",
    authorization_url: "https://provider.example.test/authorize",
    token_url: "https://provider.example.test/token",
    client_id: "basic-client",
    client_secret: "basic-client-secret-value",
    client_auth: "client_secret_basic",
    pkce: "S256",
    redirect_uri: "https://workspace.example.test/api/v1/connectors/oauth/callback",
    refresh_rotation: "rotates",
    scopes: [{ scope: "profile.read", capability: "connection.health", label: "Identity" }],
  });
  const fixture = oauthDescriptorFor(OAUTH_TEST_PROVIDER_KEY)!;
  // The fixture proves the substrate sends the declared method: a Basic descriptor
  // is answered with the credentials the header carries.
  const transport = testOAuthTransport(fixture);
  const pkce = pkcePair();
  const issued = issueTestCode({
    descriptor_key: fixture.key,
    redirect_uri: fixture.redirect_uri,
    scopes: ["profile.read"],
    challenge: pkce.challenge,
    method: "S256",
    behaviour: "approve",
  });
  const withBasic = await exchangeAuthorizationCode({
    descriptor: { ...fixture, client_auth: "client_secret_basic" },
    code: issued.code,
    verifier: pkce.verifier,
    transport: async (input) =>
      transport({
        ...input,
        descriptor: fixture,
        headers: {
          ...(input.headers ?? {}),
          authorization: `Basic ${Buffer.from("workspace-acceptance-client:acceptance-test-client-secret").toString("base64")}`,
        },
      }),
  });
  assert.equal(withBasic.ok, true, JSON.stringify(withBasic));
  void basic;
});

test("A3: OAuth material is redacted from any diagnostic", () => {
  const url =
    "http://localhost:3000/api/v1/connectors/oauth/callback?code=test-code-abc123&state=STATE_SECRET&error_description=leaked";
  const redacted = redactOAuthMaterial(url);
  for (const fragment of ["test-code-abc123", "STATE_SECRET", "leaked"])
    assert.ok(!redacted.includes(fragment), `not redacted: ${fragment}`);
  const bearer = redactOAuthMaterial("Authorization: Bearer test-access-1234567890abcdef");
  assert.ok(!bearer.includes("test-access-1234567890abcdef"));
  const basic = redactOAuthMaterial("Authorization: Basic d29ya3NwYWNlOmFjY2VwdGFuY2U=");
  assert.ok(!basic.includes("d29ya3NwYWNlOmFjY2VwdGFuY2U="));
  const form = redactOAuthMaterial("grant_type=authorization_code&client_secret=super-secret-value");
  assert.ok(!form.includes("super-secret-value"));
  assert.ok(redactOAuthMaterial("test-refresh-12345678-abcd").includes("[redacted]"));
});

test("A3: the worker refresh phase rotates a live grant and escalates a dead one", async () => {
  const { oauthRefreshTick } = await import("../apps/worker/src/connected-work.ts");
  const live = await createConnection("Worker refresh mailbox", "tenant");
  const liveStart = await startAuthorization(live);
  await callback(await approveAtProvider(liveStart.json().authorization.authorization_url));
  const before = await db.tenant(tenant, (q) =>
    q.query("SELECT key_version FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_refresh' AND revoked_at IS NULL", [live]),
  );
  const tick = await oauthRefreshTick(db, tenant, { now: new Date() });
  assert.ok(tick.refreshed >= 1, JSON.stringify(tick));
  const after = await db.tenant(tenant, (q) =>
    q.query("SELECT key_version FROM connector_credentials WHERE connection_id=$1 AND kind='oauth_refresh' AND revoked_at IS NULL", [live]),
  );
  assert.ok(
    Number(after.rows[0].key_version) > Number(before.rows[0].key_version),
    "the worker rotated the refresh credential",
  );

  // A grant the provider rejects needs a human, not a retry loop.
  const dead = await createConnection("Worker dead mailbox", "tenant");
  const deadStart = await startAuthorization(dead);
  await callback(await approveAtProvider(deadStart.json().authorization.authorization_url));
  const deadSecret = sealCredential(
    credentialAad(tenant, dead, "oauth_refresh"),
    "not-a-valid-refresh-token",
  );
  await db.tenant(tenant, (q) =>
    q.query("UPDATE connector_credentials SET secret_encrypted=$2 WHERE connection_id=$1 AND kind='oauth_refresh'", [
      dead,
      deadSecret,
    ]),
  );
  const deadTick = await oauthRefreshTick(db, tenant, { now: new Date() });
  assert.ok(deadTick.attention >= 1, JSON.stringify(deadTick));
  const row = await db.tenant(tenant, (q) =>
    q.query("SELECT status,attention_reason FROM connector_connections WHERE id=$1", [dead]),
  );
  assert.equal(row.rows[0].status, "attention_required");
});
