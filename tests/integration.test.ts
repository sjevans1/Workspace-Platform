import { test, before, after } from "node:test";
import { shutdownDiagnostics } from "./shutdown-diagnostics.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { createCollab } from "../apps/collab/src/server.ts";
import { tick } from "../apps/worker/src/worker.ts";
import { createSession, csrf, hash } from "../packages/auth/index.ts";
import type {
  OidcProfile,
  OidcProvider,
} from "../packages/auth/oidc.ts";
import { decrypt, signature } from "../packages/events/index.ts";
import {
  AntivirusUnavailableError,
  type Antivirus,
  type AntivirusScanResult,
} from "../packages/security/antivirus.ts";
let pg: any,
  db: Database,
  app: any,
  collab: any,
  dir: string,
  owner: any,
  member: any,
  guest: any,
  other: any,
  root: any,
  space: any,
  page: any,
  database: any,
  record: any,
  file: any,
  service: any,
  oidcProfile: OidcProfile,
  oidcLogout: any,
  antivirusResult: AntivirusScanResult = { status: "clean" },
  antivirusUnavailable = false;
const providers: HocuspocusProvider[] = [];
const fakeAntivirus: Antivirus = {
  enabled: true,
  async health() {
    if (antivirusUnavailable)
      throw new AntivirusUnavailableError("test scanner unavailable");
  },
  async scan() {
    if (antivirusUnavailable)
      throw new AntivirusUnavailableError("test scanner unavailable");
    return antivirusResult;
  },
};
const fakeOidc: OidcProvider = {
  label: "Test SSO",
  issuer: "https://idp.example.test/",
  async start(redirectUri) {
    const state = `state-${randomUUID()}`,
      codeVerifier = `verifier-${randomUUID()}`,
      nonce = `nonce-${randomUUID()}`,
      url = new URL("https://idp.example.test/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    return { url: url.href, state, codeVerifier, nonce };
  },
  async finish(currentUrl, expected) {
    assert.equal(currentUrl.searchParams.get("code"), "test-code");
    assert.equal(currentUrl.searchParams.get("state"), expected.state);
    assert.ok(expected.codeVerifier.startsWith("verifier-"));
    assert.ok(expected.nonce.startsWith("nonce-"));
    return oidcProfile;
  },
  async validateBackchannelLogout() {
    return oidcLogout;
  },
};
const req = async (
  method: string,
  path: string,
  data?: any,
  actor = owner,
  extra: any = {},
) => {
  const headers: any = {
    ...(actor ? { cookie: actor.cookie, "x-csrf-token": actor.csrf } : {}),
    ...extra,
  };
  if (data !== undefined && !headers["content-type"])
    headers["content-type"] = "application/json";
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers,
    ...(data !== undefined ? { payload: data } : {}),
  });
};
const ok = async (method: string, path: string, data?: any, actor = owner) => {
  const r = await req(method, path, data, actor);
  assert.ok(r.statusCode < 300, `${method} ${path}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const permissionPatch = async (
  path: string,
  data: { inherit: boolean; grants: any[] },
  actor = owner,
) => {
  const current = await ok("GET", path, undefined, actor);
  return ok(
    "PATCH",
    path,
    { ...data, expected_revision: current.revision },
    actor,
  );
};
function session(r: any) {
  const cookie = r.headers["set-cookie"].split(";")[0];
  return { cookie, csrf: csrf(cookie.split("=")[1]) };
}
function cookieFrom(r: any, name: string) {
  const values = Array.isArray(r.headers["set-cookie"])
    ? r.headers["set-cookie"]
    : [r.headers["set-cookie"]].filter(Boolean);
  const value = values
    .map((v: string) => v.split(";")[0])
    .find((v: string) => v.startsWith(`${name}=`));
  assert.ok(value, `Missing ${name} cookie`);
  return value;
}
async function beginOidc(inviteToken?: string) {
  const params = new URLSearchParams({ return_to: "/" });
  if (inviteToken) params.set("invite", inviteToken);
  const r = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/start?${params}`,
  });
  assert.equal(r.statusCode, 302, r.body);
  const location = new URL(r.headers.location);
  return {
    state: location.searchParams.get("state")!,
    cookie: cookieFrom(r, "workspace_oidc_state"),
  };
}
async function finishOidc(flow: { state: string; cookie: string }) {
  const r = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=test-code&state=${encodeURIComponent(flow.state)}`,
    headers: { cookie: flow.cookie },
  });
  assert.equal(r.statusCode, 302, r.body);
  const cookie = cookieFrom(r, "workspace_session");
  return { cookie, csrf: csrf(cookie.split("=")[1]) };
}
const pause = (n: number) => new Promise((r) => setTimeout(r, n));
async function storedFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...(await storedFiles(`${root}/${entry.name}`, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}
async function until(fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 80; i++) {
    if (await fn()) return;
    await pause(100);
  }
  throw Error("Timed out waiting for condition");
}
async function invite(role: string) {
  const v = await ok("POST", "/members/invite", {
    name: role,
    email: `${role}@example.test`,
    role,
  });
  const r = await req(
    "POST",
    "/auth/accept-invite",
    {
      token: new URL(v.url).searchParams.get("invite"),
      password: "test-password-123",
    },
    null,
  );
  assert.equal(r.statusCode, 200, r.body);
  const a = session(r);
  return { ...a, ...(await ok("GET", "/me", undefined, a)).user };
}
async function connect(a = owner, p = page) {
  const ticket = await ok("POST", `/pages/${p.id}/collab`, {}, a),
    doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: "ws://127.0.0.1:1235",
    name: ticket.name,
    token: ticket.token,
    document: doc,
  });
  providers.push(provider);
  await until(() => provider.synced);
  return { provider, doc };
}
before(async () => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.SETUP_TOKEN = "test-setup-token";
  process.env.METRICS_BEARER_TOKEN = "metrics-test-token-0123456789abcdef";
  process.env.COOKIE_SECURE = "false";
  dir = await mkdtemp(`${tmpdir()}/workspace-test-`);
  process.env.STORAGE_LOCAL_PATH = dir;
  pg = await testPostgres(55433);
  if (!pg.emulated) process.env.RUNTIME_DB_PASSWORD = "test-runtime-password";
  await migrate(pg.url);
  let applicationUrl = pg.url;
  if (!pg.emulated) {
    const runtimeUrl = new URL(pg.url);
    runtimeUrl.username = "workspace_runtime";
    runtimeUrl.password = process.env.RUNTIME_DB_PASSWORD!;
    applicationUrl = runtimeUrl.toString();
  }
  db = new Database(applicationUrl, { serialize: pg.emulated });
  oidcProfile = {
    issuer: fakeOidc.issuer,
    subject: "owner-subject",
    email: "owner@example.test",
    name: "Owner",
  };
  oidcLogout = {
    issuer: fakeOidc.issuer,
    subject: "owner-subject",
    jti: "initial-logout",
    expiresAt: new Date(Date.now() + 300000),
  };
  app = await buildApp(db, undefined, false, fakeOidc, fakeAntivirus);
  const r = await req(
    "POST",
    "/setup",
    {
      organisation: "Acme",
      workspace: "HQ",
      name: "Owner",
      email: "owner@example.test",
      password: "test-password-123",
      demo: false,
    },
    null,
    { "x-setup-token": process.env.SETUP_TOKEN },
  );
  assert.equal(r.statusCode, 200, r.body);
  owner = session(r);
  const me = await ok("GET", "/me");
  owner = { ...owner, ...me.user, tenant: me.organisation.id };
  root = (await ok("GET", "/resources"))[0];
  space = await ok("POST", "/resources", {
    kind: "space",
    parent_id: root.id,
    title: "Engineering",
  });
  page = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "A confidential design",
  });
  member = await invite("member");
  guest = await invite("guest");
  const tenant = randomUUID();
  await db.tenant(tenant, async (q) => {
    await q.query("INSERT INTO organisations(id,name) VALUES($1,'Other tenant')", [
      tenant,
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
      [tenant, owner.id],
    );
  });
  const t = await db.tenant(tenant, (q) => createSession(q, tenant, owner.id));
  other = { cookie: `workspace_session=${t}`, csrf: csrf(t), tenant };
  collab = await createCollab(db, 1235);
});
after(async () => {
  const done = shutdownDiagnostics();
  providers.forEach((p) => {
    p.destroy();
    p.document.destroy();
  });
  await collab?.close();
  await app?.close();
  await db?.close();
  await pg?.close();
  await rm(dir, { recursive: true, force: true });
  done();
});
test("metrics endpoint is bearer-protected and excludes tenant identifiers", async () => {
  const unauthenticated = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);
  assert.equal(unauthenticated.headers["www-authenticate"], "Bearer");

  const wrong = await app.inject({
    method: "GET",
    url: "/metrics",
    headers: { authorization: "Bearer incorrect-metrics-token-0123456789abcdef" },
  });
  assert.equal(wrong.statusCode, 401, wrong.body);

  const accepted = await app.inject({
    method: "GET",
    url: "/metrics",
    headers: {
      authorization:
        "Bearer metrics-test-token-0123456789abcdef",
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.match(
    String(accepted.headers["content-type"]),
    /text\/plain/,
  );
  assert.match(accepted.body, /workspace_up 1/);
  assert.match(
    accepted.body,
    /workspace_dependency_ready\{dependency="database"\} 1/,
  );
  assert.match(
    accepted.body,
    /workspace_dependency_ready\{dependency="storage"\} 1/,
  );
  assert.match(
    accepted.body,
    /workspace_dependency_ready\{dependency="antivirus"\} 1/,
  );
  assert.match(
    accepted.body,
    /workspace_service_configured\{service="collaboration"\} 0/,
  );
  assert.match(
    accepted.body,
    /workspace_service_configured\{service="worker"\} 0/,
  );
  assert.doesNotMatch(
    accepted.body,
    new RegExp([owner.tenant, owner.id, page.id].join("|")),
  );
});

test("self-service organisation creation is disabled by default", async () => {
  const r = await req("POST", "/organisations", { name: "Blocked tenant" });
  assert.equal(r.statusCode, 403, r.body);
  assert.match(r.body, /Self-service organisation creation is disabled/);
});

test("native integration uses the restricted production runtime database role", async () => {
  if (pg.emulated) return;
  const role = await db.system((q) =>
    one(
      q,
      "SELECT current_user AS name,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass",
    ),
  );
  assert.equal(role.name, "workspace_runtime");
  assert.equal(role.bypass, false);
});

test("SCIM provisions tenant users and active=false immediately revokes only that tenant sessions", async () => {
  const connector = await ok("POST", "/scim/connectors", {
    label: "Identity directory",
    default_role: "member",
  });
  assert.match(connector.token, /^scim_[A-Za-z0-9_-]+$/);
  assert.match(connector.base_url, /\/scim\/v2$/);

  const scim = async (
    method: string,
    path: string,
    data?: any,
    tokenValue = connector.token,
  ) =>
    app.inject({
      method,
      url: `/scim/v2${path}`,
      headers: {
        authorization: `Bearer ${tokenValue}`,
        ...(data !== undefined
          ? { "content-type": "application/scim+json" }
          : {}),
      },
      ...(data !== undefined ? { payload: data } : {}),
    });

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/scim/v2/ServiceProviderConfig",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.match(
    unauthenticated.headers["content-type"],
    /application\/scim\+json/,
  );

  const config = await scim("GET", "/ServiceProviderConfig");
  assert.equal(config.statusCode, 200, config.body);
  assert.equal(config.json().patch.supported, true);
  assert.equal(config.json().filter.supported, true);

  const createdResponse = await scim("POST", "/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    externalId: "directory-123",
    userName: "directory.user@example.test",
    displayName: "Directory User",
    emails: [
      {
        value: "directory.user@example.test",
        primary: true,
        type: "work",
      },
    ],
    active: true,
  });
  assert.equal(createdResponse.statusCode, 201, createdResponse.body);
  const created = createdResponse.json();
  assert.equal(created.userName, "directory.user@example.test");
  assert.equal(created.active, true);
  assert.equal(created.externalId, "directory-123");

  const filtered = await scim(
    "GET",
    '/Users?filter=userName%20eq%20%22directory.user%40example.test%22',
  );
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.equal(filtered.json().totalResults, 1);
  assert.equal(filtered.json().Resources[0].id, created.id);

  const managed = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      `SELECT s.user_id,m.role,m.active
       FROM scim_users s
       JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
       WHERE s.id=$1`,
      [created.id],
    ),
  );
  assert.equal(managed.role, "member");
  assert.equal(managed.active, true);

  const tenantToken = await db.tenant(owner.tenant, (q) =>
      createSession(q, owner.tenant, managed.user_id),
    ),
    tenantActor = {
      cookie: `workspace_session=${tenantToken}`,
      csrf: csrf(tenantToken),
    };
  assert.equal((await req("GET", "/me", undefined, tenantActor)).statusCode, 200);

  await db.tenant(other.tenant, async (q) => {
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [other.tenant, managed.user_id],
    );
  });
  const otherToken = await db.tenant(other.tenant, (q) =>
      createSession(q, other.tenant, managed.user_id),
    ),
    otherActor = {
      cookie: `workspace_session=${otherToken}`,
      csrf: csrf(otherToken),
    };
  assert.equal((await req("GET", "/me", undefined, otherActor)).statusCode, 200);

  const deactivated = await scim("PATCH", `/Users/${created.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(deactivated.statusCode, 200, deactivated.body);
  assert.equal(deactivated.json().active, false);

  const primaryState = await db.tenant(owner.tenant, async (q) => ({
    membership: await one(
      q,
      "SELECT active FROM memberships WHERE user_id=$1",
      [managed.user_id],
    ),
    sessions: Number(
      (
        await one(
          q,
          "SELECT count(*) n FROM sessions WHERE tenant_id=$1 AND user_id=$2",
          [owner.tenant, managed.user_id],
        )
      ).n,
    ),
  }));
  assert.equal(primaryState.membership.active, false);
  assert.equal(primaryState.sessions, 0);
  assert.equal(
    await db.system((q) =>
      one(q, "SELECT * FROM session_actor($1)", [hash(tenantToken)]),
    ),
    undefined,
  );

  const otherState = await db.tenant(other.tenant, async (q) => ({
    membership: await one(
      q,
      "SELECT active FROM memberships WHERE user_id=$1",
      [managed.user_id],
    ),
    sessions: Number(
      (
        await one(
          q,
          "SELECT count(*) n FROM sessions WHERE tenant_id=$1 AND user_id=$2",
          [other.tenant, managed.user_id],
        )
      ).n,
    ),
  }));
  assert.equal(otherState.membership.active, true);
  assert.equal(otherState.sessions, 1);

  assert.equal((await req("GET", "/me", undefined, tenantActor)).statusCode, 401);
  assert.equal((await req("GET", "/me", undefined, otherActor)).statusCode, 200);

  const deactivationAudit = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT action FROM audit_events WHERE action='scim.user.deactivated' ORDER BY created_at DESC LIMIT 1",
    ),
  );
  assert.equal(deactivationAudit.action, "scim.user.deactivated");

  const reactivated = await scim("PATCH", `/Users/${created.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { active: true } }],
  });
  assert.equal(reactivated.statusCode, 200, reactivated.body);
  assert.equal(reactivated.json().active, true);

  const freshToken = await db.tenant(owner.tenant, (q) =>
      createSession(q, owner.tenant, managed.user_id),
    ),
    freshActor = {
      cookie: `workspace_session=${freshToken}`,
      csrf: csrf(freshToken),
    };
  assert.equal((await req("GET", "/me", undefined, freshActor)).statusCode, 200);

  const immutable = await scim("PATCH", `/Users/${created.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [
      { op: "replace", path: "userName", value: "changed@example.test" },
    ],
  });
  assert.equal(immutable.statusCode, 400);
  assert.equal(immutable.json().scimType, "mutability");

  const adoptExisting = await scim("POST", "/Users", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "member@example.test",
    emails: [{ value: "member@example.test", primary: true }],
    active: true,
  });
  assert.equal(adoptExisting.statusCode, 409);
  assert.equal(adoptExisting.json().scimType, "uniqueness");

  const types = await scim("GET", "/ResourceTypes");
  assert.equal(types.statusCode, 200, types.body);
  assert.deepEqual(
    types.json().Resources.map((item: any) => item.id).sort(),
    ["Group", "User"],
  );

  const schemas = await scim("GET", "/Schemas");
  assert.equal(schemas.statusCode, 200, schemas.body);
  assert.ok(
    schemas
      .json()
      .Resources.some(
        (item: any) =>
          item.id === "urn:ietf:params:scim:schemas:core:2.0:Group",
      ),
  );

  const invalidGroupMember = await scim("POST", "/Groups", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName: "Manual users are not directory members",
    members: [{ value: member.id }],
  });
  assert.equal(invalidGroupMember.statusCode, 400, invalidGroupMember.body);
  assert.equal(invalidGroupMember.json().scimType, "invalidValue");

  const guestGroupResponse = await scim("POST", "/Groups", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    externalId: "directory-group-guests",
    displayName: "Directory Guests",
    members: [{ value: created.id }],
  });
  assert.equal(guestGroupResponse.statusCode, 201, guestGroupResponse.body);
  const guestGroup = guestGroupResponse.json();
  assert.equal(guestGroup.members.length, 1);
  assert.equal(guestGroup.members[0].value, created.id);

  const filteredGroup = await scim(
    "GET",
    '/Groups?filter=displayName%20eq%20%22Directory%20Guests%22',
  );
  assert.equal(filteredGroup.statusCode, 200, filteredGroup.body);
  assert.equal(filteredGroup.json().totalResults, 1);
  assert.equal(filteredGroup.json().Resources[0].id, guestGroup.id);

  await ok("PATCH", `/scim/groups/${guestGroup.id}/role`, {
    role: "guest",
  });
  let groupedMembership = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, managed.user_id],
    ),
  );
  assert.equal(groupedMembership.role, "guest");
  assert.equal(groupedMembership.active, true);

  const memberGroupResponse = await scim("POST", "/Groups", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    externalId: "directory-group-members",
    displayName: "Directory Members",
    members: [{ value: created.id }],
  });
  assert.equal(memberGroupResponse.statusCode, 201, memberGroupResponse.body);
  const memberGroup = memberGroupResponse.json();
  await ok("PATCH", `/scim/groups/${memberGroup.id}/role`, {
    role: "member",
  });
  groupedMembership = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, managed.user_id],
    ),
  );
  assert.equal(groupedMembership.role, "member");
  assert.equal(groupedMembership.active, true);

  const removeMemberPrecedence = await scim(
    "PATCH",
    `/Groups/${memberGroup.id}`,
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        {
          op: "remove",
          path: `members[value eq "${created.id}"]`,
        },
      ],
    },
  );
  assert.equal(
    removeMemberPrecedence.statusCode,
    200,
    removeMemberPrecedence.body,
  );
  groupedMembership = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, managed.user_id],
    ),
  );
  assert.equal(groupedMembership.role, "guest");
  assert.equal(groupedMembership.active, true);

  await ok("PATCH", `/scim/groups/${guestGroup.id}/role`, { role: null });
  groupedMembership = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, managed.user_id],
    ),
  );
  assert.equal(groupedMembership.role, "member");
  assert.equal(groupedMembership.active, true);

  const groupList = await ok("GET", "/scim/groups");
  const guestGroupAdmin = groupList.find((item: any) => item.id === guestGroup.id);
  assert.equal(guestGroupAdmin.member_count, 1);
  assert.equal(guestGroupAdmin.mapped_role, null);

  const deleteGuestGroup = await scim("DELETE", `/Groups/${guestGroup.id}`);
  assert.equal(deleteGuestGroup.statusCode, 204, deleteGuestGroup.body);
  const deleteMemberGroup = await scim("DELETE", `/Groups/${memberGroup.id}`);
  assert.equal(deleteMemberGroup.statusCode, 204, deleteMemberGroup.body);

  const deleted = await scim("DELETE", `/Users/${created.id}`);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal((await req("GET", "/me", undefined, freshActor)).statusCode, 401);
  assert.equal((await req("GET", "/me", undefined, otherActor)).statusCode, 200);
  assert.equal((await scim("GET", `/Users/${created.id}`)).statusCode, 404);

  const connectorList = await ok("GET", "/scim/connectors");
  assert.ok(connectorList.some((item: any) => item.id === connector.id));
  assert.ok(connectorList.every((item: any) => !("token" in item)));

  await ok("DELETE", `/scim/connectors/${connector.id}`);
  const revoked = await scim("GET", "/ServiceProviderConfig");
  assert.equal(revoked.statusCode, 401);
});

