/**
 * W29-P0/A2 acceptance: the customer endpoint-readiness contract.
 *
 * The route is the guided "Check network readiness" step a workspace
 * administrator uses, so it has to be authorized, bounded and non-oracle: it
 * resolves and evaluates through the SAME policy a real provider connection uses,
 * it never opens a socket to the destination, and its answer never carries a raw
 * address, the policy body or a credential.
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
import { createSession, csrf } from "../packages/auth/index.ts";
import {
  READINESS_STATES,
  setEgressResolverForTesting,
} from "../packages/connectors/index.ts";

let pg: Awaited<ReturnType<typeof testPostgres>>;
let db: Database;
let app: any;
let owner: { cookie: string; csrf: string };
let member: { cookie: string; csrf: string };
/** A second administrator, so the rate-limit case has its own budget. */
let secondAdmin: { cookie: string; csrf: string };
let tenant = "";

/**
 * A fresh administrator session. The readiness route is deliberately rate limited
 * per principal, so a test that makes several checks gets its own budget and the
 * suite stays order-independent.
 */
async function freshAdmin(): Promise<{ cookie: string; csrf: string }> {
  const id = randomUUID();
  const token = await db.tenant(tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Admin','x')",
      [id, `admin-${id.slice(0, 8)}@example.test`],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'admin',true)",
      [tenant, id],
    );
    return createSession(q, tenant, id);
  });
  return { cookie: `workspace_session=${token}`, csrf: csrf(token) };
}

const PUBLIC_IP = "93.184.216.34";

async function preflight(
  body: unknown,
  session?: { cookie: string; csrf: string },
): Promise<{ status: number; json: any; text: string }> {
  // A fresh administrator per call keeps each check inside its own per-principal
  // budget, so the suite does not depend on execution order.
  const caller = session ?? (await freshAdmin());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/connectors/endpoints/preflight",
    headers: {
      cookie: caller.cookie,
      "x-csrf-token": caller.csrf,
      "content-type": "application/json",
    },
    payload: body,
  });
  let json: any = null;
  try {
    json = response.json();
  } catch {
    json = null;
  }
  return { status: response.statusCode, json, text: response.body };
}

before(async () => {
  process.env.ENCRYPTION_KEY = "e".repeat(64);
  process.env.SETUP_TOKEN = "egress-preflight-setup-token";
  process.env.COOKIE_SECURE = "false";
  process.env.STORAGE_LOCAL_PATH = await mkdtemp(
    `${tmpdir()}/workspace-egress-`,
  );
  pg = await testPostgres(55451);
  if (!pg.emulated)
    process.env.RUNTIME_DB_PASSWORD = "egress-preflight-password";
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
      organisation: "Egress Co",
      workspace: "HQ",
      name: "Owner",
      email: "egress-owner@example.test",
      password: "test-password-123",
      demo: false,
    },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const cookie = setup.headers["set-cookie"].split(";")[0];
  owner = { cookie, csrf: csrf(cookie.split("=")[1]) };
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: owner.cookie },
  });
  tenant = me.json().organisation.id;

  // A member account and a second administrator, so the authorization and
  // rate-limit cases are isolated from each other.
  const memberId = randomUUID();
  const adminId = randomUUID();
  const memberToken = await db.tenant(tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Member','x')",
      [memberId, `member-${memberId.slice(0, 8)}@example.test`],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [tenant, memberId],
    );
    return createSession(q, tenant, memberId);
  });
  member = {
    cookie: `workspace_session=${memberToken}`,
    csrf: csrf(memberToken),
  };
  const adminToken = await db.tenant(tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Admin two','x')",
      [adminId, `admin-${adminId.slice(0, 8)}@example.test`],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'admin',true)",
      [tenant, adminId],
    );
    return createSession(q, tenant, adminId);
  });
  secondAdmin = {
    cookie: `workspace_session=${adminToken}`,
    csrf: csrf(adminToken),
  };
});

after(async () => {
  setEgressResolverForTesting(null);
  await db?.close();
  await pg?.close();
});

// ---------------------------------------------------------------------------
// Authorization.
// ---------------------------------------------------------------------------

test("A2 preflight: a member cannot check endpoints", async () => {
  setEgressResolverForTesting(async () => [{ address: PUBLIC_IP, family: 4 }]);
  const denied = await preflight(
    { host: "mail.example.test", port: 443 },
    member,
  );
  assert.equal(denied.status, 403);
  assert.match(String(denied.json?.error || ""), /Administrator access/);
});

test("A2 preflight: a service token cannot check endpoints", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/connectors/endpoints/preflight",
    headers: {
      authorization: "Bearer service-token-for-test",
      "content-type": "application/json",
    },
    payload: { host: "mail.example.test", port: 443 },
  });
  assert.ok(response.statusCode >= 400, response.body);
});