test("OIDC links an existing verified account with browser-bound one-time state", async () => {
  const methods = await ok("GET", "/auth/methods", undefined, null);
  assert.equal(methods.local, true);
  assert.deepEqual(methods.oidc, { enabled: true, label: "Test SSO" });

  oidcProfile = {
    issuer: fakeOidc.issuer,
    subject: "owner-subject",
    email: "owner@example.test",
    name: "Owner",
  };
  const flow = await beginOidc();

  const mismatch = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=test-code&state=${encodeURIComponent(flow.state)}`,
    headers: { cookie: "workspace_oidc_state=wrong-browser-state-value" },
  });
  assert.equal(mismatch.statusCode, 400);

  const actor = await finishOidc(flow);
  const me = await ok("GET", "/me", undefined, actor);
  assert.equal(me.user.email, "owner@example.test");
  assert.equal(me.user.role, "owner");
  assert.equal(me.authentication.oidc.enabled, true);

  const identity = await db.system((q) =>
    one(
      q,
      "SELECT user_id,email FROM oidc_identities WHERE issuer=$1 AND subject=$2",
      [fakeOidc.issuer, "owner-subject"],
    ),
  );
  assert.equal(identity.user_id, owner.id);
  assert.equal(identity.email, "owner@example.test");

  const replay = await app.inject({
    method: "GET",
    url: `/api/v1/auth/oidc/callback?code=test-code&state=${encodeURIComponent(flow.state)}`,
    headers: { cookie: flow.cookie },
  });
  assert.equal(replay.statusCode, 400);
});

test("organisation switching cannot downgrade an OIDC session to unbound local credentials", async () => {
  oidcProfile = {
    issuer: fakeOidc.issuer,
    subject: "owner-subject",
    email: "owner@example.test",
    name: "Owner",
    sid: "switch-bound-idp-session",
  };
  const sso = await finishOidc(await beginOidc());
  const origin = await ok("GET", "/me", undefined, sso);
  const targetTenant =
    origin.organisation.id === owner.tenant ? other.tenant : owner.tenant;
  const denied = await req(
    "POST",
    "/auth/switch",
    { tenant_id: targetTenant },
    sso,
  );
  assert.equal(denied.statusCode, 403, denied.body);
  assert.match(denied.body, /SSO sessions cannot switch organisations/);
  const stillAuthenticated = await ok("GET", "/me", undefined, sso);
  assert.equal(stillAuthenticated.organisation.id, origin.organisation.id);
  const oidcSource = await db.tenant(origin.organisation.id, (q) =>
    one(
      q,
      "SELECT oidc_issuer,oidc_subject,oidc_sid FROM sessions WHERE token_hash=$1",
      [hash(sso.cookie.split("=")[1])],
    ),
  );
  assert.equal(oidcSource.oidc_issuer, fakeOidc.issuer);
  assert.equal(oidcSource.oidc_subject, "owner-subject");
  assert.equal(oidcSource.oidc_sid, "switch-bound-idp-session");

  // Independently authenticated local sessions retain supported switching.
  const localToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, owner.id),
  );
  const local = {
    cookie: "workspace_session=" + localToken,
    csrf: csrf(localToken),
  };
  const switched = await req(
    "POST",
    "/auth/switch",
    { tenant_id: other.tenant },
    local,
  );
  assert.equal(switched.statusCode, 200, switched.body);
  const destination = session(switched);
  assert.equal(
    (await ok("GET", "/me", undefined, destination)).organisation.id,
    other.tenant,
  );
  assert.equal(
    (await req("GET", "/me", undefined, local)).statusCode,
    401,
  );
});

test("OIDC back-channel logout revokes OIDC sessions but preserves local break-glass session", async () => {
  oidcProfile = {
    issuer: fakeOidc.issuer,
    subject: "owner-subject",
    email: "owner@example.test",
    name: "Owner",
    sid: "owner-idp-session",
  };
  const actor = await finishOidc(await beginOidc());
  assert.equal((await req("GET", "/me", undefined, actor)).statusCode, 200);

  oidcLogout = {
    issuer: fakeOidc.issuer,
    subject: "owner-subject",
    sid: "owner-idp-session",
    jti: `logout-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 300000),
  };
  const payload = new URLSearchParams({
    logout_token: "signed-test-logout-token-placeholder",
  }).toString();
  const logout = await app.inject({
    method: "POST",
    url: "/api/v1/auth/oidc/backchannel-logout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload,
  });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.equal(logout.json().revoked, 1);
  const logoutAudit = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT action FROM audit_events WHERE action='auth.oidc_backchannel_logout' ORDER BY created_at DESC LIMIT 1",
    ),
  );
  assert.equal(logoutAudit.action, "auth.oidc_backchannel_logout");
  assert.equal((await req("GET", "/me", undefined, actor)).statusCode, 401);
  assert.equal((await req("GET", "/me", undefined, owner)).statusCode, 200);

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/oidc/backchannel-logout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().revoked, 0);
});

test("OIDC can consume a matching invitation without creating a local password", async () => {
  const invitation = await ok("POST", "/members/invite", {
      name: "SSO Member",
      email: "sso-new@example.test",
      role: "member",
    }),
    invitationToken = new URL(invitation.url).searchParams.get("invite")!;
  oidcProfile = {
    issuer: fakeOidc.issuer,
    subject: "sso-new-subject",
    email: "sso-new@example.test",
    name: "SSO Member",
  };

  const actor = await finishOidc(await beginOidc(invitationToken)),
    me = await ok("GET", "/me", undefined, actor);
  assert.equal(me.user.email, "sso-new@example.test");
  assert.equal(me.user.role, "member");

  const provisioned = await db.system((q) =>
    one(
      q,
      "SELECT u.id,u.password_hash,i.subject FROM users u JOIN oidc_identities i ON i.user_id=u.id WHERE u.email=$1",
      ["sso-new@example.test"],
    ),
  );
  assert.equal(provisioned.password_hash, null);
  assert.equal(provisioned.subject, "sso-new-subject");
  assert.equal(
    await db.system(async (q) =>
      Number(
        (
          await one(
            q,
            "SELECT count(*) n FROM invitations WHERE token_hash=$1",
            [hash(invitationToken)],
          )
        ).n,
      ),
    ),
    0,
  );
});