test("A2 preflight: the request shape is bounded and strict", async () => {
  for (const body of [
    {},
    { host: "mail.example.test" },
    { host: "mail.example.test", port: 0 },
    { host: "mail.example.test", port: 70_000 },
    { host: "a".repeat(300), port: 443 },
    { host: "mail.example.test", port: 443, extra: true },
  ]) {
    const rejected = await preflight(body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// Canonical answers.
// ---------------------------------------------------------------------------

test("A2 preflight: a public destination is ready and carries no raw address", async () => {
  setEgressResolverForTesting(async () => [{ address: PUBLIC_IP, family: 4 }]);
  const ready = await preflight({ host: "mail.example.test", port: 443 });
  assert.equal(ready.status, 200, ready.text);
  const readiness = ready.json.readiness;
  assert.equal(readiness.state, "ready");
  assert.equal(readiness.contacted, false);
  assert.equal(readiness.address_class, "public");
  assert.equal(readiness.resolved_answers, 1);
  assert.match(readiness.destination_digest, /^[0-9a-f]{32}$/);
  assert.match(readiness.policy.fingerprint, /^[0-9a-f]{24}$/);
  assert.ok(
    READINESS_STATES.includes(readiness.state),
    "the state is from the canonical vocabulary",
  );
  assert.ok(!ready.text.includes(PUBLIC_IP), "a raw address is never returned");
  assert.ok(
    !/"cidr"|CONNECTOR_EGRESS/.test(ready.text),
    "the policy body is never returned",
  );
});

test("A2 preflight: a private destination requires operator approval", async () => {
  setEgressResolverForTesting(async () => [
    { address: "10.20.30.40", family: 4 },
  ]);
  const result = await preflight({ host: "mail.internal.example", port: 993 });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.readiness.state, "private_requires_approval");
  assert.match(result.json.readiness.next_action, /operator/i);
  assert.ok(!result.text.includes("10.20.30.40"));
});

test("A2 preflight: loopback, metadata and link-local are blocked outright", async () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    setEgressResolverForTesting(async () => [
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    const result = await preflight({ host: "mail.example.test", port: 443 });
    assert.equal(result.status, 200, result.text);
    assert.equal(
      result.json.readiness.state,
      "blocked_by_operator_policy",
      address,
    );
    assert.ok(!result.text.includes(address), "the address is not echoed");
  }
});

test("A2 preflight: a hostname that resolves to a blocked address is not safe", async () => {
  setEgressResolverForTesting(async () => [
    { address: PUBLIC_IP, family: 4 },
    { address: "192.168.1.10", family: 4 },
  ]);
  const mixed = await preflight({ host: "mail.example.test", port: 443 });
  assert.equal(mixed.json.readiness.state, "private_requires_approval");

  setEgressResolverForTesting(async () => []);
  const empty = await preflight({ host: "mail.example.test", port: 443 });
  assert.equal(empty.json.readiness.state, "dns_failure");

  setEgressResolverForTesting(async () => {
    throw new Error("ENOTFOUND");
  });
  const failed = await preflight({ host: "mail.example.test", port: 443 });
  assert.equal(failed.json.readiness.state, "dns_failure");
});

test("A2 preflight: the port vocabulary is fixed and the host must be canonical", async () => {
  setEgressResolverForTesting(async () => [{ address: PUBLIC_IP, family: 4 }]);
  const port = await preflight({ host: "mail.example.test", port: 22 });
  assert.equal(port.json?.readiness?.state, "unsupported_port", port.text);

  for (const host of [
    "2130706433",
    "0177.0.0.1",
    "localhost",
    "*.example.test",
  ]) {
    const invalid = await preflight({ host, port: 443 });
    assert.equal(invalid.json.readiness.state, "invalid_destination", host);
  }
});

test("A2 preflight: a diagnostic never contacts the destination", async () => {
  // The resolver records how many times it was asked; nothing else may run.
  let resolutions = 0;
  setEgressResolverForTesting(async () => {
    resolutions += 1;
    return [{ address: "10.1.2.3", family: 4 }];
  });
  const result = await preflight({ host: "mail.internal.example", port: 443 });
  assert.equal(result.json?.readiness?.contacted, false, result.text);
  assert.equal(resolutions, 1, "exactly one resolution, and no socket");
  assert.equal(result.json.readiness.state, "private_requires_approval");
});

test("A2 preflight: the check is rate limited per principal", async () => {
  setEgressResolverForTesting(async () => [{ address: PUBLIC_IP, family: 4 }]);
  let limited = 0;
  for (let index = 0; index < 40; index += 1) {
    const result = await preflight(
      { host: "mail.example.test", port: 443 },
      secondAdmin,
    );
    if (result.status === 429) limited += 1;
  }
  assert.ok(limited > 0, "the readiness route must be rate limited");
});