test("OIDC invitation provisioning requires the verified identity email to match", async () => {
  const invitation = await ok("POST", "/members/invite", {
      name: "Mismatch",
      email: "expected-sso@example.test",
      role: "member",
    }),
    invitationToken = new URL(invitation.url).searchParams.get("invite")!;
  oidcProfile = {
    issuer: fakeOidc.issuer,
    subject: "mismatch-subject",
    email: "different-sso@example.test",
    name: "Mismatch",
  };
  const flow = await beginOidc(invitationToken),
    response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/oidc/callback?code=test-code&state=${encodeURIComponent(flow.state)}`,
      headers: { cookie: flow.cookie },
    });
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /does not match the invitation/);
  assert.equal(
    await db.tenant(owner.tenant, async (q) =>
      Number(
        (
          await one(
            q,
            "SELECT count(*) n FROM invitations WHERE token_hash=$1",
            [hash(invitationToken)],
          )
        ).n,
      ),
    ),
    1,
  );
});

test("calendar saved views filter month dates and reject invalid date bindings", async () => {
  const calendarDb = await ok("POST", "/resources", {
    kind: "database",
    title: "Calendar regression",
    parent_id: space.id,
  });
  await ok("PATCH", "/databases/" + calendarDb.id, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "due", name: "Due date", type: "date" },
    ],
  });
  for (const [name, due] of [
    ["February", "2026-02-28"],
    ["March first", "2026-03-01"],
    ["March last", "2026-03-31"],
    ["April", "2026-04-01"],
  ]) {
    await ok("POST", "/databases/" + calendarDb.id + "/records", {
      values: { name, due },
    });
  }
  const path = "/databases/" + calendarDb.id + "/views";
  const bad = await req("POST", path, {
    name: "Invalid calendar",
    config: { type: "calendar", dateBy: "name" },
  });
  assert.equal(bad.statusCode, 400, bad.body);
  const missing = await req("POST", path, {
    name: "No date field",
    config: { type: "calendar" },
  });
  assert.equal(missing.statusCode, 400, missing.body);
  const view = await ok("POST", path, {
    name: "Due-date calendar",
    config: { type: "calendar", dateBy: "due" },
  });
  const recordsPath = "/databases/" + calendarDb.id + "/records?view=" + view.id;
  const march = await ok("GET", recordsPath + "&month=2026-03");
  assert.deepEqual(
    march.map((row: any) => row.title).sort(),
    ["March first", "March last"],
  );
  assert.deepEqual(
    (await ok("GET", recordsPath + "&month=2026-02"))
      .map((row: any) => row.title),
    ["February"],
  );
  assert.deepEqual(
    (await ok("GET", recordsPath + "&month=2026-04"))
      .map((row: any) => row.title),
    ["April"],
  );
  for (const invalid of [
    recordsPath,
    recordsPath + "&month=2026-13",
    recordsPath + "&month=2026-00",
    recordsPath + "&month=2026-03%20junk",
  ]) {
    const response = await req("GET", invalid);
    assert.equal(response.statusCode, 400, response.body);
  }
  const tableView = (await ok("GET", "/databases/" + calendarDb.id)).views
    .find((v: any) => v.config.type === "table");
  assert.ok(tableView);
  const nonCalendarMonth = await req(
    "GET",
    "/databases/" + calendarDb.id + "/records?view=" + tableView.id +
      "&month=2026-03",
  );
  assert.equal(nonCalendarMonth.statusCode, 400, nonCalendarMonth.body);
  assert.equal(
    (await ok("GET", "/databases/" + calendarDb.id + "/records?view=" + tableView.id))
      .length,
    4,
  );
});

test("setup is one-time and writes require CSRF", async () => {
  assert.equal(
    (
      await req(
        "POST",
        "/setup",
        {
          organisation: "X",
          workspace: "X",
          name: "X",
          email: "x@test.co",
          password: "long-password-1",
        },
        null,
        { "x-setup-token": "test-setup-token" },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req("PATCH", `/resources/${page.id}`, { title: "No" }, owner, {
        "x-csrf-token": "",
      })
    ).statusCode,
    403,
  );
});
test("OpenAPI publishes machine-readable integration contracts", async () => {
  const response = await app.inject({ method: "GET", url: "/api/docs/json" });
  assert.equal(response.statusCode, 200, response.body);
  const spec = response.json();
  assert.equal(spec.openapi, "3.0.3");
  const pageContent = spec.paths["/api/v1/pages/{id}/content"];
  assert.equal(pageContent.get.parameters[0].schema.format, "uuid");
  assert.deepEqual(
    pageContent.patch.requestBody.content["application/json"].schema.required,
    ["blocks", "expected_revision"],
  );
  const permissionCheck =
    spec.paths["/api/v1/resources/{id}/permissions/check"].get;
  assert.ok(
    permissionCheck.parameters.some(
      (p: any) => p.name === "user_id" && p.required === true,
    ),
  );
  const imports = spec.paths["/api/v1/imports"].post;
  assert.deepEqual(
    imports.requestBody.content["application/json"].schema.required,
    ["parent_id", "format", "name", "content"],
  );
  assert.equal(
    spec.paths["/api/v1/events"].get.responses["200"].content[
      "application/json"
    ].schema.type,
    "array",
  );
  const backlinksSpec = spec.paths["/api/v1/resources/{id}/backlinks"].get;
  assert.equal(backlinksSpec.responses["200"].content["application/json"]
    .schema.type, "array");
  assert.equal(backlinksSpec.responses["200"].content["application/json"]
    .schema.maxItems, 40);
  const cursorSpec = spec.paths["/api/v1/events/cursor"].get;
  assert.deepEqual(
    cursorSpec.responses["200"].content["application/json"].schema.required,
    ["events", "next_cursor", "has_more"],
  );
  const prepared = spec.paths["/api/v1/webhooks/{id}/secret-rotation"].post;
  assert.deepEqual(prepared.requestBody.content["application/json"].schema.required, ["expected_revision"]);
  assert.ok(prepared.responses["200"].content["application/json"].schema.properties.secret);
  const activated = spec.paths["/api/v1/webhooks/{id}/secret-rotation/activate"].post;
  assert.equal(activated.responses["200"].content["application/json"].schema.properties.secret, undefined);
});

test("native row-level policies and known IDs isolate tenants", async () => {
  assert.equal(
    (await req("GET", `/resources/${page.id}`, undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (
      await db.tenant(other.tenant, (q) =>
        q.query("SELECT * FROM resources WHERE id=$1", [page.id]),
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await req("GET", `/resources/${page.id}`, undefined, guest)).statusCode,
    404,
  );
  assert.equal(
    (await req("POST", `/pages/${page.id}/collab`, {}, other)).statusCode,
    404,
  );
});
test("tree moves reject cycles and invalid parent types", async () => {
  const child = await ok("POST", "/resources", {
    kind: "page",
    parent_id: page.id,
    title: "Nested",
  });
  assert.equal(
    (await req("PATCH", `/resources/${page.id}`, { parent_id: child.id }))
      .statusCode,
    400,
  );
  assert.equal(
    (await req("PATCH", `/resources/${space.id}`, { parent_id: page.id }))
      .statusCode,
    400,
  );
});
test("canonical replacement, body search, versions and restore", async () => {
  await ok("PATCH", `/pages/${page.id}/content`, {
    blocks: [{ type: "paragraph", content: "Unique body evidence Orion" }],
    expected_revision: 1,
  });
  assert(
    (await ok("GET", "/search?q=Orion")).some((x: any) => x.id === page.id),
  );
  assert.equal(
    (
      await req("PATCH", `/pages/${page.id}/content`, {
        blocks: [],
        expected_revision: 1,
      })
    ).statusCode,
    409,
  );
  const versions = await ok("GET", `/pages/${page.id}/versions`);
  await ok("POST", `/pages/${page.id}/versions/${versions[0].id}/restore`, {
    expected_revision: 2,
  });
  assert.equal((await ok("GET", `/pages/${page.id}/content`)).epoch, 3);
});
test("page backlinks use live canonical links and never reveal restricted sources", async () => {
  // Preserve full production Fastify rate limits, with an independent
  // disposable instance so this test never exhausts another test's budget.
  const linksApp = await buildApp(db, undefined, false, fakeOidc, fakeAntivirus);
  const linkReq = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string, data?: any, actor: any = owner,
  ): Promise<{ statusCode: number; body: string; json: () => any }> =>
    linksApp.inject({
      method,
      url: "/api/v1" + path,
      headers: {
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { payload: data }),
    });
  const linkOk = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string, data?: any, actor: any = owner,
  ) => {
    const response = await linkReq(method, path, data, actor);
    assert.ok(response.statusCode < 300,
      `${method} ${path}: ${response.statusCode} ${response.body}`);
    return response.json();
  };
  try {
  const target = await linkOk("POST", "/resources", {
    kind: "page", parent_id: space.id, title: "Link target",
  });
  const source = await linkOk("POST", "/resources", {
    kind: "page", parent_id: space.id, title: "Accessible source",
  });
  const privateSource = await linkOk("POST", "/resources", {
    kind: "page", parent_id: space.id, title: "Secret referencing source",
  });
  const textOnly = await linkOk("POST", "/resources", {
    kind: "page", parent_id: space.id, title: "Plain mention source",
  });
  const external = await linkOk("POST", "/resources", {
    kind: "page", parent_id: space.id, title: "External URL source",
  });
  const link = { type: "link", href: "/?page=" + target.id,
    content: [{ type: "text", text: "Linked page", styles: {} }] };
  for (const src of [source, privateSource]) {
    await linkOk("PATCH", `/pages/${src.id}/content`, {
      blocks: [{ type: "paragraph", content: [link] }],
      expected_revision: 1,
    });
  }
  await linkOk("PATCH", `/pages/${textOnly.id}/content`, {
    blocks: [{ type: "paragraph", content: "Plain mention /?page=" + target.id }],
    expected_revision: 1,
  });
  await linkOk("PATCH", `/pages/${external.id}/content`, {
    blocks: [{ type: "paragraph", content: [{
      type: "link",
      href: "https://external.example.test/?page=" + target.id,
      content: "Not a Workspace reference",
    }] }],
    expected_revision: 1,
  });
  const ownerBacklinks = await linkOk("GET", `/resources/${target.id}/backlinks`);
  assert.deepEqual(
    ownerBacklinks.map((x: any) => x.id).sort(),
    [source.id, privateSource.id].sort(),
  );
  const policy = await linkOk("GET",
    `/resources/${privateSource.id}/permissions`);
  await linkOk("PATCH", `/resources/${privateSource.id}/permissions`, {
    inherit: false, grants: [], expected_revision: policy.revision,
  });
  const memberBacklinks = await linkOk("GET", `/resources/${target.id}/backlinks`,
    undefined, member);
  assert.deepEqual(memberBacklinks.map((x: any) => x.id), [source.id]);
  assert.doesNotMatch(JSON.stringify(memberBacklinks), /Secret referencing source/);
  assert.equal((await linkReq("GET",
    `/resources/${target.id}/backlinks`, undefined, guest)).statusCode, 404);
  assert.equal((await linkReq("GET",
    `/resources/${target.id}/backlinks`, undefined, other)).statusCode, 404);
  assert.equal((await linkReq("GET",
    `/resources/${randomUUID()}/backlinks`)).statusCode, 404);
  assert.equal((await linkReq("GET",
    `/resources/${space.id}/backlinks`)).statusCode, 404);
  // Removing a link immediately removes the backlink on the next read.
  await linkOk("PATCH", `/pages/${source.id}/content`, {
    blocks: [{ type: "paragraph", content: "Link removed" }],
    expected_revision: 2,
  });
  const after = await linkOk("GET", `/resources/${target.id}/backlinks`,
    undefined, member);
  assert.deepEqual(after, []);
  } finally {
    await linksApp.close();
  }
});
test("typed records, optimistic concurrency, saved filters and full bodies", async () => {
  database = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "Delivery",
    template: "tasks",
  });
  record = await ok("POST", `/databases/${database.id}/records`, {
    values: {
      name: "Ship product",
      status: "Not started",
      priority: "High",
      assignee: member.id,
    },
  });
  record = await ok("PATCH", `/records/${record.id}`, {
    values: { status: "In progress" },
    expected_revision: 1,
  });
  assert.equal(
    (
      await req("PATCH", `/records/${record.id}`, {
        values: { status: "Done" },
        expected_revision: 1,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req("PATCH", `/records/${record.id}`, {
        values: { due: "bad" },
        expected_revision: 2,
      })
    ).statusCode,
    400,
  );
  const v = await ok("POST", `/databases/${database.id}/views`, {
    name: "Active",
    config: {
      type: "board",
      groupBy: "status",
      filters: [{ property: "status", op: "eq", value: "In progress" }],
    },
  });
  assert.equal(
    (await ok("GET", `/databases/${database.id}/records?view=${v.id}`)).length,
    1,
  );
  assert.equal((await ok("GET", `/pages/${record.id}/content`)).revision, 1);
  assert.equal(
    (await req("GET", `/records/${record.id}`, undefined, other)).statusCode,
    404,
  );
});
test("two Yjs clients converge, persist canonical text, and reconnect", async () => {
  const a = await connect(),
    b = await connect(member);
  a.doc.getMap("test").set("one", "first");
  b.doc.getMap("test").set("two", "second");
  const fragment = a.doc.getXmlFragment("document");
  function find(v: any): any {
    if (v instanceof Y.XmlText) return v;
    for (const child of v.toArray?.() || []) {
      const f = find(child);
      if (f) return f;
    }
  }
  let text = find(fragment);
  if (!text) {
    function paragraph(v: any): any {
      if (v.nodeName === "paragraph") return v;
      for (const child of v.toArray?.() || []) {
        const found = paragraph(child);
        if (found) return found;
      }
    }
    const p = paragraph(fragment);
    assert(p);
    text = new Y.XmlText();
    p.insert(0, [text]);
  }
  text.insert(0, "Live collaboration evidence");
  await until(
    () =>
      a.doc.getMap("test").get("two") === "second" &&
      b.doc.getMap("test").get("one") === "first",
  );
  await until(async () =>
    (await ok("GET", `/pages/${page.id}/content`)).plain_text.includes(
      "Live collaboration evidence",
    ),
  );
  a.provider.destroy();
  b.provider.destroy();
  const c = await connect();
  assert.equal(c.doc.getMap("test").get("two"), "second");
  c.provider.destroy();
});
test("comments create mentions and block unauthorized moderation", async () => {
  const c = await ok("POST", `/resources/${page.id}/comments`, {
    body: `Please review @{${member.id}}`,
  });
  assert.equal(
    (await ok("GET", "/notifications", undefined, member)).length,
    1,
  );
  assert.equal(
    (
      await req(
        "PATCH",
        `/resources/${page.id}/comments/${c.id}`,
        { body: "changed" },
        member,
      )
    ).statusCode,
    403,
  );
  await ok(
    "PATCH",
    `/resources/${page.id}/comments/${c.id}`,
    { resolved: true },
    member,
  );
});
test("malware scanning blocks infected uploads before storage and fails closed when unavailable", async () => {
  const upload = async (content: string, filename = "scan.txt") => {
    const boundary = `----workspace-scan-${randomUUID()}`,
      data = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return req("POST", `/resources/${page.id}/files`, data, owner, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
  };
  const before = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT count(*)::int AS count FROM files WHERE resource_id=$1", [
      page.id,
    ]),
  );
  const storedBefore = await storedFiles(dir);

  antivirusResult = { status: "infected", signature: "Eicar-Signature" };
  const infected = await upload("infected test payload");
  assert.equal(infected.statusCode, 422, infected.body);
  assert.match(infected.body, /File rejected by malware scanner/);

  let after = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT count(*)::int AS count FROM files WHERE resource_id=$1", [
      page.id,
    ]),
  );
  assert.equal(after.rows[0].count, before.rows[0].count);
  assert.deepEqual(await storedFiles(dir), storedBefore);
  const blockedAudit = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT action FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action='file.malware_blocked' ORDER BY created_at DESC LIMIT 1",
      [owner.tenant, page.id],
    ),
  );
  assert.equal(blockedAudit.action, "file.malware_blocked");

  antivirusUnavailable = true;
  const unavailable = await upload("scanner unavailable payload");
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.match(unavailable.body, /Internal error/);
  assert.doesNotMatch(unavailable.body, /scanner/i);
  after = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT count(*)::int AS count FROM files WHERE resource_id=$1", [
      page.id,
    ]),
  );
  assert.equal(after.rows[0].count, before.rows[0].count);
  assert.deepEqual(await storedFiles(dir), storedBefore);

  antivirusUnavailable = false;
  antivirusResult = { status: "clean" };
});

test("private uploads validate type and authorize parent on every download", async () => {
  const boundary = "test-boundary";
  const data = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\nPrivate evidence\r\n--${boundary}--\r\n`;
  const r = await req("POST", `/resources/${page.id}/files`, data, owner, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(r.statusCode, 200, r.body);
  file = r.json();
  const downloaded = await req("GET", `/files/${file.id}/content`);
  assert.equal(downloaded.body, "Private evidence");
  assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
  assert.match(
    String(downloaded.headers["content-security-policy"]),
    /default-src 'none'; sandbox/,
  );
  assert.match(
    String(downloaded.headers["content-disposition"]),
    /^attachment;/,
  );
  assert.equal(
    (await req("GET", `/files/${file.id}/content`, undefined, other))
      .statusCode,
    404,
  );
  assert.equal(
    (await req("GET", `/files/${file.id}/content`, undefined, guest))
      .statusCode,
    404,
  );
});
test("live permission changes update editability, and ancestor revocation removes API, search, file and live access", async () => {
  const c = await connect(member);
  let reset = false;
  const permissions: boolean[] = [];
  c.provider.on("stateless", ({ payload }: any) => {
    const event = JSON.parse(payload);
    if (event.type === "reset") reset = true;
    if (event.type === "permission") permissions.push(event.readOnly);
  });
  await permissionPatch(`/resources/${space.id}/permissions`, {
    inherit: true,
    grants: [{ principal_id: member.id, level: 1 }],
  });
  await until(() => permissions.at(-1) === true);
  assert.equal(
    (await ok("POST", `/pages/${page.id}/collab`, {}, member)).readOnly,
    true,
  );
  assert.equal(
    (
      await req(
        "POST",
        `/resources/${page.id}/comments`,
        { body: "Blocked viewer comment" },
        member,
      )
    ).statusCode,
    403,
  );
  await permissionPatch(`/resources/${space.id}/permissions`, {
    inherit: true,
    grants: [],
  });
  await until(() => permissions.at(-1) === false);
  await permissionPatch(`/resources/${space.id}/permissions`, {
    inherit: false,
    grants: [],
  });
  await until(() => reset);
  assert.equal(
    (await req("GET", `/pages/${page.id}/content`, undefined, member))
      .statusCode,
    404,
  );
  assert.equal(
    (await req("GET", `/files/${file.id}/content`, undefined, member))
      .statusCode,
    404,
  );
  assert.equal(
    (await ok("GET", "/search?q=Live", undefined, member)).length,
    0,
  );
  assert.equal(
    (await req("GET", `/records/${record.id}`, undefined, member)).statusCode,
    404,
  );
  c.provider.destroy();
  await permissionPatch(`/resources/${space.id}/permissions`, {
    inherit: true,
    grants: [],
  });
});
test("ACL writes reject stale, duplicate and cross-tenant grants and serialize concurrent saves", async () => {
  const path = `/resources/${space.id}/permissions`;
  const current = await ok("GET", path);
  assert.ok(current.revision >= 1);

  const duplicate = await req("PATCH", path, {
    inherit: true,
    expected_revision: current.revision,
    grants: [
      { principal_id: member.id, level: 1 },
      { principal_id: member.id, level: 3 },
    ],
  });
  assert.equal(duplicate.statusCode, 400);

  const crossTenant = await req("PATCH", path, {
    inherit: true,
    expected_revision: current.revision,
    grants: [{ principal_id: other.id, level: 1 }],
  });
  assert.equal(crossTenant.statusCode, 400);

  const [a, b] = await Promise.all([
    req("PATCH", path, {
      inherit: true,
      expected_revision: current.revision,
      grants: [{ principal_id: member.id, level: 1 }],
    }),
    req("PATCH", path, {
      inherit: true,
      expected_revision: current.revision,
      grants: [{ principal_id: member.id, level: 3 }],
    }),
  ]);
  assert.deepEqual(
    [a.statusCode, b.statusCode].sort((x, y) => x - y),
    [200, 409],
  );

  const after = await ok("GET", path);
  assert.equal(after.revision, current.revision + 1);
  assert.equal(
    (
      await req("PATCH", path, {
        inherit: true,
        expected_revision: current.revision,
        grants: [],
      })
    ).statusCode,
    409,
  );

  await permissionPatch(path, { inherit: true, grants: [] });
});

test("operational status is admin-only and reports queue health", async () => {
  const status = await ok("GET", "/operations/status");
  assert.equal(typeof status.attention_required, "boolean");
  assert.equal(typeof status.generated_at, "string");
  for (const queue of [
    status.queues.imports,
    status.queues.webhooks,
    status.queues.object_deletions,
    status.queues.events,
  ])
    assert.equal(typeof queue.pending, "number");

  assert.equal(
    (await req("GET", "/operations/status", undefined, guest)).statusCode,
    403,
  );

  const dead = randomUUID();
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO object_deletions(id,tenant_id,object_key,reason,status) VALUES($1,$2,$3,'upload_rollback','dead')",
      [dead, owner.tenant, `health/${dead}`],
    ),
  );
  const attention = await ok("GET", "/operations/status");
  assert.equal(attention.attention_required, true);
  assert.ok(attention.queues.object_deletions.dead >= 1);
  await db.tenant(owner.tenant, (q) =>
    q.query("DELETE FROM object_deletions WHERE id=$1", [dead]),
  );
});

test("audit export is admin-only, bounded/filterable and spreadsheet safe", async () => {
  const adminExport = await req("GET", "/audit/export?limit=25");
  assert.equal(adminExport.statusCode, 200, adminExport.body);
  assert.match(adminExport.headers["content-type"], /text\/csv/);
  assert.match(adminExport.body, /id,action,actor,resource_id,request_id,created_at/);

  const filtered = await req(
    "GET",
    "/audit/export?action=permission.updated&limit=25",
  );
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.match(filtered.body, /permission.updated/);

  assert.equal(
    (await req("GET", "/audit/export?limit=25", undefined, guest)).statusCode,
    403,
  );

  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE users SET name='=2+2' WHERE id=$1", [owner.id]),
  );
  const formulaSafe = await req("GET", "/audit/export?limit=25");
  assert.match(formulaSafe.body, /'=2\+2/);
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE users SET name='Owner' WHERE id=$1", [owner.id]),
  );
});

test("service principals default to no access and read scopes cannot write", async () => {
  service = await ok("POST", "/integrations", { name: "Intelligence" });
  const s = { cookie: "", csrf: "" };
  const bearer = { authorization: `Bearer ${service.token}` };
  assert.equal(
    (await req("GET", `/pages/${page.id}/content`, undefined, s, bearer))
      .statusCode,
    404,
  );
  await permissionPatch(`/resources/${root.id}/permissions`, {
    inherit: true,
    grants: [{ principal_id: service.principal_id, level: 1 }],
  });
  assert.equal(
    (await req("GET", `/pages/${page.id}/content`, undefined, s, bearer))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await req(
        "PATCH",
        `/pages/${page.id}/content`,
        { blocks: [], expected_revision: 1 },
        s,
        bearer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req("GET", `/pages/${page.id}/content`, undefined, {
        cookie: `workspace_session=${service.token}`,
        csrf: "",
      })
    ).statusCode,
    401,
  );
});
test("outbox dispatch signs webhooks and records retries without following redirects", async () => {
  let received: any,
    redirectTargetHit = false;
  const receiver = createServer((r, res) => {
      let body = "";
      r.on("data", (b) => (body += b));
      r.on("end", () => {
        received = { body, headers: r.headers };
        res.end("ok");
      });
    }),
    redirect = createServer((_r, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:49663/metadata" });
      res.end();
    }),
    redirectTarget = createServer((_r, res) => {
      redirectTargetHit = true;
      res.end("unexpected");
    });
  await Promise.all([
    new Promise<void>((r) => receiver.listen(49661, "127.0.0.1", r)),
    new Promise<void>((r) => redirect.listen(49662, "127.0.0.1", r)),
    new Promise<void>((r) => redirectTarget.listen(49663, "127.0.0.1", r)),
  ]);
  process.env.WEBHOOK_ALLOWED_ORIGINS =
    "http://127.0.0.1:49661,http://127.0.0.1:49662";
  try {
    assert.equal(
      (
        await req("POST", "/webhooks", {
          url: "http://169.254.169.254/latest",
          events: ["page.updated"],
        })
      ).statusCode,
      400,
    );
    const h = await ok("POST", "/webhooks", {
      url: "http://127.0.0.1:49661/events",
      events: ["page.updated"],
    });
    await ok("POST", "/webhooks", {
      url: "http://127.0.0.1:49662/events",
      events: ["page.updated"],
    });
    await ok("PATCH", `/resources/${page.id}`, { title: "Live design" });
    await tick(db);
    assert(received);
    assert.equal(
      received.headers["x-workspace-signature"],
      `sha256=${signature(h.secret, received.headers["x-workspace-timestamp"], received.body)}`,
    );
    const deliveries = (await ok("GET", "/webhooks")).deliveries;
    assert(
      deliveries.some((d: any) => d.status === "retry"),
    );
    assert.equal(redirectTargetHit, false);
  } finally {
    receiver.close();
    redirect.close();
    redirectTarget.close();
  }
});
test("dead webhook deliveries can be replayed only by same-tenant administrators", async () => {
  process.env.WEBHOOK_ALLOWED_ORIGINS = "http://127.0.0.1:49661";
  const subscription = await ok("POST", "/webhooks", {
    url: "http://127.0.0.1:49661/recovery",
    events: ["page.updated"],
  });
  await ok("PATCH", `/resources/${page.id}`, {
    title: "Replay acceptance " + randomUUID().slice(0, 8),
  });
  const event = await db.tenant(owner.tenant, (q) =>
    one(q,
      "SELECT id FROM event_outbox WHERE tenant_id=$1 AND resource_id=$2" +
        " AND type='page.updated' ORDER BY created_at DESC,id DESC LIMIT 1",
      [owner.tenant, page.id],
    ),
  );
  assert.ok(event?.id);
  const deliveryId = randomUUID();
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO webhook_deliveries" +
        "(id,tenant_id,subscription_id,event_id,status,attempts,last_error)" +
        " VALUES($1,$2,$3,$4,'dead',8,'HTTP 503')",
      [deliveryId, owner.tenant, subscription.id, event.id],
    ),
  );
  const endpoint = `/webhooks/deliveries/${deliveryId}/replay`;
  assert.equal((await req("POST", endpoint, {}, member)).statusCode, 403);
  assert.equal((await req("POST", endpoint, {}, other)).statusCode, 404);
  assert.equal((await req("POST", "/webhooks/deliveries/not-a-uuid/replay", {})).statusCode, 400);
  const initial = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT status,attempts,last_error FROM webhook_deliveries WHERE id=$1", [deliveryId]),
  );
  assert.deepEqual([initial.status, initial.attempts, initial.last_error],
    ["dead", 8, "HTTP 503"]);
  const replay = await ok("POST", endpoint, {});
  assert.deepEqual(replay, { ok: true, id: deliveryId, status: "pending" });
  assert.equal((await req("POST", endpoint, {})).statusCode, 404);
  const resumed = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT status,attempts,last_error FROM webhook_deliveries WHERE id=$1", [deliveryId]),
  );
  assert.deepEqual([resumed.status, resumed.attempts, resumed.last_error],
    ["pending", 0, null]);
  const audit = await db.tenant(owner.tenant, (q) =>
    one(q,
      "SELECT action FROM audit_events WHERE actor_id=$1" +
        " AND action='integration.delivery_replayed' ORDER BY created_at DESC LIMIT 1",
      [owner.id],
    ),
  );
  assert.equal(audit?.action, "integration.delivery_replayed");

  // A paused subscription must not be reactivated through delivery replay.
  await ok("PATCH", `/webhooks/${subscription.id}`, { active: false });
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE webhook_deliveries SET status='dead' WHERE id=$1", [deliveryId]),
  );
  assert.equal((await req("POST", endpoint, {})).statusCode, 404);
});

test("webhook signing rotation is staged, tenant-scoped, revision-checked and used by delivery/replay", async () => {
  const received: { body: string; headers: any }[] = [];
  let holdResponse = false,
    releaseResponse = () => {},
    requestArrived = () => {};
  const receiver = createServer(async (r, res) => {
    let body = "";
    for await (const chunk of r) body += chunk;
    received.push({ body, headers: r.headers });
    requestArrived();
    if (holdResponse)
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
    res.end("ok");
  });
  await new Promise<void>((resolve) =>
    receiver.listen(49711, "127.0.0.1", resolve),
  );
  process.env.WEBHOOK_ALLOWED_ORIGINS = "http://127.0.0.1:49711";
  try {
    const subscription = await ok("POST", "/webhooks", {
      url: "http://127.0.0.1:49711/rotation",
      events: ["page.rotation_test"],
    });
    const endpoint = `/webhooks/${subscription.id}/secret-rotation`;
    const precondition = { expected_revision: 1 };
    assert.equal(
      (await req("POST", endpoint, precondition, member)).statusCode,
      403,
    );
    assert.equal(
      (await req("POST", endpoint, precondition, other)).statusCode,
      404,
    );
    assert.equal(
      (
        await req("POST", endpoint, precondition, owner, {
          "x-csrf-token": "wrong",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await req("POST", endpoint, { expected_revision: 0 })).statusCode,
      400,
    );
    const serviceToken = await ok("POST", "/integrations", {
      name: "Rotation reader",
      scopes: ["events.read"],
    });
    assert.equal(
      (
        await req("POST", endpoint, precondition, null, {
          authorization: `Bearer ${serviceToken.token}`,
        })
      ).statusCode,
      403,
    );
    const attempts = await Promise.all([
      req("POST", endpoint, precondition),
      req("POST", endpoint, precondition),
    ]);
    assert.deepEqual(attempts.map((r) => r.statusCode).sort(), [200, 409]);
    const prepared = attempts.find((r) => r.statusCode === 200)!.json();
    assert.equal(prepared.signing_revision, 2);
    assert.notEqual(prepared.secret, subscription.secret);
    const listing = await ok("GET", "/webhooks");
    assert.equal(
      listing.subscriptions.find((s: any) => s.id === subscription.id)
        .rotation_pending,
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(listing),
      new RegExp(`${prepared.secret}|${subscription.secret}|secret_encrypted`),
    );
    const stored = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT secret_encrypted,pending_secret_encrypted FROM webhook_subscriptions WHERE id=$1",
        [subscription.id],
      ),
    );
    assert.equal(decrypt(stored.secret_encrypted), subscription.secret);
    assert.equal(decrypt(stored.pending_secret_encrypted), prepared.secret);

    const eventId = randomUUID(),
      deliveryId = randomUUID();
    await db.tenant(owner.tenant, async (q) => {
      await q.query(
        "INSERT INTO event_outbox(id,tenant_id,actor_id,type,resource_id,version,dispatched_at) VALUES($1,$2,$3,'page.rotation_test',$4,1,now())",
        [eventId, owner.tenant, owner.id, page.id],
      );
      await q.query(
        "INSERT INTO webhook_deliveries(id,tenant_id,subscription_id,event_id) VALUES($1,$2,$3,$4)",
        [deliveryId, owner.tenant, subscription.id, eventId],
      );
    });
    const verify = (secret: string) => {
      const message = received.findLast(
        (r) => r.headers["x-workspace-event"] === eventId,
      )!;
      assert.ok(message);
      assert.equal(message.headers["x-workspace-event"], eventId);
      assert.equal(
        message.headers["x-workspace-signature"],
        `sha256=${signature(secret, message.headers["x-workspace-timestamp"], message.body)}`,
      );
    };
    // Preparing must not change the signature of subsequent delivery.
    await tick(db);
    assert.ok(received.length > 0);
    verify(subscription.secret);
    const activate = endpoint + "/activate";
    assert.equal((await req("POST", activate, precondition)).statusCode, 409);
    assert.equal(
      (await req("POST", activate, { expected_revision: 2 }, other)).statusCode,
      404,
    );

    if (!pg.emulated) {
      // Native CI also proves activation cannot race a delivery using the old
      // secret: the worker's read lock lasts until its HTTP send commits.
      await db.tenant(owner.tenant, (q) =>
        q.query(
          "UPDATE webhook_deliveries SET status='pending',next_at=now() WHERE id=$1",
          [deliveryId],
        ),
      );
      holdResponse = true;
      const arrived = new Promise<void>((resolve) => {
        requestArrived = resolve;
      });
      const dispatch = tick(db);
      await arrived;
      let activationFinished = false;
      const activationRequest = req("POST", activate, {
        expected_revision: 2,
      }).then((r) => {
        activationFinished = true;
        return r;
      });
      await pause(100);
      assert.equal(activationFinished, false);
      holdResponse = false;
      releaseResponse();
      await dispatch;
      verify(subscription.secret);
      const activated = await activationRequest;
      assert.equal(activated.statusCode, 200, activated.body);
    } else {
      await ok("POST", activate, { expected_revision: 2 });
    }
    assert.equal(
      (await req("POST", activate, { expected_revision: 2 })).statusCode,
      409,
    );
    await db.tenant(owner.tenant, (q) =>
      q.query("UPDATE webhook_deliveries SET status='dead' WHERE id=$1", [
        deliveryId,
      ]),
    );
    await ok("POST", `/webhooks/deliveries/${deliveryId}/replay`, {});
    await tick(db);
    verify(prepared.secret);
    const discarded = await ok("POST", endpoint, { expected_revision: 3 });
    await ok("DELETE", endpoint, {
      expected_revision: discarded.signing_revision,
    });
    const final = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT secret_encrypted,pending_secret_encrypted,signing_revision FROM webhook_subscriptions WHERE id=$1",
        [subscription.id],
      ),
    );
    assert.equal(decrypt(final.secret_encrypted), prepared.secret);
    assert.equal(final.pending_secret_encrypted, null);
    assert.equal(final.signing_revision, 5);
    const audit = await db.tenant(owner.tenant, (q) =>
      q.query(
        "SELECT action FROM audit_events WHERE resource_id=$1 AND action LIKE 'integration.secret_%' ORDER BY created_at,id",
        [subscription.id],
      ),
    );
    assert.deepEqual(
      audit.rows.map((r) => r.action),
      [
        "integration.secret_prepared",
        "integration.secret_activated",
        "integration.secret_prepared",
        "integration.secret_discarded",
      ],
    );
  } finally {
    holdResponse = false;
    releaseResponse();
    await new Promise<void>((resolve, reject) =>
      receiver.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("imports run asynchronously and recheck current permissions", async () => {
  const j = await ok(
    "POST",
    "/imports",
    {
      parent_id: space.id,
      name: "Imported knowledge",
      format: "markdown",
      content: "# Imported\n\nDurable details",
    },
    member,
  );
  await tick(db);
  const job = await ok("GET", `/jobs/${j.id}`, undefined, member);
  assert.equal(job.status, "completed");
  assert(
    (
      await ok("GET", `/pages/${job.result.resource_id}/content`)
    ).plain_text.includes("Durable details"),
  );
  const csv = await ok("POST", "/imports", {
    parent_id: space.id,
    name: "Imported CSV",
    format: "csv",
    content: "Name,Owner\nFirst,Jane\nSecond,John",
  });
  await tick(db);
  assert.equal((await ok("GET", `/jobs/${csv.id}`)).status, "completed");
  const denied = await ok(
    "POST",
    "/imports",
    {
      parent_id: space.id,
      name: "Must fail",
      format: "markdown",
      content: "private",
    },
    member,
  );
  await permissionPatch(`/resources/${space.id}/permissions`, {
    inherit: false,
    grants: [],
  });
  await tick(db);
  const status = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT status FROM jobs WHERE id=$1", [denied.id]),
  );
  assert.equal(status.status, "failed");
  await permissionPatch(`/resources/${space.id}/permissions`, {
    inherit: true,
    grants: [],
  });
});
test("exports have canonical text and formula-safe CSV", async () => {
  assert(
    (
      await req("GET", `/resources/${page.id}/export?format=markdown`)
    ).body.includes("Live collaboration"),
  );
  await ok("POST", `/databases/${database.id}/records`, {
    values: { name: '=HYPERLINK("evil")' },
  });
  assert(
    (
      await req("GET", `/resources/${database.id}/export?format=csv`)
    ).body.includes("'=HYPERLINK"),
  );
});
test("trash cascade is atomic and restore preserves content", async () => {
  const children = await ok("GET", `/resources?parent_id=${page.id}`);
  await ok("DELETE", `/resources/${children[0].id}`);
  await ok("DELETE", `/resources/${space.id}`);
  assert.equal((await req("GET", `/pages/${page.id}/content`)).statusCode, 404);
  assert.equal(
    (await req("POST", `/resources/${page.id}/restore`, {})).statusCode,
    404,
  );
  await ok("POST", `/resources/${space.id}/restore`, {});
  await ok("POST", `/resources/${page.id}/restore`, {});
  assert(
    (await ok("GET", `/pages/${page.id}/content`)).plain_text.includes(
      "Live collaboration",
    ),
  );
});
test("permanent purge queues object deletion and retention policy purges expired trash", async () => {
  const doomed = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Purge acceptance",
  });
  const boundary = "purge-boundary";
  const data = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="purge.txt"\r\nContent-Type: text/plain\r\n\r\nPurge bytes\r\n--${boundary}--\r\n`;
  const upload = await req("POST", `/resources/${doomed.id}/files`, data, owner, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const stored = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT object_key FROM files WHERE id=$1", [upload.json().id]),
  );
  await ok("DELETE", `/resources/${doomed.id}`);
  await ok("DELETE", `/resources/${doomed.id}/purge`);
  assert.equal(
    await db.tenant(owner.tenant, async (q) =>
      Number((await one(q, "SELECT count(*) n FROM resources WHERE id=$1", [doomed.id])).n),
    ),
    0,
  );
  assert.equal(
    (
      await db.tenant(owner.tenant, (q) =>
        one(q, "SELECT status FROM object_deletions WHERE object_key=$1", [
          stored.object_key,
        ]),
      )
    ).status,
    "pending",
  );
  await tick(db);
  assert.equal(
    (
      await db.tenant(owner.tenant, (q) =>
        one(q, "SELECT status FROM object_deletions WHERE object_key=$1", [
          stored.object_key,
        ]),
      )
    ).status,
    "completed",
  );

  await ok("PATCH", "/retention", { trash_retention_days: 1 });
  const expired = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Expired trash",
  });
  await ok("DELETE", `/resources/${expired.id}`);
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE resources SET deleted_at=now()-interval '2 days' WHERE id=$1", [
      expired.id,
    ]),
  );
  await tick(db);
  assert.equal(
    await db.tenant(owner.tenant, async (q) =>
      Number((await one(q, "SELECT count(*) n FROM resources WHERE id=$1", [expired.id])).n),
    ),
    0,
  );
  await ok("PATCH", "/retention", { trash_retention_days: 30 });
});

test("audit is append-only to runtime role and credentials revoke immediately", async () => {
  await assert.rejects(
    db.tenant(owner.tenant, (q) => q.query("DELETE FROM audit_events")),
  );
  await ok("PATCH", `/members/${member.id}`, { active: false });
  assert.equal((await req("GET", "/me", undefined, member)).statusCode, 401);
  assert((await ok("GET", "/audit")).length > 0);
});

test("numeric filters compare values numerically and record titles respect resource limits", async () => {
  const d = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "Numeric acceptance",
  });
  await ok("PATCH", `/databases/${d.id}`, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "amount", name: "Amount", type: "number" },
    ],
  });
  await ok("POST", `/databases/${d.id}/records`, {
    values: { name: "Ten", amount: 10 },
  });
  await ok("POST", `/databases/${d.id}/records`, {
    values: { name: "Two", amount: 2 },
  });
  const v = await ok("POST", `/databases/${d.id}/views`, {
    name: "Above nine",
    config: {
      type: "table",
      filters: [{ property: "amount", op: "after", value: "9" }],
    },
  });
  const rows = await ok("GET", `/databases/${d.id}/records?view=${v.id}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Ten");
  assert.equal(
    (
      await req("POST", `/databases/${d.id}/records`, {
        values: { name: "x".repeat(501) },
      })
    ).statusCode,
    400,
  );
});


test("tenant IdP registration is disabled, encrypted and isolated under tenant RLS", async () => {
  const savedOrigins = process.env.OIDC_TENANT_ISSUER_ORIGINS;
  process.env.OIDC_TENANT_ISSUER_ORIGINS = "https://login.example.test";
  const registration = {
    label: "Customer SSO",
    issuer: "https://login.example.test/realm-one",
    client_id: "workspace-client",
    token_auth_method: "client_secret_post",
    client_secret: "test-only-credential-very-secret",
    scopes: ["openid", "profile", "email"],
  };
  // Earlier integration scenarios intentionally revoke the original member
  // session. Use a dedicated active non-admin principal for this regression.
  const viewerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'IdP Viewer',NULL)",
      [viewerId, viewerId + "@example.test"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
      [owner.tenant, viewerId],
    );
  });
  const viewerToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, viewerId),
  );
  const viewer = {
    cookie: "workspace_session=" + viewerToken,
    csrf: csrf(viewerToken),
  };
  // Similarly, use a freshly issued second-tenant owner session for isolation.
  const otherToken = await db.tenant(other.tenant, (q) =>
    createSession(q, other.tenant, owner.id),
  );
  const otherOwner = {
    tenant: other.tenant,
    cookie: "workspace_session=" + otherToken,
    csrf: csrf(otherToken),
  };
  try {
    assert.equal((await req("GET", "/identity/providers", undefined, null)).statusCode, 401);
    assert.equal((await req("GET", "/identity/providers", undefined, viewer)).statusCode, 403);
    assert.equal(
      (await req("POST", "/identity/providers", registration, viewer)).statusCode,
      403,
    );
    const badSource = await req("POST", "/identity/providers", {
      ...registration,
      issuer: "https://unapproved.example.test/oidc",
    });
    assert.equal(badSource.statusCode, 403, badSource.body);
    const privateEndpoint = await req("POST", "/identity/providers", {
      ...registration,
      issuer: "https://127.0.0.1/realms/private",
    });
    assert.equal(privateEndpoint.statusCode, 400, privateEndpoint.body);
    const missingSecret = await req("POST", "/identity/providers", {
      ...registration,
      client_secret: undefined,
    });
    assert.equal(missingSecret.statusCode, 400, missingSecret.body);
    const forbiddenEnabling = await req("POST", "/identity/providers", {
      ...registration,
      enabled: true,
    });
    assert.equal(forbiddenEnabling.statusCode, 400, forbiddenEnabling.body);

    const registered = await ok("POST", "/identity/providers", registration);
    assert.equal(registered.enabled, false);
    assert.equal(registered.require_verified_email, true);
    assert.equal(registered.revision, 1);
    assert.equal(registered.issuer, registration.issuer);
    assert.equal(registered.client_id, registration.client_id);
    assert.equal(registered.client_secret, undefined);
    assert.doesNotMatch(JSON.stringify(registered), /test-only-credential/);

    const listed = await ok("GET", "/identity/providers");
    assert.ok(listed.find((p: any) => p.id === registered.id));
    assert.doesNotMatch(JSON.stringify(listed), /test-only-credential|client_secret_encrypted/);
    const stored = await db.tenant(owner.tenant, (q) =>
      one(q, "SELECT client_secret_encrypted,enabled FROM oidc_tenant_providers WHERE id=$1", [registered.id]),
    );
    assert.match(stored.client_secret_encrypted, /^oidc-v1\./);
    assert.doesNotMatch(stored.client_secret_encrypted, /test-only-credential/);
    const { openTenantOidcSecret } = await import("../packages/auth/tenant-provider.ts");
    assert.equal(
      openTenantOidcSecret(stored.client_secret_encrypted, owner.tenant, registered.id),
      registration.client_secret,
    );
    assert.throws(
      () => openTenantOidcSecret(stored.client_secret_encrypted, otherOwner.tenant, registered.id),
    );
    const invisible = await db.tenant(otherOwner.tenant, (q) =>
      one(q, "SELECT id FROM oidc_tenant_providers WHERE id=$1", [registered.id]),
    );
    assert.equal(invisible, undefined);

    // Same client ID and issuer are allowed in a different tenant.
    const otherRegistration = await ok("POST", "/identity/providers", registration, otherOwner);
    assert.equal(otherRegistration.enabled, false);
    assert.notEqual(otherRegistration.id, registered.id);
    assert.ok(!(await ok("GET", "/identity/providers", undefined, otherOwner))
      .some((p: any) => p.id === registered.id));
    const crossTenantRevoke = await req(
      "DELETE", "/identity/providers/" + registered.id, undefined, otherOwner,
    );
    assert.equal(crossTenantRevoke.statusCode, 404, crossTenantRevoke.body);
    assert.equal((await req("DELETE", "/identity/providers/" + otherRegistration.id, undefined, viewer)).statusCode, 403);

    const revoked = await ok("DELETE", "/identity/providers/" + registered.id);
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revision, 2);
    assert.equal((await req("DELETE", "/identity/providers/" + registered.id)).statusCode, 404);
    assert.ok((await ok("GET", "/identity/providers"))
      .some((p: any) => p.id === registered.id && p.revoked_at));
    assert.ok((await ok("GET", "/identity/providers", undefined, otherOwner))
      .some((p: any) => p.id === otherRegistration.id && !p.revoked_at));
    const methods = await req("GET", "/auth/methods", undefined, null);
    assert.equal(methods.statusCode, 200);
    assert.equal(methods.json().oidc.label, "Test SSO");
  } finally {
    if (savedOrigins === undefined) delete process.env.OIDC_TENANT_ISSUER_ORIGINS;
    else process.env.OIDC_TENANT_ISSUER_ORIGINS = savedOrigins;
  }
});


test("scoped cursor feed retains microsecond keyset order and filters inaccessible events", async () => {
  const timestamp = "2026-09-01T01:02:03.123456Z";
  const since = "2026-09-01T01:02:03.123000Z";
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(),
    resource_id: i % 2 === 0 ? root.id : randomUUID(),
  }));
  await db.tenant(owner.tenant, async (q) => {
    for (const row of rows)
      await q.query(
        "INSERT INTO event_outbox(id,tenant_id,type,resource_id,created_at)" +
        " VALUES($1,$2,'page.updated',$3,$4::timestamptz)",
        [row.id, owner.tenant, row.resource_id, timestamp],
      );
  });
  const foreign = randomUUID();
  await db.tenant(other.tenant, (q) =>
    q.query(
      "INSERT INTO event_outbox(id,tenant_id,type,resource_id,created_at)" +
      " VALUES($1,$2,'page.updated',$3,$4::timestamptz)",
      [foreign, other.tenant, root.id, timestamp],
    ),
  );

  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const expected = sorted.filter((item) => item.resource_id === root.id)
    .map((item) => item.id);
  const actual: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < rows.length; i++) {
    const endpoint: string = cursor
      ? "/events/cursor?limit=1&cursor=" + encodeURIComponent(cursor)
      : "/events/cursor?limit=1&since=" + encodeURIComponent(since);
    const page = await ok("GET", endpoint);
    assert.equal(page.events.length <= 1, true);
    assert.match(page.next_cursor, /^event-v1\./);
    assert.equal(page.has_more, true);
    assert.ok(!page.events.some((e: any) => e.id === foreign));
    for (const e of page.events) {
      assert.equal(e.resource_id, root.id);
      assert.ok(!actual.includes(e.id), "each accessible event is returned once");
      actual.push(e.id);
    }
    cursor = page.next_cursor;
  }
  assert.deepEqual(actual, expected);

  // A validly signed cursor must not transfer to another principal or tenant.
  const forged = cursor!.slice(0, -2) + "xx";
  assert.equal(
    (await req("GET", "/events/cursor?cursor=" + encodeURIComponent(forged))).statusCode,
    400,
  );
  assert.equal(
    (await req("GET", "/events/cursor?cursor=" + encodeURIComponent(cursor!) +
      "&since=" + encodeURIComponent(since))).statusCode,
    400,
  );
  const switchedTenantToken = await db.tenant(other.tenant, (q) =>
    createSession(q, other.tenant, owner.id),
  );
  const otherOwner = {
    cookie: "workspace_session=" + switchedTenantToken,
    csrf: csrf(switchedTenantToken),
  };
  assert.equal(
    (await req("GET", "/events/cursor?cursor=" + encodeURIComponent(cursor!),
      undefined, otherOwner)).statusCode,
    400,
  );

  const guestId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,is_service) VALUES($1,$2,'Events Reader',true)",
      [guestId, guestId + "@service.internal"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'guest')",
      [owner.tenant, guestId],
    );
  });
  const service = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, guestId, ["events.read"], "Events Reader"),
  );
  const read = await req(
    "GET",
    "/events/cursor?limit=5&since=" + encodeURIComponent(since),
    undefined,
    null,
    { authorization: "Bearer " + service },
  );
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json().events, []);
  assert.equal(
    (await req("GET", "/events/cursor?cursor=" + encodeURIComponent(cursor!),
      undefined, null,
      { authorization: "Bearer " + service })).statusCode,
    400,
  );
  const deniedScope = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, guestId, ["pages.read"], "No events scope"),
  );
  assert.equal(
    (await req("GET", "/events/cursor", undefined, null,
      { authorization: "Bearer " + deniedScope })).statusCode,
    403,
  );
});


test("reconciliation enumerates only currently accessible resources with encrypted scan positions", async () => {
  const reconcileUser = randomUUID();
  const hiddenId = "00000000-0000-4000-8000-000000000001";
  const publicId = "00000000-0000-4000-8000-000000000002";
  const laterId = "00000000-0000-4000-8000-000000000003";
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,is_service) VALUES($1,$2,'Reconcile User',true)",
      [reconcileUser, reconcileUser + '@service.internal'],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
      [owner.tenant, reconcileUser],
    );
    for (const [id, name] of [
      [hiddenId, "reconcile-hidden"],
      [publicId, "reconcile-public"],
      [laterId, "reconcile-next"],
    ]) {
      await q.query(
        "INSERT INTO resources(id,tenant_id,parent_id,kind,title)" +
        " VALUES($1,$2,$3,'page',$4)",
        [id, owner.tenant, space.id, name],
      );
    }
    await q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
      " VALUES($1,$2,$3,0)",
      [owner.tenant, hiddenId, reconcileUser],
    );
  });
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, reconcileUser,
      ["events.read", "workspace.read", "pages.read", "databases.read"],
      "Reconcile reader"),
  );
  const read = (path: string, authToken = token) => req(
    "GET", path, undefined, null,
    { authorization: "Bearer " + authToken },
  );
  const scan = async (forbidden: string | null = hiddenId) => {
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    let emptyWithMore = false;
    for (let n = 0; n < 250; n++) {
      const url = "/events/reconcile?limit=1" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      const result = await read(url);
      assert.equal(result.statusCode, 200, result.body);
      const body = result.json();
      assert.ok(body.resources.length <= 1);
      assert.match(body.next_cursor, /^reconcile-v1\./);
      if (forbidden) assert.ok(!result.body.includes(forbidden),
        "inaccessible IDs must not leak in fields or opaque cursors");
      if (!body.resources.length && body.has_more) emptyWithMore = true;
      seen.push(...body.resources.map((v: any) => v.id));
      cursors.push(body.next_cursor);
      cursor = body.next_cursor;
      if (!body.has_more) return { seen, cursors, emptyWithMore };
    }
    throw Error("Reconciliation pagination did not terminate");
  };
  const first = await scan();
  assert.ok(first.emptyWithMore, "inaccessible raw positions can yield empty pages");
  assert.ok(first.seen.includes(publicId));
  assert.ok(first.seen.includes(laterId));
  assert.ok(!first.seen.includes(hiddenId));
  assert.equal(new Set(first.seen).size, first.seen.length);
  assert.ok(first.seen.includes(root.id));
  assert.ok(!first.cursors.some(c => c.includes(hiddenId)));

  const firstCursor = first.cursors[0];
  const forged = firstCursor.slice(0, -3) + "abc";
  assert.equal((await read("/events/reconcile?cursor=" +
    encodeURIComponent(forged))).statusCode, 400);
  assert.equal((await req("GET", "/events/reconcile?cursor=" +
    encodeURIComponent(firstCursor), undefined, owner)).statusCode, 400);
  assert.equal((await req("GET", "/events/reconcile?cursor=" +
    encodeURIComponent(firstCursor), undefined, other)).statusCode, 400);
  assert.equal((await read("/events/reconcile?limit=101")).statusCode, 400);
  assert.equal((await read("/events/reconcile?cursor=" +
    "x".repeat(2050))).statusCode, 400);
  const noEventScope = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, reconcileUser, ["pages.read"],
      "No event scope"),
  );
  assert.equal((await read("/events/reconcile", noEventScope)).statusCode, 403);
  const noPageScope = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, reconcileUser, ["events.read", "workspace.read"],
      "No page scope"),
  );
  const restricted = await read("/events/reconcile?limit=100", noPageScope);
  assert.equal(restricted.statusCode, 200);
  assert.ok(!restricted.json().resources.some((v: any) =>
    [hiddenId, publicId, laterId].includes(v.id)));

  // A fresh full pass discovers a new grant and later observes revocation;
  // a partial pass is never authoritative to delete cached evidence.
  await db.tenant(owner.tenant, (q) => q.query(
    "DELETE FROM acl WHERE tenant_id=$1 AND resource_id=$2 AND principal_id=$3",
    [owner.tenant, hiddenId, reconcileUser],
  ));
  // A grant arriving behind the original keyset position must not make a
  // prior continuation silently rewind. A new full pass will discover it.
  const resumed = await read("/events/reconcile?limit=1&cursor=" +
    encodeURIComponent(firstCursor));
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.ok(!resumed.json().resources.some((v: any) => v.id === hiddenId));
  assert.ok((await scan(null)).seen.includes(hiddenId));
  await db.tenant(owner.tenant, (q) => q.query(
    "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
    " VALUES($1,$2,$3,0)",
    [owner.tenant, hiddenId, reconcileUser],
  ));
  const revoked = await scan();
  assert.ok(!revoked.seen.includes(hiddenId));
  assert.ok(first.seen.filter(id => !revoked.seen.includes(id)).length === 0);
  await db.tenant(owner.tenant, (q) => q.query(
    "UPDATE resources SET deleted_at=now() WHERE id=$1",
    [publicId],
  ));
  const afterDelete = await scan();
  assert.ok(!afterDelete.seen.includes(publicId));
  assert.ok(revoked.seen.includes(publicId));
});

test("recently viewed lists personal visits, not other users' edits, and revokes access", async () => {
  // A separate Fastify instance keeps the exact production throttling policy
  // while isolating this regression's budget from the long-running suite.
  const recentApp = await buildApp(db, undefined, false, fakeOidc, fakeAntivirus);
  const recentReq = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string, data?: any, actor: any = owner,
  ): Promise<{ statusCode: number; body: string; json: () => any }> =>
    recentApp.inject({
      method,
      url: "/api/v1" + path,
      headers: {
        cookie: actor.cookie,
        "x-csrf-token": actor.csrf,
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { payload: data }),
    });
  const recentOk = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string, data?: any, actor: any = owner,
  ) => {
    const response = await recentReq(method, path, data, actor);
    assert.ok(response.statusCode < 300,
      `${method} ${path}: ${response.statusCode} ${response.body}`);
    return response.json();
  };
  try {
    const folder = await recentOk("POST", "/resources", {
    kind: "space", parent_id: root.id, title: "Personal recents acceptance",
  });
  const first = await recentOk("POST", "/resources", {
    kind: "page", parent_id: folder.id, title: "Visited only once",
  });
  const second = await recentOk("POST", "/resources", {
    kind: "page", parent_id: folder.id, title: "Visited last",
  });
  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name) VALUES($1,$2,'Recents Peer')",
      [peerId, peerId + "@example.test"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
  });
  const peerToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = {
    cookie: "workspace_session=" + peerToken, csrf: csrf(peerToken),
  };
  const before = await recentOk("GET", "/resources?recent=true");
  assert.ok(!before.some((n: any) => [first.id, second.id].includes(n.id)),
    "creating and editing a page is not a visit");

  assert.deepEqual(
    (await recentOk("GET", "/resources?recent=true", undefined, peer))
      .filter((n: any) => [first.id, second.id].includes(n.id)),
    [],
  );
  await recentOk("POST", `/resources/${first.id}/bookmark`, {});
  await new Promise<void>((resolve) => setTimeout(resolve, 8));
  await recentOk("POST", `/resources/${second.id}/bookmark`, {});
  let recentlyViewed = await recentOk("GET", "/resources?recent=true");
  assert.deepEqual(
    recentlyViewed.filter((n: any) => [first.id, second.id].includes(n.id))
      .map((n: any) => n.id),
    [second.id, first.id],
  );
  assert.ok(recentlyViewed.find((n: any) => n.id === second.id)?.viewed_at);

  // A different member has an independent timeline, even in the same tenant.
  assert.equal(
    (await recentOk("GET", "/resources?recent=true", undefined, peer))
      .some((n: any) => n.id === first.id), false,
  );
  await recentOk("POST", `/resources/${first.id}/bookmark`, {}, peer);
  recentlyViewed = await recentOk("GET", "/resources?recent=true", undefined, peer);
  assert.ok(recentlyViewed.some((n: any) => n.id === first.id));
  assert.ok(!recentlyViewed.some((n: any) => n.id === second.id));

  // Current ACLs are applied on read, not only when the visit is written.
  await db.tenant(owner.tenant, (q) => q.query(
    "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
    " VALUES($1,$2,$3,0) ON CONFLICT(tenant_id,resource_id,principal_id)" +
    " DO UPDATE SET level=0",
    [owner.tenant, folder.id, peerId],
  ));
  recentlyViewed = await recentOk("GET", "/resources?recent=true", undefined, peer);
  assert.ok(!recentlyViewed.some((n: any) => n.id === first.id));
  assert.equal(
    (await recentReq("POST", `/resources/${first.id}/bookmark`, {}, peer)).statusCode,
    404,
  );
  assert.ok(
    (await recentOk("GET", "/resources?recent=true"))
      .some((n: any) => n.id === first.id),
    "owner's timeline is unaffected by peer revocation",
  );
  assert.equal(
    (await recentOk("GET", "/resources?recent=true", undefined, other))
      .some((n: any) => n.id === first.id), false,
    "the same global user in another tenant cannot see visits",
  );

  await recentOk("DELETE", `/resources/${second.id}`);
  assert.equal(
    (await recentOk("GET", "/resources?recent=true"))
      .some((n: any) => n.id === second.id), false,
    "trashed pages are excluded from personal history",
  );
  } finally {
    await recentApp.close();
  }
});
