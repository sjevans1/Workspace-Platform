import { test, before, after } from "node:test";
import { shutdownDiagnostics } from "./shutdown-diagnostics.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStorage } from "../packages/storage/index.ts";
import { retryUuid } from "../apps/api/src/portable-import.ts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { testPostgres } from "../scripts/test-postgres.ts";
import {
  inspectPortableArchive,
  PORTABLE_ARCHIVE_FORMAT,
  PORTABLE_ARCHIVE_VERSION,
} from "../packages/portable-archive/index.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { createCollab } from "../apps/collab/src/server.ts";
import { tick } from "../apps/worker/src/worker.ts";
import { createSession, csrf, hash } from "../packages/auth/index.ts";
import type { OidcProfile, OidcProvider } from "../packages/auth/oidc.ts";
import { decrypt, signature } from "../packages/events/index.ts";
import {
  beginReconcileCursor,
  encodeReconcileCursor,
} from "../packages/events/reconcile-cursor.ts";
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
  let r = await req(method, path, data, actor);
  if (r.statusCode === 429) {
    // Integration tests share one real server-side request budget. Exercise
    // the real limit, honor Retry-After, and retry once; never weaken or
    // disable the production limiter to make the acceptance suite green.
    const retry = Number(r.headers["retry-after"]);
    assert.ok(
      Number.isFinite(retry) && retry >= 0 && retry <= 60,
      "Rate-limit response must provide a bounded Retry-After",
    );
    await new Promise<void>((resolve) =>
      setTimeout(resolve, (retry + 1) * 1000),
    );
    r = await req(method, path, data, actor);
  }
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
async function freshMemberActor(label: string) {
  const id = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      id,
      `member-${id}@example.test`,
      label,
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [owner.tenant, id],
    );
  });
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, id),
  );
  return {
    id,
    tenant: owner.tenant,
    cookie: "workspace_session=" + token,
    csrf: csrf(token),
  };
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
    await q.query(
      "INSERT INTO organisations(id,name) VALUES($1,'Other tenant')",
      [tenant],
    );
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
    headers: {
      authorization: "Bearer incorrect-metrics-token-0123456789abcdef",
    },
  });
  assert.equal(wrong.statusCode, 401, wrong.body);

  const accepted = await app.inject({
    method: "GET",
    url: "/metrics",
    headers: {
      authorization: "Bearer metrics-test-token-0123456789abcdef",
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.match(String(accepted.headers["content-type"]), /text\/plain/);
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
    "/Users?filter=userName%20eq%20%22directory.user%40example.test%22",
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
  assert.equal(
    (await req("GET", "/me", undefined, tenantActor)).statusCode,
    200,
  );

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
  assert.equal(
    (await req("GET", "/me", undefined, otherActor)).statusCode,
    200,
  );

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

  assert.equal(
    (await req("GET", "/me", undefined, tenantActor)).statusCode,
    401,
  );
  assert.equal(
    (await req("GET", "/me", undefined, otherActor)).statusCode,
    200,
  );

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
  assert.equal(
    (await req("GET", "/me", undefined, freshActor)).statusCode,
    200,
  );

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
    types
      .json()
      .Resources.map((item: any) => item.id)
      .sort(),
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
    "/Groups?filter=displayName%20eq%20%22Directory%20Guests%22",
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
  const guestGroupAdmin = groupList.find(
    (item: any) => item.id === guestGroup.id,
  );
  assert.equal(guestGroupAdmin.member_count, 1);
  assert.equal(guestGroupAdmin.mapped_role, null);

  const deleteGuestGroup = await scim("DELETE", `/Groups/${guestGroup.id}`);
  assert.equal(deleteGuestGroup.statusCode, 204, deleteGuestGroup.body);
  const deleteMemberGroup = await scim("DELETE", `/Groups/${memberGroup.id}`);
  assert.equal(deleteMemberGroup.statusCode, 204, deleteMemberGroup.body);

  const deleted = await scim("DELETE", `/Users/${created.id}`);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal(
    (await req("GET", "/me", undefined, freshActor)).statusCode,
    401,
  );
  assert.equal(
    (await req("GET", "/me", undefined, otherActor)).statusCode,
    200,
  );
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
  assert.equal((await req("GET", "/me", undefined, local)).statusCode, 401);
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
  const recordsPath =
    "/databases/" + calendarDb.id + "/records?view=" + view.id;
  const march = await ok("GET", recordsPath + "&month=2026-03");
  assert.deepEqual(march.map((row: any) => row.title).sort(), [
    "March first",
    "March last",
  ]);
  assert.deepEqual(
    (await ok("GET", recordsPath + "&month=2026-02")).map(
      (row: any) => row.title,
    ),
    ["February"],
  );
  assert.deepEqual(
    (await ok("GET", recordsPath + "&month=2026-04")).map(
      (row: any) => row.title,
    ),
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
  const tableView = (await ok("GET", "/databases/" + calendarDb.id)).views.find(
    (v: any) => v.config.type === "table",
  );
  assert.ok(tableView);
  const nonCalendarMonth = await req(
    "GET",
    "/databases/" +
      calendarDb.id +
      "/records?view=" +
      tableView.id +
      "&month=2026-03",
  );
  assert.equal(nonCalendarMonth.statusCode, 400, nonCalendarMonth.body);
  assert.equal(
    (
      await ok(
        "GET",
        "/databases/" + calendarDb.id + "/records?view=" + tableView.id,
      )
    ).length,
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
  assert.equal(
    backlinksSpec.responses["200"].content["application/json"].schema.type,
    "object",
  );
  assert.deepEqual(
    backlinksSpec.responses["200"].content["application/json"].schema.required,
    ["items", "next_cursor", "has_more"],
  );
  assert.equal(
    backlinksSpec.parameters.find((p: any) => p.name === "limit")?.schema
      .maximum,
    40,
  );
  assert.equal(
    backlinksSpec.responses["200"].content["application/json"].schema.properties
      .items.maxItems,
    40,
  );
  const linkReconcileSpec = spec.paths["/api/v1/resource-links/reconcile"].post;
  assert.deepEqual(
    linkReconcileSpec.responses["200"].content["application/json"].schema
      .required,
    ["processed", "next_cursor", "has_more"],
  );
  const cursorSpec = spec.paths["/api/v1/events/cursor"].get;
  assert.deepEqual(
    cursorSpec.responses["200"].content["application/json"].schema.required,
    ["events", "next_cursor", "has_more"],
  );
  const prepared = spec.paths["/api/v1/webhooks/{id}/secret-rotation"].post;
  assert.deepEqual(
    prepared.requestBody.content["application/json"].schema.required,
    ["expected_revision"],
  );
  assert.ok(
    prepared.responses["200"].content["application/json"].schema.properties
      .secret,
  );
  const activated =
    spec.paths["/api/v1/webhooks/{id}/secret-rotation/activate"].post;
  assert.equal(
    activated.responses["200"].content["application/json"].schema.properties
      .secret,
    undefined,
  );
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
    (await ok("GET", "/search?q=Orion")).items.some(
      (x: any) => x.id === page.id,
    ),
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
test("W15 templates and subtree duplication remap links and relations without copying ACLs", async () => {
  const catalog = await ok("GET", "/templates");
  const projectSpaceTemplate = catalog.find(
    (item: any) => item.id === "project-space",
  );
  assert.deepEqual(
    {
      kind: projectSpaceTemplate.kind,
      title: projectSpaceTemplate.title,
      icon: projectSpaceTemplate.icon,
    },
    { kind: "space", title: "Project space", icon: "◈" },
  );

  const templated = await ok("POST", "/resources", {
    kind: "space",
    parent_id: root.id,
    title: "Guided project",
    template: "project-space",
  });
  const templatedChildren = await ok(
    "GET",
    `/resources?parent_id=${templated.id}&limit=20`,
  );
  assert.deepEqual(
    templatedChildren.map((item: any) => [item.kind, item.title]).sort(),
    [
      ["database", "Tasks"],
      ["page", "Decision log"],
      ["page", "Project plan"],
    ].sort(),
    "The server-owned space template must materialize its guided starter children",
  );

  const sourceSpace = await ok("POST", "/resources", {
    kind: "space",
    parent_id: root.id,
    title: "W15 clone source",
  });
  const linkedTarget = await ok("POST", "/resources", {
    kind: "page",
    parent_id: sourceSpace.id,
    title: "Linked target",
  });
  const linkingPage = await ok("POST", "/resources", {
    kind: "page",
    parent_id: sourceSpace.id,
    title: "Linking page",
  });
  await ok("PATCH", `/pages/${linkingPage.id}/content`, {
    blocks: [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            href: "/?page=" + linkedTarget.id,
            content: [{ type: "text", text: "Linked target", styles: {} }],
          },
        ],
      },
    ],
    expected_revision: 1,
  });

  const relationTargetDb = await ok("POST", "/resources", {
    kind: "database",
    parent_id: sourceSpace.id,
    title: "Relation target",
  });
  const relationSourceDb = await ok("POST", "/resources", {
    kind: "database",
    parent_id: sourceSpace.id,
    title: "Relation source",
  });
  await ok("PATCH", `/databases/${relationSourceDb.id}`, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      {
        id: "related",
        name: "Related",
        type: "relation",
        target_database_id: relationTargetDb.id,
      },
    ],
  });
  const targetRecord = await ok(
    "POST",
    `/databases/${relationTargetDb.id}/records`,
    {
      values: { name: "Target record" },
    },
  );
  await ok("POST", `/databases/${relationSourceDb.id}/records`, {
    values: { name: "Source record", related: [targetRecord.id] },
  });

  await permissionPatch(`/resources/${linkingPage.id}/permissions`, {
    inherit: false,
    grants: [],
  });

  const rootBefore = await ok(
    "GET",
    `/resources?parent_id=${root.id}&limit=200`,
    undefined,
    member,
  );
  const denied = await req(
    "POST",
    `/resources/${sourceSpace.id}/duplicate`,
    {},
    member,
  );
  assert.equal(
    denied.statusCode,
    404,
    "A caller missing any child in the subtree must not receive a partial clone",
  );
  const rootAfter = await ok(
    "GET",
    `/resources?parent_id=${root.id}&limit=200`,
    undefined,
    member,
  );
  assert.deepEqual(
    rootAfter.map((item: any) => item.id).sort(),
    rootBefore.map((item: any) => item.id).sort(),
    "Failed duplication must roll back all newly created subtree resources",
  );
  assert.equal(
    (await req("POST", `/resources/${sourceSpace.id}/duplicate`, {}, other))
      .statusCode,
    404,
    "Cross-tenant duplication fails without resource disclosure",
  );

  const clone = await ok("POST", `/resources/${sourceSpace.id}/duplicate`, {});
  assert.equal(clone.title, "W15 clone source (copy)");
  assert.equal(clone.duplicate_report.acl_copied, false);
  assert.equal(clone.duplicate_report.resources, 7);

  const clonedChildren = await ok(
    "GET",
    `/resources?parent_id=${clone.id}&limit=50`,
  );
  const byTitle = new Map<string, any>(
    clonedChildren.map((item: any) => [item.title, item]),
  );
  const clonedTargetPage = byTitle.get("Linked target");
  const clonedLinkingPage = byTitle.get("Linking page");
  const clonedTargetDb = byTitle.get("Relation target");
  const clonedSourceDb = byTitle.get("Relation source");
  assert.ok(
    clonedTargetPage && clonedLinkingPage && clonedTargetDb && clonedSourceDb,
  );

  const clonedBody = await ok("GET", `/pages/${clonedLinkingPage.id}/content`);
  assert.match(
    JSON.stringify(clonedBody.blocks),
    new RegExp(clonedTargetPage.id),
  );
  assert.doesNotMatch(
    JSON.stringify(clonedBody.blocks),
    new RegExp(linkedTarget.id),
    "Internal page links must be rewritten to the cloned target",
  );

  const clonedSourceDefinition = await ok(
    "GET",
    `/databases/${clonedSourceDb.id}`,
  );
  const clonedRelation = clonedSourceDefinition.properties.find(
    (property: any) => property.id === "related",
  );
  assert.equal(
    clonedRelation.target_database_id,
    clonedTargetDb.id,
    "Relation schema must point to the cloned target database",
  );

  const clonedTargetRecords = await ok(
    "GET",
    `/databases/${clonedTargetDb.id}/records`,
  );
  const clonedSourceRecords = await ok(
    "GET",
    `/databases/${clonedSourceDb.id}/records`,
  );
  assert.equal(clonedTargetRecords.length, 1);
  assert.equal(clonedSourceRecords.length, 1);
  assert.deepEqual(
    clonedSourceRecords[0].values.related,
    [clonedTargetRecords[0].id],
    "Relation values must point at cloned records when both sides were cloned",
  );

  const memberClonePage = await req(
    "GET",
    `/resources/${clonedLinkingPage.id}`,
    undefined,
    member,
  );
  assert.equal(
    memberClonePage.statusCode,
    200,
    "Clone ACLs must inherit from the destination instead of copying source denial",
  );
});

test("W14 search is ranked, paginated and permission-live without metadata leakage", async () => {
  const token = "w14-prism-keep-exact";
  const privatePage = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Secret W14 prism",
  });
  await ok("PATCH", `/pages/${privatePage.id}/content`, {
    blocks: [{ type: "paragraph", content: token + " private-body-marker" }],
    expected_revision: 1,
  });
  await permissionPatch(`/resources/${privatePage.id}/permissions`, {
    inherit: false,
    grants: [],
  });

  const visiblePages: any[] = [];
  for (let i = 0; i < 3; i++) {
    const item = await ok("POST", "/resources", {
      kind: "page",
      parent_id: space.id,
      title: "Public W14 prism",
    });
    await ok("PATCH", `/pages/${item.id}/content`, {
      blocks: [{ type: "paragraph", content: token + " public-body-marker" }],
      expected_revision: 1,
    });
    visiblePages.push(item);
  }
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "UPDATE resources SET updated_at='2026-10-06T11:59:59.123456Z'::timestamptz WHERE id=$1",
      [privatePage.id],
    );
    for (let i = 0; i < visiblePages.length; i++)
      await q.query(
        "UPDATE resources SET updated_at=$2::timestamptz WHERE id=$1",
        [visiblePages[i].id, `2026-10-06T12:00:0${i}.123456Z`],
      );
  });

  const ownerSearch = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=1`,
  );
  assert.equal(ownerSearch.items.length, 1);
  assert.equal(ownerSearch.has_more, true);
  assert.equal(typeof ownerSearch.next_cursor, "string");
  assert.equal(
    ownerSearch.items[0].id,
    visiblePages[2].id,
    "Equal-ranked results use updated_at/id keyset ordering",
  );

  const memberSearch = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=10`,
    undefined,
    member,
  );
  assert.deepEqual(
    memberSearch.items.map((x: any) => x.id).sort(),
    visiblePages.map((x: any) => x.id).sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(memberSearch),
    /Secret W14 prism|private-body-marker/,
    "Unauthorized title/snippet/metadata must never enter the response",
  );

  const otherTenantSearch = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=10`,
    undefined,
    other,
  );
  assert.deepEqual(otherTenantSearch.items, []);
  assert.equal(otherTenantSearch.has_more, false);
  assert.equal(otherTenantSearch.next_cursor, null);

  const second = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=1&cursor=${encodeURIComponent(ownerSearch.next_cursor)}`,
  );
  assert.equal(second.items[0].id, visiblePages[1].id);
  assert.equal(second.has_more, true);

  const tampered =
    ownerSearch.next_cursor.slice(0, -1) +
    (ownerSearch.next_cursor.endsWith("A") ? "B" : "A");
  assert.equal(
    (
      await req(
        "GET",
        `/search?q=${encodeURIComponent(token)}&kind=page&limit=1&cursor=${encodeURIComponent(tampered)}`,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        `/search?q=${encodeURIComponent(token)}&kind=page&limit=1&cursor=${encodeURIComponent(ownerSearch.next_cursor)}`,
        undefined,
        member,
      )
    ).statusCode,
    400,
    "Search cursor is bound to the issuing principal",
  );
  assert.equal(
    (
      await req(
        "GET",
        `/search?q=${encodeURIComponent(token)}&kind=record&limit=1&cursor=${encodeURIComponent(ownerSearch.next_cursor)}`,
      )
    ).statusCode,
    400,
    "Search cursor is bound to its query/filter contract",
  );

  await ok("DELETE", `/resources/${visiblePages[1].id}`);
  const afterTrash = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=10`,
  );
  assert.ok(
    !afterTrash.items.some((x: any) => x.id === visiblePages[1].id),
    "Trash must remove a result immediately without index repair",
  );
  await ok("POST", `/resources/${visiblePages[1].id}/restore`);
  const afterRestore = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=10`,
  );
  assert.ok(afterRestore.items.some((x: any) => x.id === visiblePages[1].id));

  await permissionPatch(`/resources/${visiblePages[0].id}/permissions`, {
    inherit: false,
    grants: [],
  });
  const afterRevoke = await ok(
    "GET",
    `/search?q=${encodeURIComponent(token)}&kind=page&limit=10`,
    undefined,
    member,
  );
  assert.ok(
    !afterRevoke.items.some((x: any) => x.id === visiblePages[0].id),
    "Revocation must take effect on the next search page/read",
  );
  assert.doesNotMatch(
    JSON.stringify(afterRevoke),
    new RegExp(visiblePages[0].id),
  );
});

test("W14 indexed search remains bounded at multi-thousand-resource scale", async () => {
  const prefix = "f14e0000-0000-4000-8000-";
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO resources(id,tenant_id,parent_id,kind,title,search_text,position)" +
        " SELECT ($3||lpad(i::text,12,'0'))::uuid,$1,$2,'page'," +
        " 'W14 scale page '||i," +
        " CASE WHEN i=1999 THEN 'w14-scale-needle-keep-exact' ELSE 'ordinary searchable body' END,i" +
        " FROM generate_series(1,2500) i ON CONFLICT DO NOTHING",
      [owner.tenant, space.id, prefix],
    );
  });
  try {
    const started = performance.now();
    const result = await ok(
      "GET",
      "/search?q=w14-scale-needle-keep-exact&kind=page&limit=20",
    );
    const elapsed = performance.now() - started;
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].snippet, /w14-scale-needle-keep-exact/);
    assert.equal(result.has_more, false);
    if (!pg.emulated)
      assert.ok(
        elapsed < 1500,
        `Indexed W14 search exceeded 1500ms budget: ${elapsed.toFixed(1)}ms`,
      );
  } finally {
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "DELETE FROM resources WHERE id::text LIKE 'f14e0000-0000-4000-8000-%'",
      ),
    );
  }
});

test("page backlinks use live canonical links and never reveal restricted sources", async () => {
  // Preserve full production Fastify rate limits, with an independent
  // disposable instance so this test never exhausts another test's budget.
  const linksApp = await buildApp(
    db,
    undefined,
    false,
    fakeOidc,
    fakeAntivirus,
  );
  const linkReq = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    data?: any,
    actor: any = owner,
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
    path: string,
    data?: any,
    actor: any = owner,
  ) => {
    const response = await linkReq(method, path, data, actor);
    assert.ok(
      response.statusCode < 300,
      `${method} ${path}: ${response.statusCode} ${response.body}`,
    );
    return response.json();
  };
  try {
    const target = await linkOk("POST", "/resources", {
      kind: "page",
      parent_id: space.id,
      title: "Link target",
    });
    const source = await linkOk("POST", "/resources", {
      kind: "page",
      parent_id: space.id,
      title: "Accessible source",
    });
    const privateSource = await linkOk("POST", "/resources", {
      kind: "page",
      parent_id: space.id,
      title: "Secret referencing source",
    });
    const textOnly = await linkOk("POST", "/resources", {
      kind: "page",
      parent_id: space.id,
      title: "Plain mention source",
    });
    const external = await linkOk("POST", "/resources", {
      kind: "page",
      parent_id: space.id,
      title: "External URL source",
    });
    const link = {
      type: "link",
      href: "/?page=" + target.id,
      content: [{ type: "text", text: "Linked page", styles: {} }],
    };
    for (const src of [source, privateSource]) {
      await linkOk("PATCH", `/pages/${src.id}/content`, {
        blocks: [{ type: "paragraph", content: [link] }],
        expected_revision: 1,
      });
    }
    await linkOk("PATCH", `/pages/${textOnly.id}/content`, {
      blocks: [
        { type: "paragraph", content: "Plain mention /?page=" + target.id },
      ],
      expected_revision: 1,
    });
    await linkOk("PATCH", `/pages/${external.id}/content`, {
      blocks: [
        {
          type: "paragraph",
          content: [
            {
              type: "link",
              href: "https://external.example.test/?page=" + target.id,
              content: "Not a Workspace reference",
            },
          ],
        },
      ],
      expected_revision: 1,
    });
    const indexed = (
      await db.tenant(owner.tenant, (q) =>
        q.query(
          "SELECT source_id,target_id FROM resource_links WHERE target_id=$1 ORDER BY source_id",
          [target.id],
        ),
      )
    ).rows;
    assert.deepEqual(
      indexed.map((x: any) => x.source_id).sort(),
      [source.id, privateSource.id].sort(),
      "Only canonical internal links enter the materialized graph",
    );
    assert.equal(
      (
        await db.tenant(other.tenant, (q) =>
          q.query("SELECT 1 FROM resource_links WHERE target_id=$1", [
            target.id,
          ]),
        )
      ).rowCount,
      0,
      "Tenant RLS hides the link graph across organisations",
    );
    // Simulate a conservative migration/backfill false positive. The indexed
    // row is only a candidate: canonical blocks remain the disclosure authority.
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "INSERT INTO resource_links(tenant_id,source_id,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [owner.tenant, textOnly.id, target.id],
      ),
    );
    let ownerBacklinks = await linkOk(
      "GET",
      `/resources/${target.id}/backlinks`,
    );
    assert.deepEqual(
      ownerBacklinks.items.map((x: any) => x.id).sort(),
      [source.id, privateSource.id].sort(),
    );
    await linkOk("DELETE", `/resources/${target.id}`);
    assert.equal(
      (await linkReq("GET", `/resources/${target.id}/backlinks`)).statusCode,
      404,
      "Trashed target is not discoverable",
    );
    const retainedCandidates = (
      await db.tenant(owner.tenant, (q) =>
        q.query(
          "SELECT source_id FROM resource_links WHERE target_id=$1 ORDER BY source_id",
          [target.id],
        ),
      )
    ).rows
      .map((x: any) => x.source_id)
      .sort();
    assert.deepEqual(
      retainedCandidates,
      [source.id, privateSource.id, textOnly.id].sort(),
      "Soft-delete retains graph candidates; stale index edges stay inert and GET remains read-only",
    );
    await linkOk("POST", `/resources/${target.id}/restore`);
    ownerBacklinks = await linkOk("GET", `/resources/${target.id}/backlinks`);
    assert.deepEqual(
      ownerBacklinks.items.map((x: any) => x.id).sort(),
      [source.id, privateSource.id].sort(),
      "Restoring target restores backlink visibility without source rewrites",
    );
    const policy = await linkOk(
      "GET",
      `/resources/${privateSource.id}/permissions`,
    );
    await linkOk("PATCH", `/resources/${privateSource.id}/permissions`, {
      inherit: false,
      grants: [],
      expected_revision: policy.revision,
    });
    const memberBacklinks = await linkOk(
      "GET",
      `/resources/${target.id}/backlinks`,
      undefined,
      member,
    );
    assert.deepEqual(
      memberBacklinks.items.map((x: any) => x.id),
      [source.id],
    );
    assert.doesNotMatch(
      JSON.stringify(memberBacklinks.items),
      /Secret referencing source/,
    );
    assert.equal(
      (
        await linkReq(
          "GET",
          `/resources/${target.id}/backlinks`,
          undefined,
          guest,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await linkReq(
          "GET",
          `/resources/${target.id}/backlinks`,
          undefined,
          other,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await linkReq("GET", `/resources/${randomUUID()}/backlinks`)).statusCode,
      404,
    );
    assert.equal(
      (await linkReq("GET", `/resources/${space.id}/backlinks`)).statusCode,
      404,
    );
    // Removing a link immediately removes the backlink on the next read.
    await linkOk("PATCH", `/pages/${source.id}/content`, {
      blocks: [{ type: "paragraph", content: "Link removed" }],
      expected_revision: 2,
    });
    const after = await linkOk(
      "GET",
      `/resources/${target.id}/backlinks`,
      undefined,
      member,
    );
    assert.deepEqual(after.items, []);
    assert.equal(
      (
        await db.tenant(owner.tenant, (q) =>
          q.query(
            "SELECT 1 FROM resource_links WHERE source_id=$1 AND target_id=$2",
            [source.id, target.id],
          ),
        )
      ).rowCount,
      0,
      "Content replacement removes the stale graph edge",
    );

    // The version written before link removal contains the canonical link.
    // Restoring it must restore the graph transactionally as well.
    const versions = await linkOk("GET", `/pages/${source.id}/versions`);
    const linkedVersion = versions.find((v: any) => v.revision === 2);
    assert.ok(linkedVersion);
    await linkOk(
      "POST",
      `/pages/${source.id}/versions/${linkedVersion.id}/restore`,
      {
        expected_revision: 3,
      },
    );
    assert.equal(
      (
        await db.tenant(owner.tenant, (q) =>
          q.query(
            "SELECT 1 FROM resource_links WHERE source_id=$1 AND target_id=$2",
            [source.id, target.id],
          ),
        )
      ).rowCount,
      1,
      "Version restore restores the canonical graph edge",
    );
    const restored = await linkOk(
      "GET",
      `/resources/${target.id}/backlinks`,
      undefined,
      member,
    );
    assert.deepEqual(
      restored.items.map((x: any) => x.id),
      [source.id],
    );
  } finally {
    await linksApp.close();
  }
});
test("W13c backlink cursor is opaque, ACL-live and explicitly repairable", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c cursor target",
  });
  const sourceA = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c first source",
  });
  const sourceB = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c second source",
  });
  const staleSource = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c stale source",
  });
  const linkedBlocks = [
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          href: "/?page=" + target.id,
          content: [{ type: "text", text: "Target", styles: {} }],
        },
      ],
    },
  ];
  for (const source of [sourceA, sourceB])
    await ok("PATCH", `/pages/${source.id}/content`, {
      blocks: linkedBlocks,
      expected_revision: 1,
    });
  await ok("PATCH", `/resources/${sourceA.id}`, {
    title: "W13c renamed first source",
  });
  await ok("DELETE", `/resources/${sourceA.id}`);
  let visible = await ok("GET", `/resources/${target.id}/backlinks`);
  assert.ok(
    !visible.items.some((x: any) => x.id === sourceA.id),
    "A trashed source must immediately leave backlink results",
  );
  await ok("POST", `/resources/${sourceA.id}/restore`);
  visible = await ok("GET", `/resources/${target.id}/backlinks`);
  assert.ok(
    visible.items.some((x: any) => x.id === sourceA.id),
    "Restoring a source recovers its retained canonical backlink",
  );
  // Keep both sources inside the same JavaScript millisecond while preserving
  // PostgreSQL microsecond ordering. A cursor that rounded through Date would
  // skip the second source; the opaque cursor must retain the exact DB key.
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "UPDATE resources SET updated_at='2026-10-05T12:00:00.123900Z'::timestamptz WHERE id=$1",
      [sourceA.id],
    );
    await q.query(
      "UPDATE resources SET updated_at='2026-10-05T12:00:00.123800Z'::timestamptz WHERE id=$1",
      [sourceB.id],
    );
  });

  const first = await ok(
    "GET",
    `/resources/${target.id}/backlinks?limit=1`,
    undefined,
    member,
  );
  assert.deepEqual(
    first.items.map((x: any) => x.id),
    [sourceA.id],
  );
  assert.equal(
    first.items[0].title,
    "W13c renamed first source",
    "Backlinks resolve the source's current title without re-indexing IDs",
  );
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_cursor, "string");
  assert.ok(!first.next_cursor.includes(sourceA.id));
  assert.ok(!first.next_cursor.includes(sourceB.id));

  const altered =
    first.next_cursor.slice(0, -1) +
    (first.next_cursor.endsWith("A") ? "B" : "A");
  assert.equal(
    (
      await req(
        "GET",
        `/resources/${target.id}/backlinks?limit=1&cursor=${encodeURIComponent(altered)}`,
        undefined,
        member,
      )
    ).statusCode,
    400,
    "Tampered backlink cursors must fail closed",
  );
  assert.equal(
    (
      await req(
        "GET",
        `/resources/${target.id}/backlinks?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
        undefined,
        owner,
      )
    ).statusCode,
    400,
    "A cursor is bound to the issuing principal",
  );
  assert.equal(
    (
      await req(
        "GET",
        `/resources/${target.id}/backlinks?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
        undefined,
        member,
      )
    ).statusCode,
    400,
    "A cursor cannot be replayed under a different page-size contract",
  );

  const preciseContinuation = await ok(
    "GET",
    `/resources/${target.id}/backlinks?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
    undefined,
    member,
  );
  assert.deepEqual(
    preciseContinuation.items.map((x: any) => x.id),
    [sourceB.id],
    "Microsecond-distinct backlinks in one JS millisecond must not be skipped",
  );
  assert.equal(preciseContinuation.has_more, false);
  assert.equal(preciseContinuation.next_cursor, null);

  await permissionPatch(`/resources/${sourceB.id}/permissions`, {
    inherit: false,
    grants: [],
  });
  const continued = await ok(
    "GET",
    `/resources/${target.id}/backlinks?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
    undefined,
    member,
  );
  assert.deepEqual(
    continued.items,
    [],
    "Revoked source must disappear on the next page without graph rebuild",
  );
  assert.equal(continued.has_more, false);
  assert.equal(continued.next_cursor, null);

  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "DELETE FROM resource_links WHERE source_id=$1 AND target_id=$2",
      [sourceA.id, target.id],
    );
    await q.query(
      "INSERT INTO resource_links(tenant_id,source_id,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [owner.tenant, staleSource.id, target.id],
    );
  });
  const beforeRepair = await ok("GET", `/resources/${target.id}/backlinks`);
  assert.deepEqual(
    beforeRepair.items.map((x: any) => x.id),
    [sourceB.id],
    "Read path stays side-effect free: missing canonical edge is not synthesized and stale edge is inert",
  );

  const firstRepairPage = await ok("POST", "/resource-links/reconcile", {
    limit: 1,
  });
  assert.equal(firstRepairPage.has_more, true);
  assert.equal(typeof firstRepairPage.next_cursor, "string");
  assert.equal(
    (
      await req(
        "POST",
        "/resource-links/reconcile",
        {
          limit: 1,
          cursor: firstRepairPage.next_cursor,
        },
        other,
      )
    ).statusCode,
    400,
    "Rebuild continuation is tenant/principal bound",
  );

  let reconcileCursor: string | null = null;
  let pages = 0;
  do {
    const repaired = await ok("POST", "/resource-links/reconcile", {
      limit: 100,
      ...(reconcileCursor ? { cursor: reconcileCursor } : {}),
    });
    pages++;
    assert.ok(repaired.processed >= 0 && repaired.processed <= 100);
    reconcileCursor = repaired.next_cursor;
    if (!repaired.has_more) {
      assert.equal(reconcileCursor, null);
      break;
    }
    assert.equal(typeof reconcileCursor, "string");
    assert.ok(
      pages < 50,
      "Resource-link repair must make bounded forward progress",
    );
  } while (reconcileCursor);

  const repairedEdges = (
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "SELECT source_id FROM resource_links WHERE target_id=$1 ORDER BY source_id",
        [target.id],
      ),
    )
  ).rows
    .map((x: any) => x.source_id)
    .sort();
  assert.deepEqual(
    repairedEdges,
    [sourceA.id, sourceB.id].sort(),
    "Explicit repair restores canonical edges and removes stale candidates",
  );

  const snapshot = JSON.stringify(repairedEdges);
  reconcileCursor = null;
  pages = 0;
  do {
    const repeated = await ok("POST", "/resource-links/reconcile", {
      limit: 100,
      ...(reconcileCursor ? { cursor: reconcileCursor } : {}),
    });
    pages++;
    reconcileCursor = repeated.next_cursor;
    if (!repeated.has_more) break;
    assert.ok(pages < 50, "Repeated repair must remain resumable");
  } while (reconcileCursor);
  const afterRepeat = (
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "SELECT source_id FROM resource_links WHERE target_id=$1 ORDER BY source_id",
        [target.id],
      ),
    )
  ).rows
    .map((x: any) => x.source_id)
    .sort();
  assert.equal(
    JSON.stringify(afterRepeat),
    snapshot,
    "Resource-link reconciliation is idempotent",
  );

  const foreignRepair = await ok(
    "POST",
    "/resource-links/reconcile",
    { limit: 1 },
    other,
  );
  assert.equal(
    foreignRepair.processed,
    0,
    "A different tenant cannot enumerate or repair this tenant's documents",
  );
});

test("W13c scoped cursor metadata excludes source kinds outside token scope", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c scoped target",
  });
  const pageSource = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c scoped page source",
  });
  const recordSource = randomUUID();
  const blocks = [
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          href: "/?page=" + target.id,
          content: [{ type: "text", text: "Scoped target", styles: {} }],
        },
      ],
    },
  ];
  await ok("PATCH", `/pages/${pageSource.id}/content`, {
    blocks,
    expected_revision: 1,
  });
  const serviceId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name,is_service) VALUES($1,$2,'W13 Scoped Reader',true)",
      [serviceId, serviceId + "@service.internal"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'guest')",
      [owner.tenant, serviceId],
    );
    await q.query(
      "INSERT INTO resources(id,tenant_id,parent_id,kind,title,updated_at)" +
        " VALUES($1,$2,$3,'record','W13c hidden-by-scope record',now()-interval '1 second')",
      [recordSource, owner.tenant, space.id],
    );
    await q.query(
      "INSERT INTO page_documents(tenant_id,resource_id,blocks,plain_text,y_state)" +
        " VALUES($1,$2,$3,'',decode('00','hex'))",
      [owner.tenant, recordSource, JSON.stringify(blocks)],
    );
    await q.query(
      "INSERT INTO resource_links(tenant_id,source_id,target_id) VALUES($1,$2,$3)",
      [owner.tenant, recordSource, target.id],
    );
    for (const resourceId of [root.id, target.id, pageSource.id, recordSource])
      await q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " VALUES($1,$2,$3,1) ON CONFLICT(tenant_id,resource_id,principal_id)" +
          " DO UPDATE SET level=EXCLUDED.level",
        [owner.tenant, resourceId, serviceId],
      );
    await q.query("UPDATE resources SET updated_at=now() WHERE id=$1", [
      pageSource.id,
    ]);
  });
  const serviceToken = await db.tenant(owner.tenant, (q) =>
    createSession(
      q,
      owner.tenant,
      serviceId,
      ["pages.read"],
      "W13 scoped reader",
    ),
  );
  const response = await req(
    "GET",
    `/resources/${target.id}/backlinks?limit=1`,
    undefined,
    null,
    { authorization: "Bearer " + serviceToken },
  );
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.deepEqual(
    result.items.map((x: any) => x.id),
    [pageSource.id],
  );
  assert.equal(
    result.has_more,
    false,
    "Scope-inaccessible record candidates must not influence continuation metadata",
  );
  assert.equal(result.next_cursor, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(recordSource),
    "Scoped result/cursor metadata must not reveal excluded record IDs",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /hidden-by-scope record/,
    "Scoped result must not reveal excluded record titles",
  );
});

test("W13c 10k backlink target is paged, ACL-safe and index-qualified", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c 10k backlink target",
  });
  const probeTarget = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W13c index probe target",
  });
  const size = 10000,
    hiddenCount = 5000,
    staleCount = 300;
  const ids = Array.from({ length: size }, () => randomUUID());
  const staleIds = ids.slice(hiddenCount, hiddenCount + staleCount);
  const restoreProbe = ids[hiddenCount + staleCount];
  const blocks = JSON.stringify([
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          href: "/?page=" + target.id,
          content: [{ type: "text", text: "Target", styles: {} }],
        },
      ],
    },
  ]);
  const staleBlocks = JSON.stringify([
    {
      type: "paragraph",
      content: "Conservative migration candidate /?page=" + target.id,
    },
  ]);
  const fixtureStarted = Date.now();
  try {
    await db.tenant(owner.tenant, async (q) => {
      await q.query(
        "INSERT INTO resources(id,tenant_id,parent_id,kind,title,position,updated_at)" +
          " SELECT x.id,$2::uuid,$3::uuid,'page'," +
          " 'W13c source '||x.n::text,x.n::float8," +
          " now()-(x.n::text||' milliseconds')::interval" +
          " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)",
        [ids, owner.tenant, space.id],
      );
      await q.query(
        "INSERT INTO page_documents(tenant_id,resource_id,blocks,plain_text,y_state)" +
          " SELECT $2::uuid,x.id,$3::jsonb,'',decode('00','hex')" +
          " FROM unnest($1::uuid[]) AS x(id)",
        [ids, owner.tenant, blocks],
      );
      await q.query(
        "UPDATE page_documents SET blocks=$2::jsonb" +
          " WHERE resource_id=ANY($1::uuid[])",
        [staleIds, staleBlocks],
      );
      await q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " SELECT $2::uuid,x.id,$3::text,0" +
          " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)" +
          " WHERE x.n<=$4",
        [ids, owner.tenant, member.id, hiddenCount],
      );
    });
    const fixtureMs = Date.now() - fixtureStarted;

    const backfillSql =
      "INSERT INTO resource_links(tenant_id,source_id,target_id,source_updated_at)" +
      " SELECT DISTINCT d.tenant_id,d.resource_id,(match.ids)[1]::uuid,source.updated_at" +
      " FROM page_documents d" +
      " JOIN resources source ON source.tenant_id=d.tenant_id" +
      " AND source.id=d.resource_id" +
      " CROSS JOIN LATERAL regexp_matches(" +
      " d.blocks::text," +
      " '[/]?[?]page=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})','g'" +
      " ) AS match(ids)" +
      " JOIN resources linked_target ON linked_target.tenant_id=d.tenant_id" +
      " AND linked_target.id=(match.ids)[1]::uuid" +
      " AND linked_target.kind IN ('page','record')" +
      " WHERE d.resource_id<>(match.ids)[1]::uuid" +
      " ON CONFLICT DO NOTHING";
    let backfillLocks: any[] = [],
      concurrentReadMs = 0;
    if (!pg.emulated) {
      const planned = await db.tenant(owner.tenant, (q) =>
        q.query("EXPLAIN (FORMAT JSON) " + backfillSql),
      );
      console.info(
        "W13_BACKFILL_PLAN " + JSON.stringify(planned.rows[0]["QUERY PLAN"]),
      );
    }
    const backfillStarted = Date.now();
    await db.tenant(owner.tenant, async (q) => {
      await q.query(backfillSql);
      if (!pg.emulated) {
        const pid = (await q.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        const readStarted = Date.now();
        const evidence = await db.tenant(owner.tenant, async (probe) => {
          const read = await probe.query(
            "SELECT count(*)::int n FROM resource_links" +
              " WHERE tenant_id=$1 AND target_id=$2",
            [owner.tenant, target.id],
          );
          const locks = await probe.query(
            "SELECT mode,granted FROM pg_locks" +
              " WHERE pid=$1 AND relation='resource_links'::regclass",
            [pid],
          );
          return { read: read.rows[0].n, locks: locks.rows };
        });
        concurrentReadMs = Date.now() - readStarted;
        backfillLocks = evidence.locks;
        assert.ok(
          concurrentReadMs < 5000,
          "Migration backfill must not block concurrent backlink reads",
        );
        assert.ok(
          backfillLocks.some(
            (lock: any) => lock.granted && lock.mode === "RowExclusiveLock",
          ),
          "Backfill evidence must capture the expected insert lock",
        );
        assert.ok(
          !backfillLocks.some(
            (lock: any) => lock.granted && lock.mode === "AccessExclusiveLock",
          ),
          "Backfill must not require an AccessExclusive lock on resource_links",
        );
      }
    });
    const backfillMs = Date.now() - backfillStarted;
    const edgeCount = await db.tenant(owner.tenant, (q) =>
      one(q, "SELECT count(*)::int n FROM resource_links WHERE target_id=$1", [
        target.id,
      ]),
    );
    assert.equal(
      edgeCount.n,
      size,
      "Set-based W13 migration/backfill must materialize canonical and conservative candidates",
    );
    const staleEdgeCount = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT count(*)::int n FROM resource_links" +
          " WHERE target_id=$1 AND source_id=ANY($2::uuid[])",
        [target.id, staleIds],
      ),
    );
    assert.equal(
      staleEdgeCount.n,
      staleCount,
      "Conservative backfill must include false-positive candidates for read-time canonical filtering",
    );
    assert.ok(
      backfillMs < 60000,
      "10k W13 backfill exceeded provisional 60s CI budget: " +
        backfillMs +
        "ms",
    );

    await ok("DELETE", `/resources/${restoreProbe}`);
    const deletedPage = await ok(
      "GET",
      `/resources/${target.id}/backlinks?limit=40`,
      undefined,
      member,
    );
    assert.ok(
      !deletedPage.items.some((row: any) => row.id === restoreProbe),
      "Deleted hot-target sources must disappear without graph cleanup",
    );
    const retainedProbe = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT count(*)::int n FROM resource_links" +
          " WHERE source_id=$1 AND target_id=$2",
        [restoreProbe, target.id],
      ),
    );
    assert.equal(
      retainedProbe.n,
      1,
      "Soft delete retains the candidate edge so restore stays cheap",
    );
    await ok("POST", `/resources/${restoreProbe}/restore`);
    const restoredPage = await ok(
      "GET",
      `/resources/${target.id}/backlinks?limit=40`,
      undefined,
      member,
    );
    assert.ok(
      restoredPage.items.some((row: any) => row.id === restoreProbe),
      "Restored hot-target source must recover on the next read",
    );

    const hidden = new Set(ids.slice(0, hiddenCount));
    const stale = new Set(staleIds);
    const latencies: number[] = [];
    const gathered: string[] = [];
    let cursor: string | null = null;
    const pageStarted = Date.now();
    for (let segment = 0; segment < 5; segment++) {
      const started = Date.now();
      const result = await ok(
        "GET",
        `/resources/${target.id}/backlinks?limit=40` +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        undefined,
        member,
      );
      latencies.push(Date.now() - started);
      assert.equal(
        result.items.length,
        40,
        "A hot target must return a full permission-filtered page",
      );
      assert.ok(
        result.items.every((row: any) => !hidden.has(row.id)),
        "Denied source IDs/titles may not enter backlink pages",
      );
      assert.ok(
        result.items.every((row: any) => !stale.has(row.id)),
        "Conservative false-positive candidates must never become disclosed backlinks",
      );
      gathered.push(...result.items.map((row: any) => row.id));
      cursor = result.next_cursor;
      assert.equal(result.has_more, true);
      assert.equal(typeof cursor, "string");
    }
    assert.equal(gathered.length, 200);
    assert.equal(
      new Set(gathered).size,
      200,
      "Stable backlink cursor pages must not duplicate unchanged sources",
    );
    const pageMs = Date.now() - pageStarted;
    latencies.sort((a, b) => a - b);
    const percentile = (p: number) =>
      latencies[
        Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)
      ];
    console.info(
      "W13_10K_BACKLINK_BENCH " +
        JSON.stringify({
          source_pages: size,
          hidden_sources: hiddenCount,
          stale_false_positive_candidates: staleCount,
          visible_canonical_sources: size - hiddenCount - staleCount,
          fixture_ms: fixtureMs,
          migration_backfill_ms: backfillMs,
          migration_concurrent_read_ms: concurrentReadMs,
          migration_lock_modes: backfillLocks
            .map((lock: any) => lock.mode)
            .sort(),
          five_page_ms: pageMs,
          page_p50_ms: percentile(0.5),
          page_p95_ms: percentile(0.95),
          returned: gathered.length,
        }),
    );
    assert.ok(
      pageMs < 30000,
      "10k W13 paginated ACL workload exceeded provisional 30s CI budget",
    );

    // Use a highly selective target to prove the target/source ordering index
    // is available to the exact lookup predicate used by the API.
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "INSERT INTO resource_links(tenant_id,source_id,target_id)" +
          " VALUES($1,$2,$3)",
        [owner.tenant, ids[hiddenCount], probeTarget.id],
      ),
    );
    if (!pg.emulated) {
      const explained = await db.tenant(owner.tenant, (q) =>
        q.query(
          "EXPLAIN (FORMAT JSON) SELECT source_id FROM resource_links" +
            " WHERE tenant_id=$1 AND target_id=$2" +
            " ORDER BY source_id LIMIT 100",
          [owner.tenant, probeTarget.id],
        ),
      );
      const plan = JSON.stringify(explained.rows[0]["QUERY PLAN"]);
      assert.match(
        plan,
        /resource_links_target/,
        "PostgreSQL must be able to use the W13 target lookup index",
      );
      console.info("W13_LINK_INDEX_PLAN " + plan);
    }
  } finally {
    await db.tenant(owner.tenant, async (q) => {
      await q.query("DELETE FROM resources WHERE id=ANY($1::uuid[])", [ids]);
      await q.query("DELETE FROM resources WHERE id=ANY($1::uuid[])", [
        [target.id, probeTarget.id],
      ]);
    });
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
test("W10c4f native: authenticated structural intents serialize, expire and recheck ACL", async () => {
  // Unlike two browser click promises, this test deliberately waits for a
  // *confirmed* reservation before dispatching the conflicting principal.
  // No test-only server backdoor or disabled security middleware is involved.
  const targetPage = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Structural lease integration",
  });
  const endpoint = "/pages/" + targetPage.id + "/content";
  const initial = await ok("GET", endpoint);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const seeded = await ok("PATCH", endpoint, {
    expected_revision: initial.revision,
    blocks: [
      {
        id: ids[0],
        type: "heading",
        props: { level: 2 },
        content: "Lease heading",
      },
      {
        id: ids[1],
        type: "callout",
        props: { variant: "warning" },
        content: "Lease target",
      },
      { id: ids[2], type: "quote", content: "Never remove this quote" },
    ],
  });
  const a = await connect(owner, targetPage),
    b = await connect(member, targetPage);
  type StructuralReply = { type: string; reason?: string };
  async function reserve(
    client: typeof a,
    blockId: string,
    overrideVector?: string,
  ): Promise<StructuralReply> {
    const requestId = randomUUID();
    return await new Promise<StructuralReply>((resolve, reject) => {
      const listener = ({ payload }: { payload: string }) => {
        let reply: StructuralReply & { requestId?: string };
        try {
          reply = JSON.parse(payload);
        } catch {
          return;
        }
        if (reply.requestId !== requestId) return;
        clearTimeout(timer);
        client.provider.off("stateless", listener);
        resolve(reply);
      };
      const timer = setTimeout(() => {
        client.provider.off("stateless", listener);
        reject(Error("Structural reservation did not answer within 6s"));
      }, 6000);
      client.provider.on("stateless", listener);
      client.provider.sendStateless(
        JSON.stringify({
          type: "structural.acquire",
          requestId,
          blockId,
          vector:
            overrideVector ??
            Buffer.from(Y.encodeStateVector(client.doc)).toString("base64"),
        }),
      );
    });
  }
  try {
    await until(() =>
      Buffer.from(Y.encodeStateVector(a.doc)).equals(
        Buffer.from(Y.encodeStateVector(b.doc)),
      ),
    );
    const originalVector = Buffer.from(Y.encodeStateVector(a.doc)).toString(
      "base64",
    );
    const first = await reserve(a, ids[1]);
    assert.equal(first.type, "structural.granted");
    const competing = await reserve(b, ids[1]);
    assert.equal(competing.type, "structural.denied");
    assert.equal(
      competing.reason,
      "concurrent-edit",
      "A confirmed same-block reservation must exclude a second principal",
    );
    const repeat = await reserve(a, ids[0]);
    assert.equal(
      repeat.reason,
      "concurrent-edit",
      "One connection must not hold multiple reservations",
    );
    const forged = await reserve(b, randomUUID());
    assert.equal(forged.reason, "missing-block");
    const stale = await reserve(b, ids[2], Buffer.from([0]).toString("base64"));
    assert.equal(stale.reason, "document-changed");
    assert.deepEqual(
      (await ok("GET", endpoint)).blocks.map((v: any) => v.id),
      ids,
      "Reservation requests alone must not change canonical persisted blocks",
    );

    // A client may crash or disappear after a grant: the next authenticated
    // principal must regain control once the bounded lease expires.
    await pause(8600);
    const recovered = await reserve(b, ids[1]);
    assert.equal(
      recovered.type,
      "structural.granted",
      "Expired reservations must not permanently block editing",
    );
    b.doc.getMap("structural-lease-proof").set("written", randomUUID());
    await until(
      async () => (await ok("GET", endpoint)).revision > seeded.revision,
    );
    // A matching document write should release the lease on persistence,
    // not block the room until the full 8-second timeout.
    const afterWrite = await reserve(a, ids[1]);
    assert.equal(
      afterWrite.type,
      "structural.granted",
      "Persistence must release an exercised reservation",
    );
    assert.deepEqual(
      (await ok("GET", endpoint)).blocks.map((v: any) => v.id),
      ids,
    );

    // Revocation cannot be bypassed with a still-live connection or a
    // previously encoded Yjs state-vector. No unauthorized grant is issued.
    await permissionPatch("/resources/" + targetPage.id + "/permissions", {
      inherit: true,
      grants: [{ principal_id: member.id, level: 2 }],
    });
    const denied = await reserve(b, ids[1], originalVector);
    assert.equal(denied.type, "structural.denied");
    assert.ok(
      ["read-only", "document-changed"].includes(denied.reason || ""),
      "Permission downgrade or stale document must fail closed",
    );
  } finally {
    a.provider.destroy();
    b.provider.destroy();
  }
});

test("W11a comment anchors require canonical same-page Yjs ID and current revision", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W11a canonical comment target",
  });
  const foreign = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W11a unrelated private page",
  });
  const endpoint = "/pages/" + target.id + "/content";
  const first = await ok("GET", endpoint);
  const anchor = randomUUID(),
    otherAnchor = randomUUID();
  const saved = await ok("PATCH", endpoint, {
    expected_revision: first.revision,
    blocks: [
      {
        id: anchor,
        type: "heading",
        props: { level: 2 },
        content: "Target block must be anchored by ID",
      },
    ],
  });
  const foreignInitial = await ok("GET", "/pages/" + foreign.id + "/content");
  await ok("PATCH", "/pages/" + foreign.id + "/content", {
    expected_revision: foreignInitial.revision,
    blocks: [
      { id: otherAnchor, type: "quote", content: "Not in the target page" },
    ],
  });
  const url = "/resources/" + target.id + "/comments";
  const valid = {
    body: "Review this precise heading",
    block_id: anchor,
    expected_revision: saved.revision,
  };
  const posted = await ok("POST", url, valid);
  assert.equal(posted.block_id, anchor);
  const comments = await ok("GET", url);
  assert.equal(
    comments.filter((c: any) => c.id === posted.id)[0].block_id,
    anchor,
  );
  assert.equal(
    (await req("POST", url, { body: "Unversioned", block_id: anchor }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await req("POST", url, {
        body: "Malformed",
        block_id: "../../other",
        expected_revision: saved.revision,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req("POST", url, {
        body: "Other page",
        block_id: otherAnchor,
        expected_revision: saved.revision,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await req("POST", url, {
        body: "Unknown ID",
        block_id: randomUUID(),
        expected_revision: saved.revision,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await req("POST", url, valid, other)).statusCode,
    404,
    "Cross-tenant owner cannot forge a comment on a known page",
  );
  const updated = await ok("PATCH", endpoint, {
    expected_revision: saved.revision,
    blocks: [
      {
        id: anchor,
        type: "heading",
        props: { level: 2 },
        content: "Same ID, newer canonical revision",
      },
    ],
  });
  assert.equal(
    (await req("POST", url, valid)).statusCode,
    409,
    "A stale page revision must reject even a still-present block ID",
  );
  const current = await ok("POST", url, {
    ...valid,
    expected_revision: updated.revision,
  });
  assert.equal(current.block_id, anchor);
  assert.equal(
    (
      await req("POST", url, {
        body: "No anchor",
        expected_revision: updated.revision,
      })
    ).statusCode,
    400,
  );
  const legacy = await ok("POST", url, {
    body: "Resource-wide discussion remains valid",
  });
  assert.equal(
    legacy.block_id,
    undefined,
    "Legacy unanchored comments remain supported",
  );
  assert.equal((await ok("GET", url)).length, 3);
});

test("W11c native replies stay on the same resource and revoked mentions vanish", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W11c reply scope",
  });
  const foreign = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W11c unrelated thread",
  });
  const targetUrl = "/resources/" + target.id + "/comments";
  const otherUrl = "/resources/" + foreign.id + "/comments";
  const otherRoot = await ok("POST", otherUrl, { body: "Other resource root" });
  const initial = await ok("GET", "/pages/" + target.id + "/content");
  const anchoredId = randomUUID();
  const seeded = await ok("PATCH", "/pages/" + target.id + "/content", {
    expected_revision: initial.revision,
    blocks: [{ id: anchoredId, type: "quote", content: "Thread target" }],
  });
  const root = await ok("POST", targetUrl, {
    body: "Discuss this quote @{" + member.id + "}",
    block_id: anchoredId,
    expected_revision: seeded.revision,
  });
  assert.equal(root.parent_comment_id, null);
  const first = await ok(
    "POST",
    targetUrl,
    {
      body: "Answer without a stale anchor precondition",
      reply_to: root.id,
    },
    member,
  );
  assert.equal(first.parent_comment_id, root.id);
  assert.equal(first.block_id, anchoredId);
  const second = await ok("POST", targetUrl, {
    body: "Another participant",
    reply_to: root.id,
  });
  assert.equal(second.parent_comment_id, root.id);
  const listed = await ok("GET", targetUrl);
  assert.deepEqual(
    listed
      .filter((comment: any) => comment.parent_comment_id === root.id)
      .map((comment: any) => comment.id)
      .sort(),
    [first.id, second.id].sort(),
  );
  assert.equal(
    (
      await req("POST", targetUrl, {
        body: "Foreign root",
        reply_to: otherRoot.id,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await req("POST", targetUrl, {
        body: "Nested reply",
        reply_to: first.id,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req("POST", targetUrl, {
        body: "Malformed reply",
        reply_to: "not-a-uuid",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req("POST", targetUrl, {
        body: "Reply may not replace its inherited anchor",
        reply_to: root.id,
        block_id: randomUUID(),
        expected_revision: seeded.revision,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "POST",
        targetUrl,
        {
          body: "Cross tenant",
          reply_to: root.id,
        },
        other,
      )
    ).statusCode,
    404,
  );
  // The composite database FK must also reject bypassing the API to
  // manufacture a cross-page link within a tenant.
  await assert.rejects(
    db.tenant(owner.tenant, (q) =>
      q.query(
        "INSERT INTO comments(id,tenant_id,resource_id,author_id,body,parent_comment_id) VALUES($1,$2,$3,$4,'forged',$5)",
        [randomUUID(), owner.tenant, target.id, owner.id, otherRoot.id],
      ),
    ),
    /foreign key|violates|constraint/i,
  );
  await ok("PATCH", targetUrl + "/" + root.id, { resolved: true });
  assert.equal(
    (
      await req("POST", targetUrl, {
        body: "Cannot reply to a resolved root",
        reply_to: root.id,
      })
    ).statusCode,
    409,
  );
  // Mentions are read-time permission-scoped, not a durable disclosure.
  const initialNotifications = await ok(
    "GET",
    "/notifications",
    undefined,
    member,
  );
  assert.ok(
    initialNotifications.some((entry: any) => entry.resource_id === target.id),
  );
  await permissionPatch("/resources/" + target.id + "/permissions", {
    inherit: true,
    grants: [{ principal_id: member.id, level: 0 }],
  });
  const after = await ok("GET", "/notifications", undefined, member);
  assert.ok(
    !after.some((entry: any) => entry.resource_id === target.id),
    "Revoked member must not read the old notification text or page ID",
  );
  assert.equal(
    (await req("GET", targetUrl, undefined, member)).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        "POST",
        targetUrl,
        {
          body: "No post after revocation",
          reply_to: root.id,
        },
        member,
      )
    ).statusCode,
    404,
  );
  await ok("DELETE", targetUrl + "/" + root.id);
  const afterDelete = await ok("GET", targetUrl);
  assert.equal(
    afterDelete.filter((c: any) => c.parent_comment_id === root.id).length,
    0,
    "Deleting the parent must remove dependent replies via database constraint",
  );
});

test("W11c concurrent resolve and reply serialize on the parent row lock", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Thread resolve serialization",
  });
  const url = "/resources/" + target.id + "/comments";
  const rootComment = await ok("POST", url, { body: "Race root" });
  let signal!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const untilReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = db.tenant(owner.tenant, async (q) => {
    // A root resolve holds PostgreSQL's normal non-key UPDATE lock.
    // KEY SHARE is compatible with this lock and would allow the reply to
    // race past the resolution check. FOR SHARE must wait.
    await q.query("SELECT id FROM comments WHERE id=$1 FOR NO KEY UPDATE", [
      rootComment.id,
    ]);
    signal();
    await untilReleased;
    await q.query("UPDATE comments SET resolved=true WHERE id=$1", [
      rootComment.id,
    ]);
  });
  await ready;
  let finished = false;
  const pending = req("POST", url, {
    body: "Reply must not win",
    reply_to: rootComment.id,
  }).finally(() => {
    finished = true;
  });
  try {
    // Assert the compatibility underlying the production row lock directly:
    // FOR SHARE must conflict with the parent's ordinary non-key UPDATE lock.
    await assert.rejects(
      db.tenant(owner.tenant, (q) =>
        q.query("SELECT id FROM comments WHERE id=$1 FOR SHARE NOWAIT", [
          rootComment.id,
        ]),
      ),
      /could not obtain lock on row|55P03/,
    );
    // The actual reply HTTP transaction must remain pending while the root
    // is locked. This is tested with its genuine Fastify/PG path, not a stub.
    await pause(300);
    assert.equal(
      finished,
      false,
      "Reply cannot pass an unresolved parent whose row is held for update",
    );
  } finally {
    release();
    await transaction;
  }
  const denied = await pending;
  assert.equal(denied.statusCode, 409, denied.body);
  const rows = await ok("GET", url);
  assert.deepEqual(
    rows.filter((c: any) => c.parent_comment_id === rootComment.id),
    [],
    "No reply is committed after the parent resolves",
  );
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
    (await ok("GET", "/search?q=Live", undefined, member)).items.length,
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
  assert.match(
    adminExport.body,
    /id,action,actor,resource_id,request_id,created_at/,
  );

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
    assert(deliveries.some((d: any) => d.status === "retry"));
    assert.equal(redirectTargetHit, false);
  } finally {
    receiver.close();
    redirect.close();
    redirectTarget.close();
  }
});
test("W20 webhook leases prevent double-claim and recover after expiry", async () => {
  const seen: string[] = [];
  let releaseResponse = () => {};
  let firstArrived = () => {};
  let hold = false;
  const receiver = createServer(async (r, res) => {
    const eventId = String(r.headers["x-workspace-event"] || "");
    seen.push(eventId);
    firstArrived();
    if (hold)
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
    res.end("ok");
  });
  await new Promise<void>((resolve) =>
    receiver.listen(49664, "127.0.0.1", resolve),
  );
  process.env.WEBHOOK_ALLOWED_ORIGINS = "http://127.0.0.1:49664";
  try {
    const subscription = await ok("POST", "/webhooks", {
      url: "http://127.0.0.1:49664/w20",
      events: ["page.lease_test"],
    });
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    await db.tenant(owner.tenant, async (q) => {
      await q.query(
        "INSERT INTO event_outbox(id,tenant_id,actor_id,type,resource_id,version,dispatched_at)" +
          " VALUES($1,$2,$3,'page.lease_test',$4,1,now())",
        [eventId, owner.tenant, owner.id, page.id],
      );
      await q.query(
        "INSERT INTO webhook_deliveries" +
          "(id,tenant_id,subscription_id,event_id,lease_token,lease_expires_at)" +
          " VALUES($1,$2,$3,$4,$5,now()+interval '30 seconds')",
        [deliveryId, owner.tenant, subscription.id, eventId, randomUUID()],
      );
    });

    // A live lease represents a worker that may still be performing the HTTP
    // request. Another worker tick must not deliver the same event.
    await tick(db);
    assert.equal(seen.filter((id) => id === eventId).length, 0);

    // Simulate the original worker dying: once the lease expires the delivery
    // becomes claimable again.
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "UPDATE webhook_deliveries SET lease_expires_at=now()-interval '1 second'" +
          " WHERE id=$1",
        [deliveryId],
      ),
    );

    hold = true;
    const arrived = new Promise<void>((resolve) => {
      firstArrived = resolve;
    });
    const firstWorker = tick(db);
    await arrived;

    // The first worker has committed its lease before beginning network I/O,
    // so a second tick can run without blocking on that delivery and must not
    // send a duplicate request.
    const secondWorker = tick(db);
    await pause(150);
    assert.equal(seen.filter((id) => id === eventId).length, 1);

    hold = false;
    releaseResponse();
    await Promise.all([firstWorker, secondWorker]);

    const final = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT status,attempts,lease_token,lease_expires_at" +
          " FROM webhook_deliveries WHERE id=$1",
        [deliveryId],
      ),
    );
    assert.equal(final.status, "delivered");
    assert.equal(final.attempts, 1);
    assert.equal(final.lease_token, null);
    assert.equal(final.lease_expires_at, null);
    assert.equal(seen.filter((id) => id === eventId).length, 1);
  } finally {
    receiver.close();
  }
});

test("W20 unacknowledged delivery resumes after lease expiry and revocation cancels leases", async () => {
  const seen: string[] = [];
  const receiver = createServer(async (r, res) => {
    seen.push(String(r.headers["x-workspace-event"] || ""));
    res.end("ok");
  });
  await new Promise<void>((resolve) =>
    receiver.listen(49712, "127.0.0.1", resolve),
  );
  process.env.WEBHOOK_ALLOWED_ORIGINS = "http://127.0.0.1:49712";
  try {
    const subscription = await ok("POST", "/webhooks", {
      url: "http://127.0.0.1:49712/w20b",
      events: ["page.lease_crash"],
    });
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    await db.tenant(owner.tenant, async (q) => {
      await q.query(
        "INSERT INTO event_outbox(id,tenant_id,actor_id,type,resource_id,version,dispatched_at)" +
          " VALUES($1,$2,$3,'page.lease_crash',$4,1,now())",
        [eventId, owner.tenant, owner.id, page.id],
      );
      await q.query(
        "INSERT INTO webhook_deliveries(id,tenant_id,subscription_id,event_id)" +
          " VALUES($1,$2,$3,$4)",
        [deliveryId, owner.tenant, subscription.id, eventId],
      );
    });

    // Model a worker that sent the request but died before acknowledging: the
    // row is still retryable and carries a lease the dead worker never cleared.
    // At-least-once is the documented contract, so the receiver must dedupe.
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "UPDATE webhook_deliveries SET status='retry',attempts=1," +
          " lease_token=$2, lease_expires_at=now()+interval '25 seconds'" +
          " WHERE id=$1",
        [deliveryId, randomUUID()],
      ),
    );
    await tick(db);
    assert.equal(
      seen.filter((id) => id === eventId).length,
      0,
      "An unexpired lease owned by another worker must not be reclaimed",
    );

    // Lease state stays tenant-scoped: another tenant's administrator cannot
    // observe this delivery or its lease through the administrative surface.
    const otherView = await ok("GET", "/webhooks", undefined, other);
    assert.equal(JSON.stringify(otherView).includes(deliveryId), false);

    // Once the lease expires the delivery is claimable again, is sent exactly
    // once and finalizes with a clean lease and an incremented attempt count.
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "UPDATE webhook_deliveries SET lease_expires_at=now()-interval '1 second'" +
          " WHERE id=$1",
        [deliveryId],
      ),
    );
    for (
      let attempt = 0;
      attempt < 5 && seen.filter((id) => id === eventId).length === 0;
      attempt++
    )
      await tick(db);
    assert.equal(
      seen.filter((id) => id === eventId).length,
      1,
      "An expired lease must become claimable and deliver the event once",
    );
    const finalized = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT status,attempts,lease_token,lease_expires_at" +
          " FROM webhook_deliveries WHERE id=$1",
        [deliveryId],
      ),
    );
    assert.equal(finalized.status, "delivered");
    assert.equal(finalized.attempts, 2);
    assert.equal(finalized.lease_token, null);
    assert.equal(finalized.lease_expires_at, null);

    // A revoked subscription must cancel pending leased deliveries and must
    // never send them, even though the lease row still exists.
    const revoked = await ok("POST", "/webhooks", {
      url: "http://127.0.0.1:49712/w20c",
      events: ["page.lease_revoked"],
    });
    const revokedEvent = randomUUID();
    const revokedDelivery = randomUUID();
    await db.tenant(owner.tenant, async (q) => {
      await q.query(
        "INSERT INTO event_outbox(id,tenant_id,actor_id,type,resource_id,version,dispatched_at)" +
          " VALUES($1,$2,$3,'page.lease_revoked',$4,1,now())",
        [revokedEvent, owner.tenant, owner.id, page.id],
      );
      await q.query(
        "INSERT INTO webhook_deliveries(id,tenant_id,subscription_id,event_id," +
          "status,lease_token,lease_expires_at)" +
          " VALUES($1,$2,$3,$4,'pending',$5,now()+interval '30 seconds')",
        [revokedDelivery, owner.tenant, revoked.id, revokedEvent, randomUUID()],
      );
      await q.query("UPDATE webhook_subscriptions SET active=false WHERE id=$1", [
        revoked.id,
      ]);
    });
    await tick(db);
    assert.equal(seen.includes(revokedEvent), false);
    const cancelled = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT status,lease_token,lease_expires_at FROM webhook_deliveries" +
          " WHERE id=$1",
        [revokedDelivery],
      ),
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.lease_token, null);
    assert.equal(cancelled.lease_expires_at, null);
  } finally {
    receiver.close();
  }
});

test("W20 secret activation fails closed while a crashed worker holds a live lease", async () => {
  process.env.WEBHOOK_ALLOWED_ORIGINS = "http://127.0.0.1:49713";
  const subscription = await ok("POST", "/webhooks", {
    url: "http://127.0.0.1:49713/w20d",
    events: ["page.lease_activate"],
  });
  const endpoint = `/webhooks/${subscription.id}/secret-rotation`;
  const prepared = await ok("POST", endpoint, { expected_revision: 1 });
  assert.equal(prepared.signing_revision, 2);
  assert.notEqual(prepared.secret, subscription.secret);
  const eventId = randomUUID();
  const deliveryId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO event_outbox(id,tenant_id,actor_id,type,resource_id,version,dispatched_at)" +
        " VALUES($1,$2,$3,'page.lease_activate',$4,1,now())",
      [eventId, owner.tenant, owner.id, page.id],
    );
    await q.query(
      "INSERT INTO webhook_deliveries(id,tenant_id,subscription_id,event_id," +
        "status,lease_token,lease_expires_at)" +
        " VALUES($1,$2,$3,$4,'pending',$5,now()+interval '25 seconds')",
      [deliveryId, owner.tenant, subscription.id, eventId, randomUUID()],
    );
  });

  // A delivery that may still be signing with the old secret must not be
  // superseded by activation. The bounded wait expires and fails closed.
  const refused = await req("POST", endpoint + "/activate", {
    expected_revision: 2,
  });
  assert.equal(refused.statusCode, 409, refused.body);
  const unchanged = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT signing_revision,secret_encrypted,pending_secret_encrypted" +
        " FROM webhook_subscriptions WHERE id=$1",
      [subscription.id],
    ),
  );
  assert.equal(unchanged.signing_revision, 2);
  assert.notEqual(unchanged.pending_secret_encrypted, null);
  assert.equal(decrypt(unchanged.secret_encrypted), subscription.secret);

  // An expired lease permits progress instead of blocking rotation forever.
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE webhook_deliveries SET lease_expires_at=now()-interval '1 second'" +
        " WHERE id=$1",
      [deliveryId],
    ),
  );
  await ok("POST", endpoint + "/activate", { expected_revision: 2 });
  const rotated = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT signing_revision,pending_secret_encrypted" +
        " FROM webhook_subscriptions WHERE id=$1",
      [subscription.id],
    ),
  );
  assert.equal(rotated.signing_revision, 3);
  assert.equal(rotated.pending_secret_encrypted, null);
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
    one(
      q,
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
  assert.equal(
    (await req("POST", "/webhooks/deliveries/not-a-uuid/replay", {}))
      .statusCode,
    400,
  );
  const initial = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT status,attempts,last_error FROM webhook_deliveries WHERE id=$1",
      [deliveryId],
    ),
  );
  assert.deepEqual(
    [initial.status, initial.attempts, initial.last_error],
    ["dead", 8, "HTTP 503"],
  );
  const replay = await ok("POST", endpoint, {});
  assert.deepEqual(replay, { ok: true, id: deliveryId, status: "pending" });
  assert.equal((await req("POST", endpoint, {})).statusCode, 404);
  const resumed = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT status,attempts,last_error FROM webhook_deliveries WHERE id=$1",
      [deliveryId],
    ),
  );
  assert.deepEqual(
    [resumed.status, resumed.attempts, resumed.last_error],
    ["pending", 0, null],
  );
  const audit = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT action FROM audit_events WHERE actor_id=$1" +
        " AND action='integration.delivery_replayed' ORDER BY created_at DESC LIMIT 1",
      [owner.id],
    ),
  );
  assert.equal(audit?.action, "integration.delivery_replayed");

  // A paused subscription must not be reactivated through delivery replay.
  await ok("PATCH", `/webhooks/${subscription.id}`, { active: false });
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE webhook_deliveries SET status='dead' WHERE id=$1", [
      deliveryId,
    ]),
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
    // Earlier integration tests enqueue legitimate events for this tenant;
    // a single worker tick need not reach this specific delivery when its
    // bounded batch contains older jobs. Retain a finite retry budget and
    // require the exact event ID (not just any HTTP request).
    for (
      let attempt = 0;
      attempt < 12 &&
      !received.some((entry) => entry.headers["x-workspace-event"] === eventId);
      attempt++
    )
      await tick(db);
    assert.ok(
      received.some((entry) => entry.headers["x-workspace-event"] === eventId),
      "The staged rotation test event must actually be delivered",
    );
    verify(subscription.secret);
    const activate = endpoint + "/activate";
    assert.equal((await req("POST", activate, precondition)).statusCode, 409);
    assert.equal(
      (await req("POST", activate, { expected_revision: 2 }, other)).statusCode,
      404,
    );

    if (!pg.emulated) {
      // Native CI also proves activation cannot race a delivery using the old
      // secret: the worker now holds a live delivery lease across its HTTP send
      // instead of a subscription read lock, so activation waits for the
      // in-flight delivery to finish before switching the effective secret.
      await db.tenant(owner.tenant, (q) =>
        q.query(
          "UPDATE webhook_deliveries SET status='pending'," +
            " next_at='1970-01-01T00:00:00Z'::timestamptz WHERE id=$1",
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
    // The replayed delivery competes with older pending jobs in the worker's
    // bounded batch, so a single tick need not reach it. Retain a finite retry
    // budget and require a fresh delivery of the exact event ID before
    // verifying the activated secret.
    const replayedBefore = received.filter(
      (r) => r.headers["x-workspace-event"] === eventId,
    ).length;
    for (
      let attempt = 0;
      attempt < 12 &&
      received.filter((r) => r.headers["x-workspace-event"] === eventId)
        .length <= replayedBefore;
      attempt++
    )
      await tick(db);
    assert.ok(
      received.filter((r) => r.headers["x-workspace-event"] === eventId)
        .length > replayedBefore,
      "The replayed delivery must actually be dispatched",
    );
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

test("W09 queued jobs cancel safely and expired running leases recover", async () => {
  const cancelledTitle = "W09 cancelled " + randomUUID().slice(0, 8);
  const queued = await ok("POST", "/imports", {
    parent_id: space.id,
    name: cancelledTitle,
    format: "markdown",
    content: "# Must not execute",
  });
  const cancelled = await ok("POST", `/jobs/${queued.id}/cancel`, {});
  assert.deepEqual(cancelled, { id: queued.id, status: "cancelled" });
  assert.equal((await ok("GET", `/jobs/${queued.id}`)).status, "cancelled");
  await tick(db);
  const cancelledRows = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT id FROM resources WHERE title=$1", [cancelledTitle]),
  );
  assert.equal(cancelledRows.rowCount, 0, "cancelled queued job must never execute");
  assert.equal(
    (await req("POST", `/jobs/${queued.id}/cancel`, {})).statusCode,
    409,
  );

  const archiveSource = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W09 staged archive source " + randomUUID().slice(0, 8),
  });
  const exportedArchive = await req(
    "GET",
    `/resources/${archiveSource.id}/export/archive`,
    undefined,
    owner,
  );
  assert.equal(exportedArchive.statusCode, 200, exportedArchive.body);
  const staged = await req(
    "POST",
    `/imports/archive?parent_id=${space.id}`,
    exportedArchive.rawPayload,
    owner,
    { "content-type": "application/zip" },
  );
  assert.equal(staged.statusCode, 200, staged.body);
  const stagedJob = staged.json();
  const stagedArtifact = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT id,object_key FROM job_artifacts WHERE job_id=$1 AND kind='input'",
      [stagedJob.id],
    ),
  );
  assert.ok(stagedArtifact?.object_key);
  await ok("POST", `/jobs/${stagedJob.id}/cancel`, {});
  assert.equal(
    await db.tenant(owner.tenant, async (q) =>
      Number(
        (
          await one(q, "SELECT count(*) n FROM job_artifacts WHERE job_id=$1", [
            stagedJob.id,
          ])
        ).n,
      ),
    ),
    0,
  );
  const cancelledDeletion = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT status,reason FROM object_deletions WHERE object_key=$1",
      [stagedArtifact.object_key],
    ),
  );
  assert.deepEqual(
    [cancelledDeletion.status, cancelledDeletion.reason],
    ["pending", "job_cancelled"],
  );

  const recoveredTitle = "W09 recovered " + randomUUID().slice(0, 8);
  const crashed = await ok("POST", "/imports", {
    parent_id: space.id,
    name: recoveredTitle,
    format: "markdown",
    content: "# Crash recovery",
  });
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE jobs SET status='running',lease_token=$2," +
        " lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [crashed.id, randomUUID()],
    ),
  );

  // Running work is not interruptible through the user API. Once the crashed
  // worker's lease expires, another worker may reclaim the same job.
  assert.equal(
    (await req("POST", `/jobs/${crashed.id}/cancel`, {})).statusCode,
    409,
  );
  await tick(db);
  const recovered = await ok("GET", `/jobs/${crashed.id}`);
  assert.equal(recovered.status, "completed");
  const lifecycle = await db.tenant(owner.tenant, (q) =>
    one(
      q,
      "SELECT status,attempts,lease_token,lease_expires_at,started_at,completed_at" +
        " FROM jobs WHERE id=$1",
      [crashed.id],
    ),
  );
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.attempts, 1);
  assert.equal(lifecycle.lease_token, null);
  assert.equal(lifecycle.lease_expires_at, null);
  assert.ok(lifecycle.started_at);
  assert.ok(lifecycle.completed_at);
  const recoveredRows = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT id FROM resources WHERE title=$1", [recoveredTitle]),
  );
  assert.equal(recoveredRows.rowCount, 1);

  const exportSource = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W09 retry-stable export " + randomUUID().slice(0, 8),
  });
  const exportJob = await ok(
    "POST",
    `/resources/${exportSource.id}/export/archive/jobs`,
    {},
  );
  const exportKey = `${owner.tenant}/${exportSource.id}/${exportJob.id}`;
  const stored = new Map<string, Buffer>([
    [exportKey, Buffer.from("orphaned-prior-attempt")],
  ]);
  const retryStorage = {
    async put(key: string, bytes: Buffer) {
      if (stored.has(key)) throw new Error("immutable object already exists");
      stored.set(key, Buffer.from(bytes));
    },
    async get(key: string) {
      const value = stored.get(key);
      if (!value) throw new Error("missing test object");
      return Buffer.from(value);
    },
    async delete(key: string) {
      stored.delete(key);
    },
    async health() {},
  };
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE jobs SET status='running',lease_token=$2," +
        " lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [exportJob.id, randomUUID()],
    ),
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    await tick(db, retryStorage as any, fakeAntivirus);
    const status = await db.tenant(owner.tenant, (q) =>
      one(q, "SELECT status FROM jobs WHERE id=$1", [exportJob.id]),
    );
    if (status?.status === "completed") break;
  }
  const recoveredExport = await ok("GET", `/jobs/${exportJob.id}`);
  assert.equal(recoveredExport.status, "completed");
  const archiveBytes = stored.get(exportKey);
  assert.ok(archiveBytes);
  assert.equal(archiveBytes!.subarray(0, 2).toString(), "PK");
  assert.notEqual(
    archiveBytes!.toString(),
    "orphaned-prior-attempt",
    "recovered export must replace the orphan from the dead attempt",
  );
});

test("W09 archive import recovery replaces retry-stable orphan objects", async () => {
  const source = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W09 retry-stable import " + randomUUID().slice(0, 8),
  });
  const boundary = "w09-retry-boundary";
  const fileBytes = Buffer.from("W09 retry-stable attachment bytes");
  const multipart =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="retry.txt"\r\n` +
    "Content-Type: text/plain\r\n\r\n" +
    fileBytes.toString() +
    `\r\n--${boundary}--\r\n`;
  const uploaded = await req(
    "POST",
    `/resources/${source.id}/files`,
    multipart,
    owner,
    { "content-type": `multipart/form-data; boundary=${boundary}` },
  );
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const sourceFileId = uploaded.json().id;

  const exported = await req(
    "GET",
    `/resources/${source.id}/export/archive`,
    undefined,
    owner,
  );
  assert.equal(exported.statusCode, 200, exported.body);
  const staged = await req(
    "POST",
    `/imports/archive?parent_id=${space.id}`,
    exported.rawPayload,
    owner,
    { "content-type": "application/zip" },
  );
  assert.equal(staged.statusCode, 200, staged.body);
  const job = staged.json();

  const targetResourceId = retryUuid(job.id, "resource", source.id);
  const targetFileId = retryUuid(job.id, "file", sourceFileId);
  const orphanKey = `${owner.tenant}/${targetResourceId}/${targetFileId}`;
  const storage = createStorage();
  await storage.put(
    orphanKey,
    Buffer.from("orphaned-import-attempt"),
    "text/plain",
  );
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE jobs SET status='running',lease_token=$2," +
        " lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [job.id, randomUUID()],
    ),
  );

  await tick(db, storage, fakeAntivirus);
  const recovered = await ok("GET", `/jobs/${job.id}`);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.result.report.files, 1);
  assert.deepEqual(await storage.get(orphanKey), fileBytes);
  storage.close?.();
});

test("imports run asynchronously and recheck current permissions", async () => {
  const runOwnedJob = async (id: string, actor = member) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await tick(db);
      const job = await ok("GET", `/jobs/${id}`, undefined, actor);
      if (job.status !== "pending") return job;
    }
    assert.fail(
      "Import job did not leave pending state within bounded worker ticks",
    );
  };
  const runJobStatus = async (id: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await tick(db);
      const status = await db.tenant(owner.tenant, (q) =>
        one(q, "SELECT status FROM jobs WHERE id=$1", [id]),
      );
      if (status?.status !== "pending") return status;
    }
    assert.fail(
      "Import job did not leave pending state within bounded worker ticks",
    );
  };
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
  const job = await runOwnedJob(j.id, member);
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
  assert.equal((await runOwnedJob(csv.id, owner)).status, "completed");
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
  const status = await runJobStatus(denied.id);
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
  const upload = await req(
    "POST",
    `/resources/${doomed.id}/files`,
    data,
    owner,
    {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
  );
  assert.equal(upload.statusCode, 200, upload.body);
  const stored = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT object_key FROM files WHERE id=$1", [upload.json().id]),
  );
  await ok("DELETE", `/resources/${doomed.id}`);
  await ok("DELETE", `/resources/${doomed.id}/purge`);
  assert.equal(
    await db.tenant(owner.tenant, async (q) =>
      Number(
        (
          await one(q, "SELECT count(*) n FROM resources WHERE id=$1", [
            doomed.id,
          ])
        ).n,
      ),
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
    q.query(
      "UPDATE resources SET deleted_at=now()-interval '2 days' WHERE id=$1",
      [expired.id],
    ),
  );
  await tick(db);
  assert.equal(
    await db.tenant(owner.tenant, async (q) =>
      Number(
        (
          await one(q, "SELECT count(*) n FROM resources WHERE id=$1", [
            expired.id,
          ])
        ).n,
      ),
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
    assert.equal(
      (await req("GET", "/identity/providers", undefined, null)).statusCode,
      401,
    );
    assert.equal(
      (await req("GET", "/identity/providers", undefined, viewer)).statusCode,
      403,
    );
    assert.equal(
      (await req("POST", "/identity/providers", registration, viewer))
        .statusCode,
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
    assert.doesNotMatch(
      JSON.stringify(listed),
      /test-only-credential|client_secret_encrypted/,
    );
    const stored = await db.tenant(owner.tenant, (q) =>
      one(
        q,
        "SELECT client_secret_encrypted,enabled FROM oidc_tenant_providers WHERE id=$1",
        [registered.id],
      ),
    );
    assert.match(stored.client_secret_encrypted, /^oidc-v1\./);
    assert.doesNotMatch(stored.client_secret_encrypted, /test-only-credential/);
    const { openTenantOidcSecret } =
      await import("../packages/auth/tenant-provider.ts");
    assert.equal(
      openTenantOidcSecret(
        stored.client_secret_encrypted,
        owner.tenant,
        registered.id,
      ),
      registration.client_secret,
    );
    assert.throws(() =>
      openTenantOidcSecret(
        stored.client_secret_encrypted,
        otherOwner.tenant,
        registered.id,
      ),
    );
    const invisible = await db.tenant(otherOwner.tenant, (q) =>
      one(q, "SELECT id FROM oidc_tenant_providers WHERE id=$1", [
        registered.id,
      ]),
    );
    assert.equal(invisible, undefined);

    // Same client ID and issuer are allowed in a different tenant.
    const otherRegistration = await ok(
      "POST",
      "/identity/providers",
      registration,
      otherOwner,
    );
    assert.equal(otherRegistration.enabled, false);
    assert.notEqual(otherRegistration.id, registered.id);
    assert.ok(
      !(await ok("GET", "/identity/providers", undefined, otherOwner)).some(
        (p: any) => p.id === registered.id,
      ),
    );
    const crossTenantRevoke = await req(
      "DELETE",
      "/identity/providers/" + registered.id,
      undefined,
      otherOwner,
    );
    assert.equal(crossTenantRevoke.statusCode, 404, crossTenantRevoke.body);
    assert.equal(
      (
        await req(
          "DELETE",
          "/identity/providers/" + otherRegistration.id,
          undefined,
          viewer,
        )
      ).statusCode,
      403,
    );

    const revoked = await ok("DELETE", "/identity/providers/" + registered.id);
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revision, 2);
    assert.equal(
      (await req("DELETE", "/identity/providers/" + registered.id)).statusCode,
      404,
    );
    assert.ok(
      (await ok("GET", "/identity/providers")).some(
        (p: any) => p.id === registered.id && p.revoked_at,
      ),
    );
    assert.ok(
      (await ok("GET", "/identity/providers", undefined, otherOwner)).some(
        (p: any) => p.id === otherRegistration.id && !p.revoked_at,
      ),
    );
    const methods = await req("GET", "/auth/methods", undefined, null);
    assert.equal(methods.statusCode, 200);
    assert.equal(methods.json().oidc.label, "Test SSO");
  } finally {
    if (savedOrigins === undefined)
      delete process.env.OIDC_TENANT_ISSUER_ORIGINS;
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
  const expected = sorted
    .filter((item) => item.resource_id === root.id)
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
      assert.ok(
        !actual.includes(e.id),
        "each accessible event is returned once",
      );
      actual.push(e.id);
    }
    cursor = page.next_cursor;
  }
  assert.deepEqual(actual, expected);

  // A validly signed cursor must not transfer to another principal or tenant.
  const forged = cursor!.slice(0, -2) + "xx";
  assert.equal(
    (await req("GET", "/events/cursor?cursor=" + encodeURIComponent(forged)))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        "/events/cursor?cursor=" +
          encodeURIComponent(cursor!) +
          "&since=" +
          encodeURIComponent(since),
      )
    ).statusCode,
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
    (
      await req(
        "GET",
        "/events/cursor?cursor=" + encodeURIComponent(cursor!),
        undefined,
        otherOwner,
      )
    ).statusCode,
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
    (
      await req(
        "GET",
        "/events/cursor?cursor=" + encodeURIComponent(cursor!),
        undefined,
        null,
        { authorization: "Bearer " + service },
      )
    ).statusCode,
    400,
  );
  const deniedScope = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, guestId, ["pages.read"], "No events scope"),
  );
  assert.equal(
    (
      await req("GET", "/events/cursor", undefined, null, {
        authorization: "Bearer " + deniedScope,
      })
    ).statusCode,
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
      [reconcileUser, reconcileUser + "@service.internal"],
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
    createSession(
      q,
      owner.tenant,
      reconcileUser,
      ["events.read", "workspace.read", "pages.read", "databases.read"],
      "Reconcile reader",
    ),
  );
  const read = (path: string, authToken = token) =>
    req("GET", path, undefined, null, { authorization: "Bearer " + authToken });
  const scan = async (forbidden: string | null = hiddenId) => {
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    let emptyWithMore = false;
    for (let n = 0; n < 250; n++) {
      const url =
        "/events/reconcile?limit=1" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      const result = await read(url);
      assert.equal(result.statusCode, 200, result.body);
      const body = result.json();
      assert.ok(body.resources.length <= 1);
      assert.match(body.next_cursor, /^reconcile-v1\./);
      if (forbidden)
        assert.ok(
          !result.body.includes(forbidden),
          "inaccessible IDs must not leak in fields or opaque cursors",
        );
      if (!body.resources.length && body.has_more) emptyWithMore = true;
      seen.push(...body.resources.map((v: any) => v.id));
      cursors.push(body.next_cursor);
      cursor = body.next_cursor;
      if (!body.has_more) return { seen, cursors, emptyWithMore };
    }
    throw Error("Reconciliation pagination did not terminate");
  };
  const first = await scan();
  assert.ok(
    first.emptyWithMore,
    "inaccessible raw positions can yield empty pages",
  );
  assert.ok(first.seen.includes(publicId));
  assert.ok(first.seen.includes(laterId));
  assert.ok(!first.seen.includes(hiddenId));
  assert.equal(new Set(first.seen).size, first.seen.length);
  assert.ok(first.seen.includes(root.id));
  assert.ok(!first.cursors.some((c) => c.includes(hiddenId)));

  const firstCursor = first.cursors[0];
  const forged = firstCursor.slice(0, -3) + "abc";
  assert.equal(
    (await read("/events/reconcile?cursor=" + encodeURIComponent(forged)))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        "/events/reconcile?cursor=" + encodeURIComponent(firstCursor),
        undefined,
        owner,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        "/events/reconcile?cursor=" + encodeURIComponent(firstCursor),
        undefined,
        other,
      )
    ).statusCode,
    400,
  );
  assert.equal((await read("/events/reconcile?limit=101")).statusCode, 400);
  assert.equal(
    (await read("/events/reconcile?cursor=" + "x".repeat(2050))).statusCode,
    400,
  );
  // A correctly authenticated but expired scan position is rejected rather than
  // silently resuming a stale full-scan pass.
  const expiredCursor = encodeReconcileCursor(
    beginReconcileCursor(
      owner.tenant,
      reconcileUser,
      Math.floor(Date.now() / 1000) - 7200,
    ),
  );
  assert.equal(
    (await read("/events/reconcile?cursor=" + encodeURIComponent(expiredCursor)))
      .statusCode,
    400,
  );
  const noEventScope = await db.tenant(owner.tenant, (q) =>
    createSession(
      q,
      owner.tenant,
      reconcileUser,
      ["pages.read"],
      "No event scope",
    ),
  );
  assert.equal((await read("/events/reconcile", noEventScope)).statusCode, 403);
  const noPageScope = await db.tenant(owner.tenant, (q) =>
    createSession(
      q,
      owner.tenant,
      reconcileUser,
      ["events.read", "workspace.read"],
      "No page scope",
    ),
  );
  const restricted = await read("/events/reconcile?limit=100", noPageScope);
  assert.equal(restricted.statusCode, 200);
  assert.ok(
    !restricted
      .json()
      .resources.some((v: any) => [hiddenId, publicId, laterId].includes(v.id)),
  );

  // A fresh full pass discovers a new grant and later observes revocation;
  // a partial pass is never authoritative to delete cached evidence.
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "DELETE FROM acl WHERE tenant_id=$1 AND resource_id=$2 AND principal_id=$3",
      [owner.tenant, hiddenId, reconcileUser],
    ),
  );
  // A grant arriving behind the original keyset position must not make a
  // prior continuation silently rewind. A new full pass will discover it.
  const resumed = await read(
    "/events/reconcile?limit=1&cursor=" + encodeURIComponent(firstCursor),
  );
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.ok(!resumed.json().resources.some((v: any) => v.id === hiddenId));
  assert.ok((await scan(null)).seen.includes(hiddenId));
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,0)",
      [owner.tenant, hiddenId, reconcileUser],
    ),
  );
  const revoked = await scan();
  assert.ok(!revoked.seen.includes(hiddenId));
  assert.ok(first.seen.filter((id) => !revoked.seen.includes(id)).length === 0);
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE resources SET deleted_at=now() WHERE id=$1", [publicId]),
  );
  const afterDelete = await scan();
  assert.ok(!afterDelete.seen.includes(publicId));
  assert.ok(revoked.seen.includes(publicId));
});

test("recently viewed lists personal visits, not other users' edits, and revokes access", async () => {
  // A separate Fastify instance keeps the exact production throttling policy
  // while isolating this regression's budget from the long-running suite.
  const recentApp = await buildApp(
    db,
    undefined,
    false,
    fakeOidc,
    fakeAntivirus,
  );
  const recentReq = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    data?: any,
    actor: any = owner,
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
    path: string,
    data?: any,
    actor: any = owner,
  ) => {
    const response = await recentReq(method, path, data, actor);
    assert.ok(
      response.statusCode < 300,
      `${method} ${path}: ${response.statusCode} ${response.body}`,
    );
    return response.json();
  };
  try {
    const folder = await recentOk("POST", "/resources", {
      kind: "space",
      parent_id: root.id,
      title: "Personal recents acceptance",
    });
    const first = await recentOk("POST", "/resources", {
      kind: "page",
      parent_id: folder.id,
      title: "Visited only once",
    });
    const second = await recentOk("POST", "/resources", {
      kind: "page",
      parent_id: folder.id,
      title: "Visited last",
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
      cookie: "workspace_session=" + peerToken,
      csrf: csrf(peerToken),
    };
    const before = await recentOk("GET", "/resources?recent=true");
    assert.ok(
      !before.some((n: any) => [first.id, second.id].includes(n.id)),
      "creating and editing a page is not a visit",
    );

    assert.deepEqual(
      (await recentOk("GET", "/resources?recent=true", undefined, peer)).filter(
        (n: any) => [first.id, second.id].includes(n.id),
      ),
      [],
    );
    await recentOk("POST", `/resources/${first.id}/bookmark`, {});
    await new Promise<void>((resolve) => setTimeout(resolve, 8));
    await recentOk("POST", `/resources/${second.id}/bookmark`, {});
    let recentlyViewed = await recentOk("GET", "/resources?recent=true");
    assert.deepEqual(
      recentlyViewed
        .filter((n: any) => [first.id, second.id].includes(n.id))
        .map((n: any) => n.id),
      [second.id, first.id],
    );
    assert.ok(recentlyViewed.find((n: any) => n.id === second.id)?.viewed_at);

    // A different member has an independent timeline, even in the same tenant.
    assert.equal(
      (await recentOk("GET", "/resources?recent=true", undefined, peer)).some(
        (n: any) => n.id === first.id,
      ),
      false,
    );
    await recentOk("POST", `/resources/${first.id}/bookmark`, {}, peer);
    recentlyViewed = await recentOk(
      "GET",
      "/resources?recent=true",
      undefined,
      peer,
    );
    assert.ok(recentlyViewed.some((n: any) => n.id === first.id));
    assert.ok(!recentlyViewed.some((n: any) => n.id === second.id));

    // Current ACLs are applied on read, not only when the visit is written.
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " VALUES($1,$2,$3,0) ON CONFLICT(tenant_id,resource_id,principal_id)" +
          " DO UPDATE SET level=0",
        [owner.tenant, folder.id, peerId],
      ),
    );
    recentlyViewed = await recentOk(
      "GET",
      "/resources?recent=true",
      undefined,
      peer,
    );
    assert.ok(!recentlyViewed.some((n: any) => n.id === first.id));
    assert.equal(
      (await recentReq("POST", `/resources/${first.id}/bookmark`, {}, peer))
        .statusCode,
      404,
    );
    assert.ok(
      (await recentOk("GET", "/resources?recent=true")).some(
        (n: any) => n.id === first.id,
      ),
      "owner's timeline is unaffected by peer revocation",
    );
    assert.equal(
      (await recentOk("GET", "/resources?recent=true", undefined, other)).some(
        (n: any) => n.id === first.id,
      ),
      false,
      "the same global user in another tenant cannot see visits",
    );

    await recentOk("DELETE", `/resources/${second.id}`);
    assert.equal(
      (await recentOk("GET", "/resources?recent=true")).some(
        (n: any) => n.id === second.id,
      ),
      false,
      "trashed pages are excluded from personal history",
    );
  } finally {
    await recentApp.close();
  }
});

test("rate limit: verified principals are independent, headers and forged tokens cannot spoof identity", async () => {
  // Same Fastify production middleware and isolated limiter store, not a
  // bypass/relaxed test configuration.
  const limitedApp = await buildApp(
    db,
    undefined,
    false,
    fakeOidc,
    fakeAntivirus,
  );
  const hit = (url: string, cookie?: string, forwarded?: string) =>
    limitedApp.inject({
      method: "GET",
      url,
      remoteAddress: "198.51.100.9",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(forwarded
          ? { "x-forwarded-for": forwarded, "x-real-ip": forwarded }
          : {}),
      },
    });
  const remaining = (response: any) =>
    Number(response.headers["x-ratelimit-remaining"]);
  try {
    // Earlier revocation/offboarding tests intentionally invalidate some
    // shared fixtures. Use fresh active credentials here.
    const memberId = randomUUID();
    await db.tenant(owner.tenant, async (q) => {
      await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
        memberId,
        memberId + "@example.test",
        "Rate limit member",
      ]);
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
        [owner.tenant, memberId],
      );
    });
    const memberToken = await db.tenant(owner.tenant, (q) =>
      createSession(q, owner.tenant, memberId),
    );
    const otherToken = await db.tenant(other.tenant, (q) =>
      createSession(q, other.tenant, owner.id),
    );
    const ownerFirst = await hit("/api/v1/me", owner.cookie);
    const ownerSecond = await hit("/api/v1/me", owner.cookie);
    const memberFirst = await hit(
      "/api/v1/me",
      "workspace_session=" + memberToken,
    );
    const otherTenant = await hit(
      "/api/v1/me",
      "workspace_session=" + otherToken,
    );
    for (const result of [ownerFirst, ownerSecond, memberFirst, otherTenant])
      assert.equal(result.statusCode, 200, result.body);
    assert.equal(remaining(ownerSecond), remaining(ownerFirst) - 1);
    assert.equal(
      remaining(memberFirst),
      remaining(ownerFirst),
      "the second authenticated user gets an independent limit",
    );
    assert.equal(
      remaining(otherTenant),
      remaining(ownerFirst),
      "a separate tenant gets an independent limit",
    );

    // Authentication routes retain the IP/network limiter even when a
    // valid logged-in user's cookie is sent to a public endpoint.
    const unauth = await hit("/api/v1/auth/methods", undefined, "203.0.113.5");
    const publicWithCookie = await hit(
      "/api/v1/auth/methods",
      owner.cookie,
      "203.0.113.99",
    );
    assert.equal(unauth.statusCode, 200);
    assert.equal(publicWithCookie.statusCode, 200);
    assert.equal(remaining(publicWithCookie), remaining(unauth) - 1);

    // Network-key exhaustion cannot be avoided by rotating forwarding
    // headers. The direct Fastify deployment intentionally distrusts them.
    let blocked: any;
    for (let n = 0; n < 301; n++) {
      const response = await hit(
        "/api/v1/auth/methods",
        undefined,
        "2001:db8::" + (n + 100).toString(16),
      );
      if (response.statusCode === 429) {
        blocked = response;
        break;
      }
    }
    assert.ok(
      blocked,
      "forged XFF addresses did not evade the 300/min ceiling",
    );
    assert.ok(Number(blocked.headers["retry-after"]) >= 0);

    // New forged session values don't turn invalid requests into
    // principal-key requests; the unauthenticated network budget stays
    // exhausted and rejects them before any protected operation.
    const fake = await hit(
      "/api/v1/me",
      "workspace_session=forged-" + randomUUID(),
      "192.0.2.111",
    );
    assert.equal(fake.statusCode, 429, fake.body);
  } finally {
    await limitedApp.close();
  }
});

test("W05 relation references: write validation, ACL redaction, export, and schema safety", async () => {
  const clients = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W05 Clients",
  });
  const projects = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W05 Projects",
  });
  const client = await ok("POST", `/databases/${clients.id}/records`, {
    values: { name: "W05 Client: Island Foods" },
  });
  const fields = [
    { id: "name", name: "Name", type: "title" },
    {
      id: "client_ref",
      name: "Client",
      type: "relation",
      target_database_id: clients.id,
    },
  ];
  await ok("PATCH", `/databases/${projects.id}`, { properties: fields });
  assert.equal(
    (
      await req("POST", `/databases/${projects.id}/records`, {
        values: { name: "Broken", client_ref: [randomUUID()] },
      })
    ).statusCode,
    404,
  );
  const forbiddenView = await req("POST", `/databases/${projects.id}/views`, {
    name: "Restricted reference search",
    config: {
      type: "table",
      filters: [{ property: "client_ref", op: "contains", value: client.id }],
      sort: [],
    },
  });
  assert.equal(
    forbiddenView.statusCode,
    400,
    "raw relation filters must not reveal hidden references",
  );
  const forbiddenSort = await req("POST", `/databases/${projects.id}/views`, {
    name: "Restricted reference sort",
    config: {
      type: "table",
      filters: [],
      sort: [{ property: "client_ref", direction: "asc" }],
    },
  });
  assert.equal(
    forbiddenSort.statusCode,
    400,
    "sorting relation UUIDs is not a supported ACL-safe operation",
  );
  const project = await ok("POST", `/databases/${projects.id}/records`, {
    values: { name: "W05 Project Falcon", client_ref: [client.id] },
  });
  assert.deepEqual(project.values.client_ref, [client.id]);
  const recordRead = await ok("GET", `/records/${project.id}`);
  assert.deepEqual(recordRead.values.client_ref, [client.id]);
  const listing = await ok("GET", `/databases/${projects.id}/records`);
  assert.deepEqual(
    listing.find((v: any) => v.id === project.id)?.values.client_ref,
    [client.id],
  );
  const choices = await ok(
    "GET",
    `/databases/${projects.id}/relation-candidates?property=client_ref&search=Island`,
  );
  assert.ok(choices.items.some((item: any) => item.id === client.id));
  const targets = await ok(
    "GET",
    `/databases/${projects.id}/relation-targets?search=Clients`,
  );
  assert.ok(targets.items.some((item: any) => item.id === clients.id));
  const saved = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT search_text FROM resources WHERE id=$1", [project.id]),
  );
  assert.ok(
    !String(saved.search_text).includes(client.id),
    "related-record UUID must not become searchable text",
  );

  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,'W05 Peer')", [
      peerId,
      peerId + "@example.test",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
  });
  const peerToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = {
    cookie: "workspace_session=" + peerToken,
    csrf: csrf(peerToken),
  };
  assert.deepEqual(
    (await ok("GET", `/records/${project.id}`, undefined, peer)).values
      .client_ref,
    [client.id],
  );
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,0) ON CONFLICT(tenant_id,resource_id,principal_id)" +
        " DO UPDATE SET level=0",
      [owner.tenant, clients.id, peerId],
    ),
  );
  const hidden = await ok("GET", `/records/${project.id}`, undefined, peer);
  assert.deepEqual(hidden.values.client_ref, []);
  assert.equal(
    hidden.properties.find((v: any) => v.id === "client_ref")
      .target_database_id,
    undefined,
  );
  const collection = await ok(
    "GET",
    `/databases/${projects.id}/records`,
    undefined,
    peer,
  );
  assert.deepEqual(
    collection.find((v: any) => v.id === project.id).values.client_ref,
    [],
  );
  const safeExport = await ok(
    "GET",
    `/resources/${projects.id}/export?format=json`,
    undefined,
    peer,
  );
  assert.ok(
    !JSON.stringify(safeExport).includes(client.id),
    "export must not leak hidden record UUID",
  );
  assert.ok(
    !JSON.stringify(safeExport).includes(clients.id),
    "export must not leak revoked target database UUID",
  );
  const inaccessibleTargets = await ok(
    "GET",
    `/databases/${projects.id}/relation-targets?search=W05%20Clients&limit=1`,
    undefined,
    peer,
  );
  assert.deepEqual(inaccessibleTargets.items, []);
  assert.equal(
    inaccessibleTargets.has_more,
    false,
    "paging must not reveal hidden relation targets",
  );
  const forbiddenPicker = await req(
    "GET",
    `/databases/${projects.id}/relation-candidates?property=client_ref`,
    undefined,
    peer,
  );
  assert.equal(forbiddenPicker.statusCode, 404);
  const stale = await ok("GET", `/records/${project.id}`, undefined, peer);
  const updated = await ok(
    "PATCH",
    `/records/${project.id}`,
    {
      values: { name: "W05 Project Falcon updated" },
      expected_revision: stale.revision,
    },
    peer,
  );
  assert.deepEqual(
    updated.values.client_ref,
    [],
    "unrelated edits must not reveal existing revoked references",
  );
  const incompatible = await req("PATCH", `/databases/${projects.id}`, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "client_ref", name: "Client", type: "text" },
    ],
  });
  assert.equal(
    incompatible.statusCode,
    400,
    "populated relations cannot silently convert to text",
  );
  const unchanged = await ok("GET", `/databases/${projects.id}`);
  assert.equal(
    unchanged.properties.find((p: any) => p.id === "client_ref").type,
    "relation",
    "invalid schema conversion must roll back",
  );
});

test("W06 numeric formulas: read-only recomputation, revisions and exports", async () => {
  const formulaDatabase = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W06 Formula records",
  });
  const databaseRoute = "/databases/" + formulaDatabase.id;
  const schema = [
    { id: "name", name: "Name", type: "title" },
    { id: "units", name: "Units", type: "number" },
    { id: "price", name: "Price", type: "number" },
    {
      id: "gross",
      name: "Gross",
      type: "formula",
      formula: "[units] * [price] + 2.5",
    },
  ];
  await ok("PATCH", databaseRoute, { properties: schema });
  const definition = await ok("GET", databaseRoute);
  assert.equal(
    definition.properties.find((f: any) => f.id === "gross").formula,
    "[units] * [price] + 2.5",
  );
  const row = await ok("POST", databaseRoute + "/records", {
    values: { name: "W06 Orders", units: 3, price: 4 },
  });
  const recordRoute = "/records/" + row.id;
  assert.equal(row.values.gross, 14.5);
  assert.equal((await ok("GET", recordRoute)).values.gross, 14.5);
  const table = await ok("GET", databaseRoute + "/records");
  assert.equal(
    table.find((item: any) => item.id === row.id).values.gross,
    14.5,
  );
  const jsonExport = await ok(
    "GET",
    "/resources/" + formulaDatabase.id + "/export?format=json",
  );
  assert.equal(
    jsonExport.records.find((item: any) => item.id === row.id).values.gross,
    14.5,
  );
  const csvExport = await req(
    "GET",
    "/resources/" + formulaDatabase.id + "/export?format=csv",
  );
  assert.equal(csvExport.statusCode, 200, csvExport.body);
  assert.match(csvExport.body, /14\.5/);

  const blockedWrite = await req("PATCH", recordRoute, {
    expected_revision: row.revision,
    values: { gross: 99999 },
  });
  assert.equal(
    blockedWrite.statusCode,
    400,
    "clients cannot modify computed values or bypass formulas",
  );
  const changedRow = await ok("PATCH", recordRoute, {
    expected_revision: row.revision,
    values: { units: 5 },
  });
  assert.equal(changedRow.values.gross, 22.5);
  assert.equal((await ok("GET", recordRoute)).values.gross, 22.5);
  const stale = await req("PATCH", recordRoute, {
    expected_revision: row.revision,
    values: { units: 7 },
  });
  assert.equal(stale.statusCode, 409);

  const badDefinition = await req("PATCH", databaseRoute, {
    properties: schema.map((f) =>
      f.id === "gross" ? { ...f, formula: "eval(1)" } : f,
    ),
  });
  assert.equal(badDefinition.statusCode, 400);
  const unknownField = await req("PATCH", databaseRoute, {
    properties: schema.map((f) =>
      f.id === "gross" ? { ...f, formula: "[hidden]+1" } : f,
    ),
  });
  assert.equal(unknownField.statusCode, 400);
  const unsafeReference = await req("PATCH", databaseRoute, {
    properties: schema.map((f) =>
      f.id === "gross" ? { ...f, formula: "[gross]+1" } : f,
    ),
  });
  assert.equal(unsafeReference.statusCode, 400);
  const noRawQuery = await req("POST", databaseRoute + "/views", {
    name: "Unsupported computed predicate",
    config: {
      type: "table",
      filters: [{ property: "gross", op: "eq", value: "14.5" }],
      sort: [],
    },
  });
  assert.equal(noRawQuery.statusCode, 400);
  const restored = await ok("GET", databaseRoute);
  assert.equal(
    restored.properties.find((p: any) => p.id === "gross").formula,
    "[units] * [price] + 2.5",
    "invalid schema change must not mutate the accepted expression",
  );
});

test("W07 Rollup native: hide revoked links in all aggregates and exports", async () => {
  const target = await ok("POST", "/resources", {
    kind: "database",
    title: "W07 Targets",
    parent_id: space.id,
  });
  const source = await ok("POST", "/resources", {
    kind: "database",
    title: "W07 Source",
    parent_id: space.id,
  });
  const targetPath = "/databases/" + target.id;
  const sourcePath = "/databases/" + source.id;
  await ok("PATCH", targetPath, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "amount", name: "Amount", type: "number" },
    ],
  });
  const first = await ok("POST", targetPath + "/records", {
    values: { name: "W07 Visible", amount: 10 },
  });
  const second = await ok("POST", targetPath + "/records", {
    values: { name: "W07 Confidential", amount: 900 },
  });
  const props = [
    { id: "name", name: "Name", type: "title" },
    {
      id: "links",
      name: "Clients",
      type: "relation",
      target_database_id: target.id,
    },
    {
      id: "count",
      name: "Linked count",
      type: "rollup",
      rollup_relation_id: "links",
      rollup_operation: "count",
    },
    {
      id: "total",
      name: "Linked total",
      type: "rollup",
      rollup_relation_id: "links",
      rollup_operation: "sum",
      rollup_value_property_id: "amount",
    },
    {
      id: "average",
      name: "Linked average",
      type: "rollup",
      rollup_relation_id: "links",
      rollup_operation: "avg",
      rollup_value_property_id: "amount",
    },
  ];
  await ok("PATCH", sourcePath, { properties: props });
  const item = await ok("POST", sourcePath + "/records", {
    values: { name: "W07 Project", links: [first.id, second.id] },
  });
  assert.deepEqual(
    [item.values.count, item.values.total, item.values.average],
    [2, 910, 455],
  );
  const recordPath = "/records/" + item.id;
  const freshRead = await ok("GET", recordPath);
  assert.equal(freshRead.values.total, 910);

  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,'W07 Peer')", [
      peerId,
      peerId + "@example.test",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
  });
  const peerToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = {
    cookie: "workspace_session=" + peerToken,
    csrf: csrf(peerToken),
  };
  assert.equal((await ok("GET", recordPath, undefined, peer)).values.count, 2);

  // Revoke just the expensive target record without removing source access.
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,0)" +
        " ON CONFLICT(tenant_id,resource_id,principal_id)" +
        " DO UPDATE SET level=0",
      [owner.tenant, second.id, peerId],
    ),
  );
  const redacted = await ok("GET", recordPath, undefined, peer);
  assert.deepEqual(redacted.values.links, [first.id]);
  assert.deepEqual(
    [redacted.values.count, redacted.values.total, redacted.values.average],
    [1, 10, 10],
    "no aggregate may include revoked numeric contributions",
  );
  const listing = await ok("GET", sourcePath + "/records", undefined, peer);
  const peerRow = listing.find((r: any) => r.id === item.id);
  assert.equal(peerRow.values.count, 1);
  assert.equal(peerRow.values.total, 10);
  assert.equal(JSON.stringify(peerRow).includes(second.id), false);
  const exported = await ok(
    "GET",
    "/resources/" + source.id + "/export?format=json",
    undefined,
    peer,
  );
  const exportedRow = exported.records.find((row: any) => row.id === item.id);
  assert.ok(exportedRow, "Peer export must include the readable source record");
  assert.ok(!JSON.stringify(exportedRow.values).includes(second.id));
  assert.equal(exportedRow.values.count, 1);
  assert.equal(exportedRow.values.total, 10);
  assert.equal(exportedRow.values.average, 10);
  const exportedCsv = await req(
    "GET",
    "/resources/" + source.id + "/export?format=csv",
    undefined,
    peer,
  );
  assert.equal(exportedCsv.statusCode, 200);
  assert.ok(!exportedCsv.body.includes(second.id));
  assert.ok(!exportedCsv.body.includes("910"));

  // Updates to a currently readable target update the computed value.
  const edited = await ok("PATCH", "/records/" + first.id, {
    values: { amount: 15 },
    expected_revision: first.revision,
  });
  assert.equal(edited.values.amount, 15);
  assert.equal((await ok("GET", recordPath, undefined, peer)).values.total, 15);

  const rejectedComputed = await req("PATCH", recordPath, {
    expected_revision: item.revision,
    values: { total: 999 },
  });
  assert.equal(rejectedComputed.statusCode, 400);
  const badSchema = await req("PATCH", sourcePath, {
    properties: props.map((p) =>
      p.id === "total"
        ? { ...p, rollup_value_property_id: "hidden_column" }
        : p,
    ),
  });
  assert.equal(badSchema.statusCode, 400);
  const noSort = await req("POST", sourcePath + "/views", {
    name: "Unsafe rollup sort",
    config: {
      type: "table",
      filters: [],
      sort: [{ property: "count", direction: "desc" }],
    },
  });
  assert.equal(noSort.statusCode, 400);
  const unchanged = await ok("GET", sourcePath);
  assert.equal(
    unchanged.properties.find((p: any) => p.id === "total")
      .rollup_value_property_id,
    "amount",
  );
  // Deleting the remaining linked record must not expose a stale count.
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE resources SET deleted_at=now() WHERE id=$1", [first.id]),
  );
  const deleted = await ok("GET", recordPath, undefined, peer);
  assert.equal(deleted.values.count, 0);
  assert.equal(deleted.values.total, 0);
  assert.equal(deleted.values.average, null);
});

test("W08 permission-first pages: accessible records are not lost behind hidden rows", async () => {
  const dataset = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08 ACL pagination",
  });
  const resourceIds: string[] = [];
  for (let i = 0; i < 7; i++) {
    const row = await ok("POST", "/databases/" + dataset.id + "/records", {
      values: { name: "W08 Row " + String(i).padStart(2, "0") },
    });
    resourceIds.push(row.id);
  }
  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,'W08 Peer')", [
      peerId,
      peerId + "@example.test",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
    for (const hiddenId of resourceIds.slice(0, 3))
      await q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " VALUES($1,$2,$3,0)",
        [owner.tenant, hiddenId, peerId],
      );
  });
  const peerToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = {
    cookie: "workspace_session=" + peerToken,
    csrf: csrf(peerToken),
  };
  const path = "/databases/" + dataset.id + "/records?limit=2";
  const page1 = await ok("GET", path + "&offset=0", undefined, peer);
  assert.deepEqual(
    page1.map((row: any) => row.id),
    resourceIds.slice(3, 5),
    "first page must contain two readable records, not two raw SQL rows",
  );
  const page2 = await ok("GET", path + "&offset=2", undefined, peer);
  assert.deepEqual(
    page2.map((row: any) => row.id),
    resourceIds.slice(5, 7),
    "offset counts accessible rows, not hidden source rows",
  );
  assert.equal(
    (await ok("GET", path + "&offset=4", undefined, peer)).length,
    0,
  );
  for (const row of [...page1, ...page2])
    assert.ok(!resourceIds.slice(0, 3).includes(row.id));
  const ownerPage = await ok("GET", path + "&offset=0");
  assert.deepEqual(
    ownerPage.map((row: any) => row.id),
    resourceIds.slice(0, 2),
  );

  // Candidate picker must paginate over readable choices, not raw rows.
  const source = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08 Picker source",
  });
  await ok("PATCH", "/databases/" + source.id, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      {
        id: "links",
        name: "Links",
        type: "relation",
        target_database_id: dataset.id,
      },
    ],
  });
  const candidatesPath =
    "/databases/" + source.id + "/relation-candidates?property=links&limit=2";
  const candidateFirst = await ok(
    "GET",
    candidatesPath + "&offset=0",
    undefined,
    peer,
  );
  const candidateNext = await ok(
    "GET",
    candidatesPath + "&offset=2",
    undefined,
    peer,
  );
  assert.deepEqual(
    candidateFirst.items.map((row: any) => row.id),
    resourceIds.slice(3, 5),
  );
  assert.equal(candidateFirst.has_more, true);
  assert.deepEqual(
    candidateNext.items.map((row: any) => row.id),
    resourceIds.slice(5, 7),
  );
  assert.equal(candidateNext.has_more, false);

  const hiddenTarget = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08-Picker A hidden",
  });
  const visibleTarget = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08-Picker B visible",
  });
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,0)",
      [owner.tenant, hiddenTarget.id, peerId],
    ),
  );
  const targetSearch = await ok(
    "GET",
    "/databases/" +
      source.id +
      "/relation-targets?search=W08-Picker&limit=1&offset=0",
    undefined,
    peer,
  );
  assert.deepEqual(
    targetSearch.items.map((row: any) => row.id),
    [visibleTarget.id],
    "picker must never reveal inaccessible databases in offset/has_more",
  );
  assert.equal(targetSearch.has_more, false);

  // ACL changes must take effect immediately; do not use a stale cache.
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "DELETE FROM acl WHERE tenant_id=$1 AND resource_id=$2 AND principal_id=$3",
      [owner.tenant, resourceIds[0], peerId],
    ),
  );
  const afterGrant = await ok("GET", path + "&offset=0", undefined, peer);
  assert.deepEqual(
    afterGrant.map((row: any) => row.id),
    [resourceIds[0], resourceIds[3]],
  );
  const predicate = await db.tenant(owner.tenant, (q) =>
    q.query(
      "SELECT workspace_can_read_resource(id,$2::uuid,'member') allowed" +
        " FROM resources WHERE id=ANY($1::uuid[]) ORDER BY position",
      [resourceIds, peerId],
    ),
  );
  assert.deepEqual(
    predicate.rows.map((row: any) => row.allowed),
    [true, false, false, true, true, true, true],
    "database predicate must honor current per-resource denials and grants",
  );
  const guestDenied = await db.tenant(owner.tenant, (q) =>
    q.query(
      "SELECT workspace_can_read_resource($1::uuid,$2::uuid,'guest') allowed",
      [dataset.id, peerId],
    ),
  );
  assert.equal(
    guestDenied.rows[0].allowed,
    false,
    "guest cannot acquire inherited access without an explicit ancestor grant",
  );
  const spoof = await db.tenant(owner.tenant, (q) =>
    q.query(
      "SELECT workspace_can_read_resource($1::uuid,$2::uuid,'owner') forged," +
        " workspace_can_read_resource($1::uuid,$2::uuid,NULL) missing",
      [resourceIds[3], peerId],
    ),
  );
  assert.deepEqual(
    spoof.rows[0],
    { forged: false, missing: false },
    "predicate must not permit forged owner or absent caller roles",
  );
  const foreignTenant = await db.tenant(other.tenant, (q) =>
    q.query(
      "SELECT workspace_can_read_resource($1::uuid,$2::uuid,'owner') allowed",
      [dataset.id, peerId],
    ),
  );
  assert.equal(
    foreignTenant.rows[0].allowed,
    false,
    "SQL access predicate stays restricted to current tenant RLS",
  );

  // Explicitly exercise the unusual early-zero semantics shared with the
  // existing JS evaluator, including inherited reset and wildcard priority.
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE resources SET inherit_permissions=false WHERE id=$1", [
      dataset.id,
    ]),
  );
  const check = (user: string, role: string, id: string) =>
    db.tenant(owner.tenant, (q) =>
      q.query(
        "SELECT workspace_can_read_resource($1::uuid,$2::uuid,$3) allowed",
        [id, user, role],
      ),
    );
  assert.equal(
    (await check(peerId, "member", resourceIds[3])).rows[0].allowed,
    false,
    "ACL reset without grant denies children",
  );
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,3)",
      [owner.tenant, dataset.id, peerId],
    ),
  );
  assert.equal(
    (await check(peerId, "member", resourceIds[3])).rows[0].allowed,
    true,
    "same-node explicit grant restores inheritance",
  );
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "UPDATE acl SET level=0 WHERE tenant_id=$1" +
        " AND resource_id=$2 AND principal_id=$3",
      [owner.tenant, dataset.id, peerId],
    );
    await q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,'*',4)",
      [owner.tenant, dataset.id],
    );
  });
  assert.equal(
    (await check(peerId, "member", resourceIds[3])).rows[0].allowed,
    false,
    "explicit user-level denial overrides wildcard grant",
  );
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE resources SET deleted_at=now() WHERE id=$1", [dataset.id]),
  );
  assert.equal(
    (await check(owner.id, "owner", resourceIds[3])).rows[0].allowed,
    false,
    "even owner read must exclude deleted ancestors",
  );
});

test("W08 indexed direct-child ACL agrees with full evaluator and picker", async () => {
  const parent = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08 ACL fast-path parity",
  });
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const item = await ok("POST", "/databases/" + parent.id + "/records", {
      values: { name: "ACL fast " + String(i).padStart(2, "0") },
    });
    ids.push(item.id);
  }
  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name) VALUES($1,$2,'Fast path peer')",
      [peerId, peerId + "@example.test"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role)" +
        " VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
    await q.query(
      "UPDATE resources SET inherit_permissions=false" +
        " WHERE id=ANY($1::uuid[])",
      [[ids[3], ids[4], ids[5]]],
    );
    // 1: wildcard deny; 2: personal grant wins wildcard deny;
    // 4: reset+personal grant; 5: reset+wildcard grant;
    // 6: personal deny wins wildcard grant.
    const grants: Array<[string, string, number]> = [
      [ids[1], "*", 0],
      [ids[2], "*", 0],
      [ids[2], peerId, 3],
      [ids[4], peerId, 2],
      [ids[5], "*", 3],
      [ids[6], "*", 4],
      [ids[6], peerId, 0],
    ];
    for (const [resource, principal, level] of grants)
      await q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " VALUES($1,$2,$3,$4)",
        [owner.tenant, resource, principal, level],
      );
  });
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const actor = { cookie: "workspace_session=" + token, csrf: csrf(token) };
  const expected = [ids[0], ids[2], ids[4], ids[5]];
  const base = "/databases/" + parent.id + "/records?limit=2&offset=";
  assert.deepEqual(
    (await ok("GET", base + "0", undefined, actor)).map((r: any) => r.id),
    expected.slice(0, 2),
  );
  assert.deepEqual(
    (await ok("GET", base + "2", undefined, actor)).map((r: any) => r.id),
    expected.slice(2),
  );
  assert.deepEqual(await ok("GET", base + "4", undefined, actor), []);
  const checked = await db.tenant(owner.tenant, (q) =>
    q.query(
      "SELECT id,workspace_can_read_resource(id,$2::uuid,'member') visible" +
        " FROM resources WHERE id=ANY($1::uuid[]) ORDER BY position,id",
      [ids, peerId],
    ),
  );
  assert.deepEqual(
    checked.rows.filter((r: any) => r.visible).map((r: any) => r.id),
    expected,
    "direct-child filter must be semantically equal to full SQL ancestry",
  );

  const source = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08 linked fast picker",
  });
  await ok("PATCH", "/databases/" + source.id, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      {
        id: "linked",
        name: "Linked",
        type: "relation",
        target_database_id: parent.id,
      },
    ],
  });
  const url =
    "/databases/" +
    source.id +
    "/relation-candidates?property=linked&limit=2&offset=";
  const choices0 = await ok("GET", url + "0", undefined, actor);
  const choices2 = await ok("GET", url + "2", undefined, actor);
  assert.deepEqual(
    choices0.items.map((r: any) => r.id),
    expected.slice(0, 2),
  );
  assert.deepEqual(
    choices2.items.map((r: any) => r.id),
    expected.slice(2),
  );
  assert.equal(choices0.has_more, true);
  assert.equal(choices2.has_more, false);
  assert.ok(!JSON.stringify([choices0, choices2]).includes(ids[1]));
  assert.ok(!JSON.stringify([choices0, choices2]).includes(ids[6]));
});

test("W08 mixed-ACL scale: 1k and 10k visible-only database pages", async () => {
  const peerId = randomUUID();
  await db.tenant(owner.tenant, (q) =>
    q.query("INSERT INTO users(id,email,name) VALUES($1,$2,'W08 Scale Peer')", [
      peerId,
      peerId + "@example.test",
    ]),
  );
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "INSERT INTO memberships(tenant_id,user_id,role)" +
        " VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    ),
  );
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = { cookie: "workspace_session=" + token, csrf: csrf(token) };

  for (const size of [1000, 10000]) {
    const dataset = await ok("POST", "/resources", {
      kind: "database",
      parent_id: space.id,
      title: "W08 scale " + size,
    });
    const ids = Array.from({ length: size }, () => randomUUID());
    const tenant = owner.tenant;
    await db.tenant(tenant, async (q) => {
      // A transactionally inserted deterministic fixture makes the 10k
      // qualification practical under restricted PostgreSQL/RLS.
      await q.query(
        "INSERT INTO resources(id,tenant_id,parent_id,kind,title,position)" +
          " SELECT x.id,$2::uuid,$3::uuid,'record'," +
          " 'W08 Scale item ' || x.n::text,x.n::float8" +
          " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)",
        [ids, tenant, dataset.id],
      );
      await q.query(
        "INSERT INTO database_records(tenant_id,resource_id,database_id,values)" +
          " SELECT $2::uuid,r.id,$3::uuid,jsonb_build_object('name',r.title)" +
          " FROM resources r WHERE r.id=ANY($1::uuid[])",
        [ids, tenant, dataset.id],
      );
      await q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " SELECT $2::uuid,x.id,$3::text,0" +
          " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)" +
          " WHERE x.n <= $4::int",
        [ids, tenant, peerId, size / 2],
      );
    });
    const offset = size / 2 - 100;
    const started = Date.now();
    const page = await ok(
      "GET",
      "/databases/" + dataset.id + "/records?limit=100&offset=" + offset,
      undefined,
      peer,
    );
    const ms = Date.now() - started;
    assert.deepEqual(
      page.map((row: any) => row.id),
      ids.slice(size - 100),
      "deep offsets must count 100 accessible rows after hidden half",
    );
    console.info(
      "W08_ACL_BENCH " +
        JSON.stringify({
          size,
          hidden: size / 2,
          visible: size / 2,
          offset,
          page_size: page.length,
          elapsed_ms: ms,
        }),
    );
    const budgetMs = size === 1000 ? 15000 : 60000;
    assert.ok(
      ms < budgetMs,
      "W08 " +
        size +
        "row permission-aware page exceeded " +
        budgetMs +
        "ms provisional CI budget: " +
        ms +
        "ms",
    );

    // Export scales over the same caller-specific visible set. A hidden
    // row must never be leaked even when thousands of rows are returned.
    const exportStarted = Date.now();
    const output = await ok(
      "GET",
      "/resources/" + dataset.id + "/export?format=json",
      undefined,
      peer,
    );
    const exportElapsed = Date.now() - exportStarted;
    const hidden = new Set(ids.slice(0, size / 2));
    assert.equal(output.records.length, size / 2);
    assert.ok(
      output.records.every((row: any) => !hidden.has(row.id)),
      "Export cannot include hidden source records or their metadata",
    );
    console.info(
      "W08_ACL_EXPORT_BENCH " +
        JSON.stringify({
          size,
          visible: output.records.length,
          elapsed_ms: exportElapsed,
        }),
    );
    assert.ok(
      exportElapsed < 30000,
      "W08 large visible-only export exceeded provisional 30s budget",
    );

    const cursorStarted = Date.now();
    const gathered: string[] = [];
    let continuation: string | null = null;
    const cursorPath = "/databases/" + dataset.id + "/records/page?limit=100";
    for (let segment = 0; segment < size / 200; segment++) {
      const response = await ok(
        "GET",
        cursorPath +
          (continuation ? "&cursor=" + encodeURIComponent(continuation) : ""),
        undefined,
        peer,
      );
      assert.equal(response.items.length, 100);
      gathered.push(...response.items.map((item: any) => item.id));
      continuation = response.next_cursor;
      assert.equal(response.has_more, segment < size / 200 - 1);
      if (response.has_more) assert.ok(continuation);
      else assert.equal(continuation, null);
    }
    assert.deepEqual(
      gathered,
      ids.slice(size / 2),
      "keyset traversal includes every readable record exactly once",
    );
    const cursorMs = Date.now() - cursorStarted;
    console.info(
      "W08_KEYSET_BENCH " +
        JSON.stringify({
          size,
          hidden: size / 2,
          visible: gathered.length,
          pages: size / 200,
          elapsed_ms: cursorMs,
        }),
    );
    assert.ok(
      cursorMs < 30000,
      "W08 " + size + "row keyset traversal exceeded provisional CI budget",
    );
  }
});

test("W08b native: encrypted keyset skips hidden records, scopes actor and invalidates changed views", async () => {
  const dataset = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08b encrypted pages",
  });
  for (let i = 0; i < 8; i++)
    await ok("POST", "/databases/" + dataset.id + "/records", {
      values: { name: "W08b Row " + i },
    });
  const base = "/databases/" + dataset.id + "/records";
  const all = await ok("GET", base + "?limit=30");
  assert.equal(all.length, 8);
  const hiddenIds = [all[0].id, all[3].id];
  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name) VALUES($1,$2,'W08b peer')",
      [peerId, peerId + "@example.test"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role)" +
        " VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
    for (const hidden of hiddenIds)
      await q.query(
        "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
          " VALUES($1,$2,$3,0)",
        [owner.tenant, hidden, peerId],
      );
  });
  const peerToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = {
    cookie: "workspace_session=" + peerToken,
    csrf: csrf(peerToken),
  };
  const readable = all
    .map((x: any) => x.id)
    .filter((x: string) => !hiddenIds.includes(x));
  const url = base + "/page?limit=2";
  const returned: string[] = [];
  let cursor: string | null = null;
  let firstCursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const response = await ok(
      "GET",
      url + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      undefined,
      peer,
    );
    returned.push(...response.items.map((x: any) => x.id));
    if (page === 0) {
      firstCursor = response.next_cursor;
      assert.equal(response.has_more, true);
      assert.ok(firstCursor?.startsWith("db-page-v1."));
      for (const hidden of hiddenIds) assert.ok(!firstCursor!.includes(hidden));
    }
    if (!response.has_more) {
      assert.equal(response.next_cursor, null);
      break;
    }
    cursor = response.next_cursor;
  }
  assert.deepEqual(
    returned,
    readable,
    "cursor continues over readable order without duplicates or hidden slots",
  );
  assert.equal(new Set(returned).size, readable.length);

  // Cursor does not authorize reading in another user or tenant.
  assert.equal(
    (await req("GET", url + "&cursor=" + encodeURIComponent(firstCursor!)))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        url + "&cursor=" + encodeURIComponent(firstCursor!),
        undefined,
        other,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        url + "&limit=3&cursor=" + encodeURIComponent(firstCursor!),
        undefined,
        peer,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await req("GET", url + "&offset=1", undefined, peer)).statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "GET",
        url + "&cursor=" + encodeURIComponent(firstCursor!.slice(0, -1) + "!"),
        undefined,
        peer,
      )
    ).statusCode,
    400,
  );

  // An issued cursor is bound to the verified membership role; switching
  // member→guest→member must invalidate the token for the changed role,
  // while the SQL ACL gate separately enforces current permissions.
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE memberships SET role='guest' WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, peerId],
    ),
  );
  const staleRole = await req(
    "GET",
    url + "&cursor=" + encodeURIComponent(firstCursor!),
    undefined,
    peer,
  );
  assert.equal(staleRole.statusCode, 400);
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, peerId],
    ),
  );

  const saved = await ok("POST", "/databases/" + dataset.id + "/views", {
    name: "Cursor filter",
    config: {
      type: "table",
      filters: [
        {
          property: "name",
          op: "contains",
          value: "W08b Row",
        },
      ],
      sort: [],
    },
  });
  const filteredUrl = url + "&view=" + saved.id;
  const filteredFirst = await ok("GET", filteredUrl, undefined, peer);
  assert.ok(filteredFirst.next_cursor);
  assert.equal(
    (
      await req(
        "GET",
        filteredUrl + "&cursor=" + encodeURIComponent(firstCursor!),
        undefined,
        peer,
      )
    ).statusCode,
    400,
  );
  await ok("PATCH", "/databases/" + dataset.id + "/views/" + saved.id, {
    name: "Modified cursor filter",
    config: {
      type: "table",
      filters: [
        {
          property: "name",
          op: "eq",
          value: "W08b Row 999",
        },
      ],
      sort: [],
    },
  });
  assert.equal(
    (
      await req(
        "GET",
        filteredUrl +
          "&cursor=" +
          encodeURIComponent(filteredFirst.next_cursor),
        undefined,
        peer,
      )
    ).statusCode,
    400,
    "changed view invalidates encrypted cursor digest",
  );

  // A fresh ACL change is honored on the next cursor read.
  const firstOwnerPage = await ok("GET", url);
  const expectedNext = (
    await ok(
      "GET",
      url + "&cursor=" + encodeURIComponent(firstOwnerPage.next_cursor),
    )
  ).items;
  await db.tenant(owner.tenant, (q) =>
    q.query("UPDATE resources SET deleted_at=now() WHERE id=$1", [
      expectedNext[0].id,
    ]),
  );
  const afterDelete = await ok(
    "GET",
    url + "&cursor=" + encodeURIComponent(firstOwnerPage.next_cursor),
  );
  assert.ok(
    afterDelete.items.every((x: any) => x.id !== expectedNext[0].id),
    "cursor must never bypass deletion or ACL updates",
  );
});

test("W08b calendar cursor: month binding, date filtering and custom-sort refusal", async () => {
  const dataset = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08b calendar",
  });
  const dbPath = "/databases/" + dataset.id;
  await ok("PATCH", dbPath, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "due", name: "Due", type: "date" },
    ],
  });
  for (const [name, due] of [
    ["March one", "2026-03-01"],
    ["March two", "2026-03-31"],
    ["April one", "2026-04-01"],
  ])
    await ok("POST", dbPath + "/records", { values: { name, due } });
  const saved = await ok("POST", dbPath + "/views", {
    name: "Calendar",
    config: {
      type: "calendar",
      dateBy: "due",
      filters: [],
      sort: [],
    },
  });
  const base = dbPath + "/records/page?view=" + saved.id + "&limit=1";
  const march = base + "&month=2026-03";
  const first = await ok("GET", march);
  assert.equal(first.items.length, 1);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  const second = await ok(
    "GET",
    march + "&cursor=" + encodeURIComponent(first.next_cursor),
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  assert.deepEqual([first.items[0].title, second.items[0].title].sort(), [
    "March one",
    "March two",
  ]);
  const badMonth = await req(
    "GET",
    base + "&month=2026-04&cursor=" + encodeURIComponent(first.next_cursor),
  );
  assert.equal(badMonth.statusCode, 400);
  const april = await ok("GET", base + "&month=2026-04");
  assert.deepEqual(
    april.items.map((x: any) => x.title),
    ["April one"],
  );
  assert.equal(april.has_more, false);
  assert.equal(
    (await req("GET", dbPath + "/records/page?view=" + saved.id)).statusCode,
    400,
    "calendar requires explicit month",
  );

  const sorted = await ok("POST", dbPath + "/views", {
    name: "Custom sort",
    config: {
      type: "table",
      filters: [],
      sort: [{ property: "name", direction: "asc" }],
    },
  });
  const sortedPage = await ok(
    "GET",
    dbPath + "/records/page?view=" + sorted.id,
  );
  assert.deepEqual(
    sortedPage.items.map((row: any) => row.title),
    ["April one", "March one", "March two"],
    "W08c scalar Title sorting is now supported by the encrypted cursor",
  );
  assert.equal(sortedPage.has_more, false);
  const legacy = await ok("GET", dbPath + "/records?view=" + sorted.id);
  assert.deepEqual(
    legacy.map((row: any) => row.id),
    sortedPage.items.map((row: any) => row.id),
    "bounded legacy offset and typed cursor sorting must agree",
  );
});

test("W08c mixed ASC/DESC numeric and text keysets preserve null-last and actor ACL", async () => {
  const database = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08c typed sort",
  });
  const path = "/databases/" + database.id;
  await ok("PATCH", path, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "score", name: "Score", type: "number" },
      { id: "label", name: "Label", type: "text" },
      { id: "category", name: "Category", type: "select", options: ["Group"] },
    ],
  });
  const fixtures: Array<{ name: string; score?: number; label?: string }> = [
    { name: "A", score: 2, label: "B" },
    { name: "B", score: 1, label: "A" },
    { name: "C", score: 2, label: "A" },
    { name: "D", label: "B" },
    { name: "E", score: 1, label: "B" },
    { name: "F", score: 2 },
    { name: "G", score: 1, label: "B" },
    { name: "H" },
    { name: "I", score: 3, label: "A" },
  ];
  const rowIds = new Map<string, string>();
  for (const row of fixtures) {
    const created = await ok("POST", path + "/records", { values: row });
    rowIds.set(row.name, created.id);
  }
  const asc = await ok("POST", path + "/views", {
    name: "Ascending score, descending label",
    config: {
      type: "table",
      filters: [],
      sort: [
        { property: "score", direction: "asc" },
        { property: "label", direction: "desc" },
      ],
    },
  });
  const desc = await ok("POST", path + "/views", {
    name: "Descending score, ascending label",
    config: {
      type: "board",
      groupBy: "category",
      filters: [],
      sort: [
        { property: "score", direction: "desc" },
        { property: "label", direction: "asc" },
      ],
    },
  });
  async function iterate(viewId: string, actor = owner) {
    const url = path + "/records/page?limit=2&view=" + viewId;
    const rows: any[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 7; index++) {
      const result = await ok(
        "GET",
        url + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        undefined,
        actor,
      );
      assert.ok(result.items.length <= 2);
      rows.push(...result.items);
      if (!result.has_more) {
        assert.equal(result.next_cursor, null);
        return rows;
      }
      assert.ok(result.next_cursor?.startsWith("db-page-v1."));
      cursor = result.next_cursor;
    }
    assert.fail("Did not terminate bounded sorted keyset traversal");
  }
  const ascending = await iterate(asc.id);
  assert.deepEqual(
    ascending.map((r) => r.values.name),
    ["E", "G", "B", "A", "C", "F", "I", "D", "H"],
  );
  const descending = await iterate(desc.id);
  assert.deepEqual(
    descending.map((r) => r.values.name),
    ["I", "C", "A", "F", "B", "E", "G", "D", "H"],
  );
  assert.equal(new Set(ascending.map((r) => r.id)).size, 9);

  const peerId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name) VALUES($1,$2,'Sort peer')",
      [peerId, peerId + "@example.test"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role)" +
        " VALUES($1,$2,'member')",
      [owner.tenant, peerId],
    );
    await q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,0)",
      [owner.tenant, rowIds.get("A"), peerId],
    );
  });
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, peerId),
  );
  const peer = { cookie: "workspace_session=" + token, csrf: csrf(token) };
  const visibleSorted = await iterate(asc.id, peer);
  assert.deepEqual(
    visibleSorted.map((r) => r.values.name),
    ["E", "G", "B", "C", "F", "I", "D", "H"],
  );
  assert.ok(!JSON.stringify(visibleSorted).includes(rowIds.get("A")!));

  const first = await ok(
    "GET",
    path + "/records/page?limit=2&view=" + asc.id,
    undefined,
    peer,
  );
  assert.equal(
    (
      await req(
        "GET",
        path +
          "/records/page?limit=2&view=" +
          desc.id +
          "&cursor=" +
          encodeURIComponent(first.next_cursor),
        undefined,
        peer,
      )
    ).statusCode,
    400,
    "Cursor must reject changes to saved view sort order",
  );
  await ok("PATCH", path + "/views/" + asc.id, {
    name: "Modified sort direction",
    config: {
      type: "table",
      filters: [],
      sort: [{ property: "score", direction: "desc" }],
    },
  });
  assert.equal(
    (
      await req(
        "GET",
        path +
          "/records/page?limit=2&view=" +
          asc.id +
          "&cursor=" +
          encodeURIComponent(first.next_cursor),
        undefined,
        peer,
      )
    ).statusCode,
    400,
    "Editing sort specification must invalidate previously issued cursor",
  );
});

test("W08d: 25 concurrent principals remain tenant/ACL isolated across cursor pages and edits", async () => {
  const dataset = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08d multiuser cursor capacity",
  });
  const size = 200,
    denied = 100;
  const ids = Array.from({ length: size }, () => randomUUID());
  const userIds = Array.from({ length: 25 }, () => randomUUID());
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO resources(id,tenant_id,parent_id,kind,title,position)" +
        " SELECT x.id,$2::uuid,$3::uuid,'record'," +
        " 'W08d item '||x.n::text,x.n::float8" +
        " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)",
      [ids, owner.tenant, dataset.id],
    );
    await q.query(
      "INSERT INTO database_records(tenant_id,resource_id,database_id,values)" +
        " SELECT $2::uuid,r.id,$3::uuid,jsonb_build_object('name',r.title)" +
        " FROM resources r WHERE r.id=ANY($1::uuid[])",
      [ids, owner.tenant, dataset.id],
    );
    await q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " SELECT $2::uuid,x.id,'*',0" +
        " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)" +
        " WHERE x.n<=$3",
      [ids, owner.tenant, denied],
    );
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      await q.query("INSERT INTO users(id,email,name)" + " VALUES($1,$2,$3)", [
        uid,
        uid + "@w08d.example.test",
        "Concurrent actor " + i,
      ]);
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role)" +
          " VALUES($1,$2,'member')",
        [owner.tenant, uid],
      );
      // Half the members additionally cannot read the first visible row.
      if (i % 2)
        await q.query(
          "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
            " VALUES($1,$2,$3,0)",
          [owner.tenant, ids[100], uid],
        );
    }
  });
  const actors = await Promise.all(
    userIds.map(async (uid) => {
      const token = await db.tenant(owner.tenant, (q) =>
        createSession(q, owner.tenant, uid),
      );
      return { cookie: "workspace_session=" + token, csrf: csrf(token) };
    }),
  );
  const url = "/databases/" + dataset.id + "/records/page?limit=20";
  const started = Date.now();
  const timings: number[] = [];
  async function pageFor(actor: any, cursor: string | null) {
    const begin = Date.now();
    const result = await ok(
      "GET",
      url + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      undefined,
      actor,
    );
    timings.push(Date.now() - begin);
    return result;
  }
  const firstPages = await Promise.all(
    actors.map((actor) => pageFor(actor, null)),
  );
  const secondPages = await Promise.all(
    actors.map((actor, i) => pageFor(actor, firstPages[i].next_cursor)),
  );
  const hidden = new Set<string>(ids.slice(0, denied));
  for (let i = 0; i < actors.length; i++) {
    const first = firstPages[i],
      second = secondPages[i];
    assert.equal(first.items.length, 20);
    assert.equal(second.items.length, 20);
    assert.equal(first.has_more, true);
    const list = [...first.items, ...second.items].map((x: any) => x.id);
    assert.equal(
      list.length,
      new Set(list).size,
      "stable pages must not duplicate records",
    );
    assert.ok(
      list.every((id: string) => !hidden.has(id)),
      "no globally denied record may leak in any concurrent session",
    );
    if (i % 2)
      assert.ok(
        !list.includes(ids[100]),
        "personal ACL denies must override inherited/wildcard access",
      );
    else
      assert.ok(
        list.includes(ids[100]),
        "other principals retain the differently permitted record",
      );
  }
  const elapsed = Date.now() - started;
  timings.sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    timings[
      Math.min(timings.length - 1, Math.ceil(fraction * timings.length) - 1)
    ];
  console.info(
    "W08_MULTIUSER_BENCH " +
      JSON.stringify({
        database_rows: size,
        globally_hidden: denied,
        principals: actors.length,
        parallel_page_requests: 25,
        completed_page_requests: timings.length,
        p50_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        p99_ms: percentile(0.99),
        elapsed_ms: elapsed,
      }),
  );
  assert.ok(
    elapsed < 30000,
    "W08d provisional 25-session native throughput gate exceeded 30s",
  );

  // Foreign tenant principal cannot enumerate database records.
  const foreign = await req("GET", url, undefined, other);
  assert.notEqual(
    foreign.statusCode,
    200,
    "tenant boundary cannot be bypassed by cursor API",
  );

  // Read-committed live semantics: a moved item may cross a cursor; a
  // fresh query restarts at the new current order. A revoked item must
  // disappear on every continuation regardless of cursor issuance time.
  await db.tenant(owner.tenant, async (q) => {
    await q.query("UPDATE resources SET position=0 WHERE id=$1", [ids[159]]);
    await q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " VALUES($1,$2,$3,0)",
      [owner.tenant, ids[129], userIds[0]],
    );
  });
  const continued = await pageFor(actors[0], firstPages[0].next_cursor);
  assert.ok(
    !continued.items.some((row: any) => row.id === ids[129]),
    "current ACL revocation must take effect after a cursor was issued",
  );
  assert.ok(
    !continued.items.some((row: any) => row.id === ids[159]),
    "a moved-before-cursor record is not snapshot pinned",
  );
  const restarted = await pageFor(actors[0], null);
  assert.equal(
    restarted.items[0].id,
    ids[159],
    "restart from first page must see the latest ordering",
  );
  assert.ok(
    !restarted.items.some((row: any) => row.id === ids[129]),
    "new pagination never bypasses a revoked row",
  );
});

test("W08e: 10k mixed-ACL records under 25 sessions, sorted pages, search, export and edits", async () => {
  const size = 10000,
    hiddenCount = 5000;
  const dataset = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08e concurrent large table",
  });
  await ok("PATCH", "/databases/" + dataset.id, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "score", name: "Score", type: "number" },
    ],
  });
  const ids: string[] = Array.from({ length: size }, () => randomUUID());
  const userIds: string[] = Array.from({ length: 25 }, () => randomUUID());
  const insertionStarted = Date.now();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO resources(id,tenant_id,parent_id,kind,title,position)" +
        " SELECT x.id,$2::uuid,$3::uuid,'record'," +
        " 'W08e item '||x.n::text,x.n::float8" +
        " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)",
      [ids, owner.tenant, dataset.id],
    );
    await q.query(
      "INSERT INTO database_records(tenant_id,resource_id,database_id,values)" +
        " SELECT $2::uuid,r.id,$3::uuid," +
        " jsonb_build_object('name',r.title,'score'," +
        " CASE WHEN r.position::int%7=0 THEN NULL" +
        " ELSE r.position::int%101 END)" +
        " FROM resources r WHERE r.id=ANY($1::uuid[])",
      [ids, owner.tenant, dataset.id],
    );
    await q.query(
      "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
        " SELECT $2::uuid,x.id,'*',0" +
        " FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id,n)" +
        " WHERE x.n<=$3",
      [ids, owner.tenant, hiddenCount],
    );
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
        uid,
        uid + "@w08e.example.test",
        "W08e member " + i,
      ]);
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role)" +
          " VALUES($1,$2,'member')",
        [owner.tenant, uid],
      );
      if (i % 2)
        await q.query(
          "INSERT INTO acl(tenant_id,resource_id,principal_id,level)" +
            " VALUES($1,$2,$3,0)",
          [owner.tenant, ids[hiddenCount], uid],
        );
    }
  });
  const actors = await Promise.all(
    userIds.map(async (uid) => {
      const token = await db.tenant(owner.tenant, (q) =>
        createSession(q, owner.tenant, uid),
      );
      return { cookie: "workspace_session=" + token, csrf: csrf(token) };
    }),
  );
  const view = await ok("POST", "/databases/" + dataset.id + "/views", {
    name: "Numeric score descending",
    config: {
      type: "table",
      filters: [],
      sort: [
        { property: "score", direction: "desc" },
        { property: "name", direction: "asc" },
      ],
    },
  });
  const source = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W08e relation candidate workload",
  });
  await ok("PATCH", "/databases/" + source.id, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      {
        id: "linked",
        name: "Linked",
        type: "relation",
        target_database_id: dataset.id,
      },
    ],
  });
  const sortedUrl =
    "/databases/" + dataset.id + "/records/page?view=" + view.id + "&limit=50";
  const fixtureMs = Date.now() - insertionStarted;
  const wallStart = Date.now(),
    cpuStart = process.cpuUsage(),
    rssBefore = process.memoryUsage().rss;
  const latencies: number[] = [];
  const getPage = async (actor: any, cursor?: string) => {
    const t = Date.now();
    const response = await ok(
      "GET",
      sortedUrl + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      undefined,
      actor,
    );
    latencies.push(Date.now() - t);
    return response;
  };
  const firstRequests = actors.map((actor) => getPage(actor));
  const waitingObserved = db.pool.waitingCount;
  const first = await Promise.all(firstRequests);
  const second = await Promise.all(
    actors.map((actor, i) => getPage(actor, first[i].next_cursor)),
  );
  const globallyHidden = new Set<string>(ids.slice(0, hiddenCount));
  for (let i = 0; i < actors.length; i++) {
    const rows = [...first[i].items, ...second[i].items];
    assert.equal(rows.length, 100);
    assert.equal(
      new Set(rows.map((r: any) => r.id)).size,
      100,
      "stable multikey cursor should not duplicate unchanged records",
    );
    assert.ok(
      rows.every((r: any) => !globallyHidden.has(r.id)),
      "no hidden record may leak under 25-session concurrent access",
    );
    if (i % 2)
      assert.ok(
        !rows.some((r: any) => r.id === ids[hiddenCount]),
        "personal deny wins per actor",
      );
    assert.equal(first[i].has_more, true);
    assert.equal(second[i].has_more, true);
  }
  const pickerUrl =
    "/databases/" +
    source.id +
    "/relation-candidates?property=linked&search=" +
    encodeURIComponent("W08e item 9999") +
    "&limit=10";
  const candidates = await Promise.all(
    actors.slice(0, 10).map((actor) => ok("GET", pickerUrl, undefined, actor)),
  );
  for (const candidatesForActor of candidates)
    assert.deepEqual(
      candidatesForActor.items.map((r: any) => r.id),
      [ids[9998]],
      "relation picker must stay RLS/ACL filtered at 10k",
    );

  const exported = await Promise.all(
    actors
      .slice(0, 2)
      .map((actor) =>
        ok(
          "GET",
          "/resources/" + dataset.id + "/export?format=json",
          undefined,
          actor,
        ),
      ),
  );
  assert.equal(exported[0].records.length, 5000);
  assert.equal(exported[1].records.length, 4999);
  for (const result of exported)
    assert.ok(
      result.records.every((r: any) => !globallyHidden.has(r.id)),
      "large concurrent exports cannot reveal globally hidden record IDs",
    );

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      ok("PATCH", "/records/" + ids[7000 + i], {
        values: { name: "W08e updated " + i },
        expected_revision: 1,
      }),
    ),
  );
  assert.notEqual(
    (await req("GET", sortedUrl, undefined, other)).statusCode,
    200,
    "second tenant must never see first tenant results",
  );

  const cpu = process.cpuUsage(cpuStart),
    rssAfter = process.memoryUsage().rss;
  const totalMs = Date.now() - wallStart;
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies[
      Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)
    ];
  console.info(
    "W08_10K_CONCURRENT_BENCH " +
      JSON.stringify({
        rows: size,
        hidden_rows: hiddenCount,
        sessions: actors.length,
        concurrent_first_page_requests: 25,
        total_page_requests: latencies.length,
        relation_picker_requests: candidates.length,
        exports: exported.length,
        edits: 5,
        fixture_ms: fixtureMs,
        workload_ms: totalMs,
        page_p50_ms: percentile(0.5),
        page_p95_ms: percentile(0.95),
        page_p99_ms: percentile(0.99),
        node_cpu_user_ms: Math.round(cpu.user / 1000),
        node_cpu_system_ms: Math.round(cpu.system / 1000),
        node_rss_before_mib: Math.round(rssBefore / 1048576),
        node_rss_after_mib: Math.round(rssAfter / 1048576),
        pg_pool_max: 12,
        pg_pool_total: db.pool.totalCount,
        pg_pool_idle: db.pool.idleCount,
        pg_waiting_after_start: waitingObserved,
      }),
  );
  assert.ok(
    totalMs < 60000,
    "10k/25-session provisional native CI qualification exceeded 60s",
  );
});

test("W09a permissioned CSV preview and atomically mapped worker import", async () => {
  const original =
    "Name,Quantity,Due,Checked,Extra\n" +
    "First,20,2026-10-01,true,retained\n" +
    "Second,0,2026-10-02,false,unused";
  const route = "/imports/preview";
  const preview = await ok("POST", route, {
    parent_id: space.id,
    content: original,
  });
  assert.equal(preview.row_count, 2);
  assert.deepEqual(
    preview.mapping.map((v: any) => v.type),
    ["title", "number", "date", "checkbox", "text"],
  );
  assert.equal(preview.sample.length, 2);
  assert.equal(
    (
      await req("POST", route, {
        parent_id: randomUUID(),
        content: original,
      })
    ).statusCode,
    404,
    "unknown parent cannot be previewed",
  );
  assert.notEqual(
    (
      await req(
        "POST",
        route,
        {
          parent_id: space.id,
          content: original,
        },
        other,
      )
    ).statusCode,
    200,
    "foreign tenant cannot inspect parent",
  );
  assert.equal(
    (
      await req("POST", route, {
        parent_id: space.id,
        content: "Name,Name\nA,B",
      })
    ).statusCode,
    400,
    "duplicate heading fails before queue",
  );
  const mapping = preview.mapping.map((m: any, i: number) => ({
    ...m,
    id: "mapped" + i,
    skip: i === 4,
  }));
  const queued = await ok("POST", "/imports", {
    parent_id: space.id,
    name: "W09 typed CSV",
    format: "csv",
    content: original,
    mapping,
  });
  assert.equal(queued.status, "pending");
  await tick(db);
  const job = await ok("GET", "/jobs/" + queued.id);
  assert.equal(job.status, "completed", JSON.stringify(job.result));
  const persistedPayload = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT payload FROM jobs WHERE id=$1", [queued.id]),
  );
  assert.deepEqual(
    persistedPayload.payload.mapping,
    mapping,
    "queued mapping must be stored exactly, not silently dropped. Payload keys: " +
      JSON.stringify(Object.keys(persistedPayload.payload || {})) +
      " Payload value type: " +
      typeof persistedPayload.payload,
  );
  const schemaRow = await db.tenant(owner.tenant, (q) =>
    one(q, "SELECT properties FROM databases WHERE resource_id=$1", [
      job.result.resource_id,
    ]),
  );
  assert.deepEqual(
    schemaRow.properties.map((p: any) => p.id),
    ["mapped0", "mapped1", "mapped2", "mapped3"],
    "worker must create the requested mapped schema",
  );
  const recordUrl = "/databases/" + job.result.resource_id + "/records";
  const created = await ok("GET", recordUrl);
  assert.equal(created.length, 2);
  assert.deepEqual(
    created.map((r: any) => ({
      name: r.values.mapped0,
      quantity: r.values.mapped1,
      due: r.values.mapped2,
      checked: r.values.mapped3,
    })),
    [
      { name: "First", quantity: 20, due: "2026-10-01", checked: true },
      { name: "Second", quantity: 0, due: "2026-10-02", checked: false },
    ],
    "Mapped returned rows: " + JSON.stringify(created.slice(0, 2)),
  );
  assert.ok(
    created.every((r: any) => r.values.mapped4 === undefined),
    "skipped columns never enter database storage",
  );
  const copied = await ok("GET", "/databases/" + job.result.resource_id);
  assert.deepEqual(
    copied.properties.map((p: any) => p.type),
    ["title", "number", "date", "checkbox"],
  );
  assert.equal(
    (await req("GET", "/jobs/" + queued.id, undefined, other)).statusCode,
    404,
    "import job remains caller-owned",
  );

  const before = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT count(*)::int n FROM resources WHERE parent_id=$1", [
      space.id,
    ]),
  );
  const bad = await ok("POST", "/imports", {
    parent_id: space.id,
    name: "W09 invalid CSV",
    format: "csv",
    content: original.replace("2026-10-02", "2026-02-30"),
    mapping,
  });
  await tick(db);
  const failed = await ok("GET", "/jobs/" + bad.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.result.error, /row 2/);
  const after = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT count(*)::int n FROM resources WHERE parent_id=$1", [
      space.id,
    ]),
  );
  assert.equal(
    Number(before.rows[0].n),
    Number(after.rows[0].n),
    "invalid late-row value never creates a partially imported resource",
  );

  const invalidMarkdownMap = await req("POST", "/imports", {
    parent_id: space.id,
    name: "No mapping on MD",
    format: "markdown",
    content: "# Heading",
    mapping,
  });
  assert.equal(invalidMarkdownMap.statusCode, 400);
});

test("W09b existing-database CSV append checks schema, ACL and atomicity", async () => {
  const target = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W09b target",
  });
  const path = "/databases/" + target.id;
  await ok("PATCH", path, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "quantity", name: "Quantity", type: "number" },
      { id: "due", name: "Due", type: "date" },
      { id: "done", name: "Done", type: "checkbox" },
    ],
  });
  await ok("POST", path + "/records", {
    values: { name: "Original", quantity: 99 },
  });
  const content =
    "Name,Quantity,Due,Done\n" +
    "First,2,2026-10-01,true\n" +
    "Second,0,2026-10-02,false";
  const args = { parent_id: space.id, target_database_id: target.id, content };
  const preview = await ok("POST", "/imports/preview", args);
  assert.equal(preview.row_count, 2);
  assert.deepEqual(
    preview.mapping.map((m: any) => m.id),
    ["name", "quantity", "due", "done"],
  );
  assert.match(preview.target.schema_digest, /^[a-f0-9]{64}$/);
  assert.equal(preview.target.id, target.id);
  assert.equal(
    (
      await req("POST", "/imports/preview", {
        ...args,
        target_database_id: randomUUID(),
      })
    ).statusCode,
    404,
  );
  assert.notEqual(
    (await req("POST", "/imports/preview", args, other)).statusCode,
    200,
  );
  const payload = {
    ...args,
    name: "Explicit append",
    format: "csv",
    mapping: preview.mapping,
    expected_schema_digest: preview.target.schema_digest,
    existing_mode: "append",
  };
  assert.equal(
    (
      await req("POST", "/imports", {
        ...payload,
        existing_mode: undefined,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req("POST", "/imports", {
        ...payload,
        expected_schema_digest: "a".repeat(64),
      })
    ).statusCode,
    409,
  );
  const first = await ok("POST", "/imports", payload);
  await tick(db);
  const completed = await ok("GET", "/jobs/" + first.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.result));
  assert.equal(completed.result.resource_id, target.id);
  const records = await ok("GET", path + "/records");
  assert.equal(records.length, 3);
  const byName = new Map(records.map((r: any) => [r.values.name, r.values]));
  assert.equal((byName.get("Original") as any).quantity, 99);
  assert.deepEqual(
    ["First", "Second"].map((name) => {
      const v = byName.get(name) as any;
      return { name, quantity: v.quantity, due: v.due, done: v.done };
    }),
    [
      { name: "First", quantity: 2, due: "2026-10-01", done: true },
      { name: "Second", quantity: 0, due: "2026-10-02", done: false },
    ],
  );
  assert.equal(
    (await req("GET", "/jobs/" + first.id, undefined, other)).statusCode,
    404,
  );
  const invalid = await ok("POST", "/imports", {
    ...payload,
    content: content.replace("2026-10-02", "2026-02-30"),
  });
  await tick(db);
  const failed = await ok("GET", "/jobs/" + invalid.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.result.error, /row 2/);
  assert.equal(
    (await ok("GET", path + "/records")).length,
    3,
    "late invalid row must roll back all appended rows",
  );

  const changed = await ok("POST", "/imports", payload);
  await ok("PATCH", path, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "quantity", name: "Quantity", type: "number" },
      { id: "due", name: "Due", type: "date" },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "note", name: "Note", type: "text" },
    ],
  });
  await tick(db);
  const stale = await ok("GET", "/jobs/" + changed.id);
  assert.equal(stale.status, "failed");
  assert.match(stale.result.error, /schema changed/i);
  assert.equal(
    (await ok("GET", path + "/records")).length,
    3,
    "schema revision after queue must fail closed before appending",
  );

  // Execution-time authorization is separate from the enqueue decision.
  // Disabling membership after queue must prevent all appended rows.
  const refreshed = await ok("POST", "/imports/preview", args);
  const revoked = await ok("POST", "/imports", {
    ...payload,
    expected_schema_digest: refreshed.target.schema_digest,
  });
  await db.tenant(owner.tenant, (q) =>
    q.query(
      "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
      [owner.tenant, owner.id],
    ),
  );
  try {
    await tick(db);
  } finally {
    await db.tenant(owner.tenant, (q) =>
      q.query(
        "UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2",
        [owner.tenant, owner.id],
      ),
    );
  }
  const revokedJob = await ok("GET", "/jobs/" + revoked.id);
  assert.equal(revokedJob.status, "failed");
  assert.match(revokedJob.result.error, /membership revoked/i);
  assert.equal(
    (await ok("GET", path + "/records")).length,
    3,
    "revoked membership must not append any records",
  );
});

test("W09c CSV submission retries are principal-bound, atomic and schema-aware", async () => {
  const target = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W09c idempotency target",
  });
  const url = "/databases/" + target.id;
  const content = "Name\nCreated once\n";
  const preview = await ok("POST", "/imports/preview", {
    parent_id: space.id,
    target_database_id: target.id,
    content,
  });
  const key = randomUUID();
  const request = {
    parent_id: space.id,
    target_database_id: target.id,
    format: "csv",
    name: "Idempotent append",
    content,
    mapping: preview.mapping,
    expected_schema_digest: preview.target.schema_digest,
    existing_mode: "append",
    idempotency_key: key,
  };
  const [first, simultaneous] = await Promise.all([
    ok("POST", "/imports", request),
    ok("POST", "/imports", request),
  ]);
  assert.equal(
    first.id,
    simultaneous.id,
    "concurrent same-key requests enqueue one logical job",
  );
  assert.equal(first.status, "pending");
  const queued = await db.tenant(owner.tenant, (q) =>
    q.query(
      "SELECT id,request_digest,payload FROM jobs WHERE user_id=$1 AND idempotency_key=$2",
      [owner.id, key],
    ),
  );
  assert.equal(queued.rowCount, 1);
  assert.match(queued.rows[0].request_digest, /^[a-f0-9]{64}$/);
  assert.equal(
    queued.rows[0].payload.idempotency_key,
    undefined,
    "worker payload must not persist the client replay secret",
  );
  assert.equal(
    (
      await req("POST", "/imports", {
        ...request,
        content: "Name\nDifferent content\n",
      })
    ).statusCode,
    409,
    "same key cannot silently mean another request",
  );
  assert.equal(
    (
      await req("POST", "/imports", {
        ...request,
        idempotency_key: "bad",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await req("POST", "/imports", {
        parent_id: space.id,
        name: "Plain page",
        format: "markdown",
        content: "# Page",
        idempotency_key: randomUUID(),
      })
    ).statusCode,
    400,
    "idempotency key is currently CSV-only",
  );
  assert.notEqual(
    (await req("POST", "/imports", request, other)).statusCode,
    200,
    "foreign tenant must not resolve the first actor's key",
  );
  await tick(db);
  await tick(db);
  assert.equal(
    (await ok("GET", url + "/records")).length,
    1,
    "worker retry must not append already completed job",
  );
  const after = await ok("POST", "/imports", request);
  assert.equal(after.id, first.id);
  assert.equal(after.status, "completed");
  // A successful job can be retrieved by its key after a schema revision:
  // current write ACL still applies, but the original job is not requeued.
  await ok("PATCH", url, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "note", name: "Note", type: "text" },
    ],
  });
  const completedAgain = await ok("POST", "/imports", request);
  assert.equal(completedAgain.id, first.id);
  assert.equal(completedAgain.status, "completed");
  assert.equal(
    (
      await req("POST", "/imports", {
        ...request,
        idempotency_key: randomUUID(),
      })
    ).statusCode,
    409,
    "fresh jobs cannot use obsolete schema digest",
  );
  assert.equal((await ok("GET", url + "/records")).length, 1);
  // Failed original jobs are also stable: same-key retries return failure,
  // not a second append attempt, even when schema drift caused the failure.
  const refreshed = await ok("POST", "/imports/preview", {
    parent_id: space.id,
    target_database_id: target.id,
    content,
  });
  const failedRequest = {
    ...request,
    idempotency_key: randomUUID(),
    expected_schema_digest: refreshed.target.schema_digest,
  };
  const pending = await ok("POST", "/imports", failedRequest);
  await ok("PATCH", url, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "note", name: "Note", type: "text" },
      { id: "extra", name: "Extra", type: "text" },
    ],
  });
  await tick(db);
  const failed = await ok("GET", "/jobs/" + pending.id);
  assert.equal(failed.status, "failed");
  const failedReplay = await ok("POST", "/imports", failedRequest);
  assert.deepEqual(failedReplay, { id: pending.id, status: "failed" });
  await tick(db);
  assert.equal(
    (await ok("GET", url + "/records")).length,
    1,
    "failed stale-schema job and retry must never append rows",
  );
  // Previous callers that send no key retain legacy append-only semantics.
  const finalPreview = await ok("POST", "/imports/preview", {
    parent_id: space.id,
    target_database_id: target.id,
    content,
  });
  const legacy = await ok("POST", "/imports", {
    ...request,
    idempotency_key: undefined,
    expected_schema_digest: finalPreview.target.schema_digest,
  });
  assert.notEqual(legacy.id, first.id);
  await tick(db);
  assert.equal((await ok("GET", url + "/records")).length, 2);
});


test("W09d native keyed preview is exact, non-enumerating and tenant-safe", async () => {
  const importer = await freshMemberActor("W09d preview importer");
  const importSpace = await ok("POST", "/resources", {
    kind: "space",
    parent_id: root.id,
    title: "W09d preview " + randomUUID().slice(0, 8),
  });
  await permissionPatch(
    "/resources/" + importSpace.id + "/permissions",
    { inherit: false, grants: [{ principal_id: importer.id, level: 3 }] },
  );

  const target = await ok("POST", "/resources", {
    kind: "database",
    parent_id: importSpace.id,
    title: "W09d keyed target",
  });
  const url = "/databases/" + target.id;
  await ok("PATCH", url, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "code", name: "Code", type: "text" },
      { id: "amount", name: "Amount", type: "number" },
      { id: "due", name: "Due", type: "date" },
    ],
  });
  const visible = await ok("POST", url + "/records", {
    values: { name: "Visible", code: "AC-1", amount: 1, due: "2026-10-01" },
  });
  const hidden = await ok("POST", url + "/records", {
    values: { name: "Hidden", code: "HIDDEN", amount: 9, due: "2026-10-09" },
  });
  await permissionPatch(
    "/resources/" + hidden.id + "/permissions",
    { inherit: false, grants: [{ principal_id: importer.id, level: 0 }] },
  );

  const content =
    "Name,Code,Amount,Due\n" +
    "Visible update,AC-1,2,2026-10-02\n" +
    "Hidden attempt,HIDDEN,8,2026-10-08\n" +
    "Case variant,ac-1,3,2026-10-03\n" +
    "Whitespace variant,AC-1 ,4,2026-10-04\n";
  const base = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content,
  }, importer);
  const governed = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content,
    mapping: base.mapping,
    mode: "authorized-update",
    key_property_id: "code",
  }, importer);
  assert.equal(governed.keyed.normalization_version, 4);
  assert.deepEqual(governed.keyed.counts, {
    insert: 2,
    update: 1,
    skip: 0,
    conflict: 0,
    conflict_restricted: 1,
  });
  assert.match(governed.keyed.plan_digest, /^[a-f0-9]{64}$/);
  const restricted = governed.keyed.decisions.find(
    (decision: any) => decision.action === "conflict_restricted",
  );
  assert.deepEqual(restricted, {
    index: 1,
    action: "conflict_restricted",
    key: null,
  });
  assert.doesNotMatch(JSON.stringify(governed.keyed), new RegExp(hidden.id));
  assert.doesNotMatch(JSON.stringify(governed.keyed), /HIDDEN/);

  assert.equal(
    (
      await req("POST", "/imports/preview", {
        parent_id: importSpace.id,
        target_database_id: target.id,
        content,
        mapping: base.mapping,
        mode: "authorized-update",
        key_property_id: "code",
      }, other)
    ).statusCode,
    404,
  );

  const duplicateContent =
    "Name,Code,Amount,Due\nOne,DUP,1,2026-10-01\nTwo,DUP,2,2026-10-02\n";
  const duplicateBase = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: duplicateContent,
  }, importer);
  const duplicate = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: duplicateContent,
    mapping: duplicateBase.mapping,
    mode: "authorized-update",
    key_property_id: "code",
  }, importer);
  assert.equal(duplicate.keyed.counts.conflict, 2);

  const blankContent = "Name,Code,Amount,Due\nBlank,   ,1,2026-10-01\n";
  const blankBase = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: blankContent,
  }, importer);
  const blank = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: blankContent,
    mapping: blankBase.mapping,
    mode: "authorized-update",
    key_property_id: "code",
  }, importer);
  assert.equal(blank.keyed.counts.conflict, 1);

  const numberContent =
    "Name,Code,Amount,Due\nNumeric match,unused,1.0,2026-12-01\n";
  const numberBase = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: numberContent,
  }, importer);
  const numberPreview = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: numberContent,
    mapping: numberBase.mapping,
    mode: "authorized-update",
    key_property_id: "amount",
  }, importer);
  assert.equal(numberPreview.keyed.counts.update, 1);

  const dateContent =
    "Name,Code,Amount,Due\nDate match,unused,7,2026-10-01\n";
  const dateBase = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: dateContent,
  }, importer);
  const datePreview = await ok("POST", "/imports/preview", {
    parent_id: importSpace.id,
    target_database_id: target.id,
    content: dateContent,
    mapping: dateBase.mapping,
    mode: "authorized-update",
    key_property_id: "due",
  }, importer);
  assert.equal(datePreview.keyed.counts.update, 1);

  assert.equal(
    (await ok("GET", "/records/" + visible.id, undefined, importer)).revision,
    1,
    "preview must remain read-only",
  );
});


test("W09d worker binds accepted preview decisions and rolls back stale work", async () => {
  const importer = await freshMemberActor("W09d worker importer");
  const importSpace = await ok("POST", "/resources", {
    kind: "space",
    parent_id: root.id,
    title: "W09d worker " + randomUUID().slice(0, 8),
  });
  await permissionPatch(
    "/resources/" + importSpace.id + "/permissions",
    { inherit: false, grants: [{ principal_id: importer.id, level: 3 }] },
  );
  const target = await ok("POST", "/resources", {
    kind: "database",
    parent_id: importSpace.id,
    title: "W09d worker target",
  });
  const url = "/databases/" + target.id;
  await ok("PATCH", url, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "code", name: "Code", type: "text" },
      { id: "amount", name: "Amount", type: "number" },
      { id: "due", name: "Due", type: "date" },
    ],
  });
  const visible = await ok("POST", url + "/records", {
    values: { name: "Visible", code: "AC-1", amount: 1, due: "2026-10-01" },
  });

  const previewFor = async (content: string) => {
    const base = await ok("POST", "/imports/preview", {
      parent_id: importSpace.id,
      target_database_id: target.id,
      content,
    }, importer);
    const keyed = await ok("POST", "/imports/preview", {
      parent_id: importSpace.id,
      target_database_id: target.id,
      content,
      mapping: base.mapping,
      mode: "authorized-update",
      key_property_id: "code",
    }, importer);
    return { base, keyed };
  };
  const requestFor = (
    name: string,
    content: string,
    preview: any,
    idempotency_key = randomUUID(),
  ) => ({
    parent_id: importSpace.id,
    target_database_id: target.id,
    format: "csv",
    name,
    content,
    mapping: preview.base.mapping,
    expected_schema_digest: preview.keyed.target.schema_digest,
    existing_mode: "authorized-update",
    key_property_id: "code",
    keyed_plan_digest: preview.keyed.keyed.plan_digest,
    // Every caller above intentionally authorizes a real update, so the
    // server-side explicit-confirmation gate must be satisfied.
    confirm_keyed_updates: true,
    idempotency_key,
  });

  const updateContent =
    "Name,Code,Amount,Due\nUpdated visible,AC-1,2,2026-10-02\n";
  const accepted = await previewFor(updateContent);
  const replayKey = randomUUID();
  const acceptedRequest = requestFor(
    "W09d accepted update",
    updateContent,
    accepted,
    replayKey,
  );
  // The confirmation gate is intentional: an otherwise valid authorized update
  // submitted without explicit confirmation is refused with 400.
  const unconfirmed = await req(
    "POST",
    "/imports",
    {
      ...acceptedRequest,
      confirm_keyed_updates: false,
      idempotency_key: randomUUID(),
    },
    importer,
  );
  assert.equal(unconfirmed.statusCode, 400, unconfirmed.body);
  assert.match(unconfirmed.body, /explicit confirmation/i);
  const queued = await ok("POST", "/imports", acceptedRequest, importer);
  await tick(db);
  const completed = await ok("GET", "/jobs/" + queued.id, undefined, importer);
  assert.equal(completed.status, "completed", JSON.stringify(completed.result));
  const updated = await ok("GET", "/records/" + visible.id, undefined, importer);
  assert.equal(updated.values.name, "Updated visible");
  assert.equal(updated.revision, 2);
  assert.deepEqual(
    await ok("POST", "/imports", acceptedRequest, importer),
    { id: queued.id, status: "completed" },
  );

  const staleBeforeSubmit = await previewFor(updateContent);
  await ok("PATCH", "/records/" + visible.id, {
    values: { name: "Owner changed after preview" },
    expected_revision: 2,
  });
  const staleSubmit = await req(
    "POST",
    "/imports",
    requestFor(
      "W09d stale before submit",
      updateContent,
      staleBeforeSubmit,
    ),
    importer,
  );
  assert.equal(staleSubmit.statusCode, 409, staleSubmit.body);
  assert.match(staleSubmit.body, /preview changed/i);

  const workerContent =
    "Name,Code,Amount,Due\n" +
    "Worker stale,AC-1,5,2026-10-05\n" +
    "Must roll back,FRESH-W09D,6,2026-10-06\n";
  const workerPreview = await previewFor(workerContent);
  const workerJob = await ok(
    "POST",
    "/imports",
    requestFor("W09d worker revision fence", workerContent, workerPreview),
    importer,
  );
  await ok("PATCH", "/records/" + visible.id, {
    values: { name: "Changed after queue" },
    expected_revision: 3,
  });
  await tick(db);
  const workerFailed = await ok("GET", "/jobs/" + workerJob.id, undefined, importer);
  assert.equal(workerFailed.status, "failed");
  assert.match(workerFailed.result.error, /preview changed/i);
  const rowsAfterRevisionFailure = await ok("GET", url + "/records", undefined, importer);
  assert.equal(
    rowsAfterRevisionFailure.some((row: any) => row.values.code === "FRESH-W09D"),
    false,
    "worker-time revision conflict must roll back the fresh insert",
  );

  const aclContent =
    "Name,Code,Amount,Due\nACL stale,AC-1,7,2026-10-07\n";
  const aclPreview = await previewFor(aclContent);
  const aclJob = await ok(
    "POST",
    "/imports",
    requestFor("W09d ACL fence", aclContent, aclPreview),
    importer,
  );
  await permissionPatch(
    "/resources/" + visible.id + "/permissions",
    { inherit: false, grants: [{ principal_id: importer.id, level: 0 }] },
  );
  await tick(db);
  const aclFailed = await ok("GET", "/jobs/" + aclJob.id, undefined, importer);
  assert.equal(aclFailed.status, "failed");
  assert.match(aclFailed.result.error, /preview changed|conflicting row/i);
  assert.equal(
    (await req("GET", "/records/" + visible.id, undefined, importer)).statusCode,
    404,
  );
});

test("W12b notification receipts require current recipient and page access", async () => {
  // Prior integration scenarios revoke their shared member session. Use a
  // dedicated active actor so this security proof is independent of test order.
  const recipientId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      recipientId,
      "receipt-" + recipientId + "@example.test",
      "Receipt Recipient",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [owner.tenant, recipientId],
    );
  });
  const recipientToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, recipientId),
  );
  const recipient = {
    id: recipientId,
    tenant: owner.tenant,
    cookie: "workspace_session=" + recipientToken,
    csrf: csrf(recipientToken),
  };
  const foreignToken = await db.tenant(other.tenant, (q) =>
    createSession(q, other.tenant, owner.id),
  );
  const foreign = {
    cookie: "workspace_session=" + foreignToken,
    csrf: csrf(foreignToken),
  };
  assert.equal(
    (await req("GET", "/me", undefined, recipient)).statusCode,
    200,
    "Dedicated recipient must be independently authenticated",
  );
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W12b receipt scoping",
  });
  await ok("POST", "/resources/" + target.id + "/comments", {
    body: "Please inspect this @{" + recipientId + "}",
  });
  const before = await ok("GET", "/notifications", undefined, recipient);
  const notice = before.find((n: any) => n.resource_id === target.id);
  assert.ok(notice, "An eligible mention must create a visible notification");
  assert.equal(notice.read_at, null, "New mention begins unread");
  const key = "/notifications/" + notice.id;
  const marked = await ok("PATCH", key, { read: true }, recipient);
  assert.equal(marked.id, notice.id);
  assert.ok(marked.read_at, "Read time persists in PostgreSQL");
  const replay = await ok("PATCH", key, { read: true }, recipient);
  assert.equal(
    replay.read_at,
    marked.read_at,
    "Idempotent read requests must retain the original timestamp",
  );
  assert.equal(
    (await ok("GET", "/notifications", undefined, recipient)).find(
      (n: any) => n.id === notice.id,
    ).read_at,
    marked.read_at,
  );
  const unread = await ok("PATCH", key, { read: false }, recipient);
  assert.equal(unread.read_at, null);
  assert.equal(
    (await req("PATCH", key, { read: true }, owner)).statusCode,
    404,
    "Owner may not mutate another recipient's receipt",
  );
  assert.equal(
    (await req("PATCH", key, { read: true }, foreign)).statusCode,
    404,
    "Other tenant may not infer notification existence",
  );
  assert.equal(
    (await req("PATCH", key, { read: "yes" }, recipient)).statusCode,
    400,
  );
  await permissionPatch("/resources/" + target.id + "/permissions", {
    inherit: true,
    grants: [{ principal_id: recipientId, level: 0 }],
  });
  const after = await ok("GET", "/notifications", undefined, recipient);
  assert.ok(
    !after.some((n: any) => n.id === notice.id),
    "Revocation must hide previously delivered notification content",
  );
  assert.equal(
    (await req("PATCH", key, { read: true }, recipient)).statusCode,
    404,
    "A known notification UUID grants no access after revocation",
  );
});

test("W12c reply notifications respect recipient ACL and mention deduplication", async () => {
  const recipientId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query("INSERT INTO users(id,email,name) VALUES($1,$2,$3)", [
      recipientId,
      "thread-" + recipientId + "@example.test",
      "Thread Recipient",
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [owner.tenant, recipientId],
    );
  });
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, recipientId),
  );
  const recipient = {
    id: recipientId,
    tenant: owner.tenant,
    cookie: "workspace_session=" + token,
    csrf: csrf(token),
  };
  assert.equal((await req("GET", "/me", undefined, recipient)).statusCode, 200);
  const page = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Recipient reply notice",
  });
  const url = "/resources/" + page.id + "/comments";
  const root = await ok("POST", url, { body: "Root by recipient" }, recipient);
  assert.ok(root.id);
  const before = (
    await ok("GET", "/notifications", undefined, recipient)
  ).filter((n: any) => n.resource_id === page.id);
  assert.equal(before.length, 0);
  const first = await ok(
    "POST",
    url,
    { reply_to: root.id, body: "A plain response" },
    owner,
  );
  assert.equal(first.parent_comment_id, root.id);
  const after = await ok("GET", "/notifications", undefined, recipient);
  const notices = after.filter((n: any) => n.resource_id === page.id);
  assert.equal(
    notices.length,
    1,
    "An unmentioned root author gets one reply alert",
  );
  assert.match(notices[0].message, /replied to your comment/);
  // Same recipient appears as an explicit mention twice and the root author:
  // only one notification may be created for this comment transaction.
  await ok(
    "POST",
    url,
    {
      reply_to: root.id,
      body:
        "Explicit @{" + recipientId + "} and repeated @{" + recipientId + "}",
    },
    owner,
  );
  const next = (await ok("GET", "/notifications", undefined, recipient)).filter(
    (n: any) => n.resource_id === page.id,
  );
  assert.equal(next.length, 2, "No duplicate delivery for mention+reply");
  assert.equal(
    next.filter((n: any) => /mentioned you/.test(n.message)).length,
    1,
  );
  await permissionPatch("/resources/" + page.id + "/permissions", {
    inherit: true,
    grants: [{ principal_id: recipientId, level: 0 }],
  });
  await ok(
    "POST",
    url,
    { reply_to: root.id, body: "After recipient revocation" },
    owner,
  );
  const persisted = await db.tenant(owner.tenant, (q) =>
    q.query(
      "SELECT COUNT(*)::int count FROM notifications WHERE user_id=$1 AND resource_id=$2",
      [recipientId, page.id],
    ),
  );
  assert.equal(
    persisted.rows[0].count,
    2,
    "No new private reply notification is stored after ACL revocation",
  );
  assert.equal((await req("GET", url, undefined, recipient)).statusCode, 404);
});

test("W12d alert preferences enforce recipient delivery modes under tenant RLS", async () => {
  const recipientId = randomUUID();
  await db.tenant(owner.tenant, async (q) => {
    await q.query(
      "INSERT INTO users(id,email,name) VALUES($1,$2,'Alert Preferences Recipient')",
      [recipientId, "alerts-" + recipientId + "@example.test"],
    );
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'member',true)",
      [owner.tenant, recipientId],
    );
  });
  const token = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, recipientId),
  );
  const recipient = {
    id: recipientId,
    tenant: owner.tenant,
    cookie: "workspace_session=" + token,
    csrf: csrf(token),
  };
  const url = "/notification-preferences";
  assert.deepEqual(
    await ok("GET", url, undefined, recipient),
    {
      mentions_enabled: true,
      replies_enabled: true,
    },
    "Default behavior must retain existing delivery",
  );
  assert.equal(
    (await req("PATCH", url, { mentions_enabled: false }, recipient))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        "PATCH",
        url,
        {
          mentions_enabled: false,
          replies_enabled: false,
          secret: "not permitted",
        },
        recipient,
      )
    ).statusCode,
    400,
  );
  const allOff = await ok(
    "PATCH",
    url,
    {
      mentions_enabled: false,
      replies_enabled: false,
    },
    recipient,
  );
  assert.deepEqual(allOff, { mentions_enabled: false, replies_enabled: false });
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Recipient alert choices",
  });
  const comments = "/resources/" + target.id + "/comments";
  const root = await ok(
    "POST",
    comments,
    { body: "Root by notification recipient" },
    recipient,
  );
  await ok("POST", comments, {
    reply_to: root.id,
    body: "Suppressed @{" + recipientId + "}",
  });
  let received = (
    await ok("GET", "/notifications", undefined, recipient)
  ).filter((n: any) => n.resource_id === target.id);
  assert.equal(received.length, 0, "Disabled modes must prevent insertion");
  await ok(
    "PATCH",
    url,
    {
      mentions_enabled: true,
      replies_enabled: false,
    },
    recipient,
  );
  await ok("POST", comments, {
    reply_to: root.id,
    body: "Explicit mention @{" + recipientId + "} only",
  });
  await ok("POST", comments, { reply_to: root.id, body: "Reply still muted" });
  received = (await ok("GET", "/notifications", undefined, recipient)).filter(
    (n: any) => n.resource_id === target.id,
  );
  assert.equal(received.length, 1);
  assert.match(received[0].message, /mentioned you/);
  await ok(
    "PATCH",
    url,
    {
      mentions_enabled: false,
      replies_enabled: true,
    },
    recipient,
  );
  await ok("POST", comments, {
    reply_to: root.id,
    body: "Reply delivery now enabled",
  });
  received = (await ok("GET", "/notifications", undefined, recipient)).filter(
    (n: any) => n.resource_id === target.id,
  );
  assert.equal(received.length, 2);
  assert.equal(
    received.filter((n: any) => /replied to your comment/.test(n.message))
      .length,
    1,
  );
  // Preferences are persisted per recipient and tenant, not per browser session.
  const freshToken = await db.tenant(owner.tenant, (q) =>
    createSession(q, owner.tenant, recipientId),
  );
  const fresh = {
    cookie: "workspace_session=" + freshToken,
    csrf: csrf(freshToken),
  };
  assert.deepEqual(await ok("GET", url, undefined, fresh), {
    mentions_enabled: false,
    replies_enabled: true,
  });
  const foreignToken = await db.tenant(other.tenant, (q) =>
    createSession(q, other.tenant, owner.id),
  );
  const foreign = {
    cookie: "workspace_session=" + foreignToken,
    csrf: csrf(foreignToken),
  };
  await ok(
    "PATCH",
    url,
    { mentions_enabled: true, replies_enabled: true },
    foreign,
  );
  assert.deepEqual(
    await ok("GET", url, undefined, recipient),
    {
      mentions_enabled: false,
      replies_enabled: true,
    },
    "Other tenant preferences may not change recipient defaults",
  );
});

test("W17 portable archive export is tenant-safe, checksummed and bounded", async () => {
  const target = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "Portable export slice",
  });
  await ok("PATCH", `/pages/${target.id}/content`, {
    blocks: [{ type: "paragraph", content: "Round trip me" }],
    expected_revision: 1,
  });
  const boundary = `----w17-export-${randomUUID()}`,
    content = "Portable attachment bytes",
    data = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="portable.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  const up = await req("POST", `/resources/${target.id}/files`, data, owner, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(up.statusCode, 200, up.body);
  const upJson = up.json();
  assert.ok(upJson.id, "Upload must return an attachment id");

  const res = await req(
    "GET",
    `/resources/${target.id}/export/archive`,
    undefined,
    owner,
  );
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers["content-type"]), /application\/zip/);
  const bytes = res.rawPayload as Buffer;
  const inspected = inspectPortableArchive(bytes, { collect: true });
  assert.equal(inspected.manifest.format, PORTABLE_ARCHIVE_FORMAT);
  assert.equal(inspected.manifest.version, PORTABLE_ARCHIVE_VERSION);
  assert.equal(inspected.manifest.root.source_id, target.id);
  assert.equal(inspected.manifest.counts.documents, 1);
  assert.equal(inspected.manifest.counts.files, 1);
  assert.equal(inspected.manifest.counts.resources, 1);

  const tree = JSON.parse(String(inspected.entries.get("tree.json")));
  assert.ok(tree.some((n: any) => n.id === target.id));
  for (const node of tree)
    assert.deepEqual(
      Object.keys(node).sort(),
      ["icon", "id", "kind", "parent_id", "position", "title"],
      "Tree entries must stay portable metadata only",
    );

  const doc = JSON.parse(
    String(inspected.entries.get(`documents/${target.id}.json`)),
  );
  assert.ok(String(doc.plain_text).includes("Round trip me"));

  const blob = inspected.entries.get(`files/${upJson.id}.data`);
  assert.equal(blob ? blob.toString() : undefined, content);
  const fileIndex = JSON.parse(
    String(inspected.entries.get("files/index.json")),
  );
  assert.equal(fileIndex[0].name, "portable.txt");
  assert.equal(fileIndex[0].resource_id, target.id);

  // A principal outside the tenant cannot export anything, and the
  // archive itself never carries tenant identifiers or ACL grants.
  const foreign = await req(
    "GET",
    `/resources/${target.id}/export/archive`,
    undefined,
    other,
  );
  // Fail closed without revealing existence across tenants (the permission
  // layer hides cross-tenant resources with 404; 403 covers same-tenant
  // principals without read access).
  assert.ok(
    [403, 404].includes(foreign.statusCode),
    String(foreign.statusCode),
  );
  assert.ok(
    !JSON.stringify(inspected.manifest).includes("tenant"),
    "Manifest must not expose tenant-scoped fields",
  );
});


test("W17 async portable archive round-trips fresh IDs links relations files and ACL inheritance", async () => {
  const roundTripMember = await freshMemberActor("W17 Round Trip Member");
  const source = await ok("POST", "/resources", {
    kind: "space",
    parent_id: root.id,
    title: "W17 round trip source",
  });
  const targetPage = await ok("POST", "/resources", {
    kind: "page",
    parent_id: source.id,
    title: "W17 linked target",
  });
  const linkingPage = await ok("POST", "/resources", {
    kind: "page",
    parent_id: source.id,
    title: "W17 linking page",
  });
  await ok("PATCH", `/pages/${linkingPage.id}/content`, {
    blocks: [{
      type: "paragraph",
      content: [{
        type: "link",
        href: "/?page=" + targetPage.id,
        content: [{ type: "text", text: "Follow the imported target", styles: {} }],
      }],
    }],
    expected_revision: 1,
  });

  const targetDb = await ok("POST", "/resources", {
    kind: "database",
    parent_id: source.id,
    title: "W17 relation target",
  });
  const sourceDb = await ok("POST", "/resources", {
    kind: "database",
    parent_id: source.id,
    title: "W17 relation source",
  });
  await ok("PATCH", `/databases/${sourceDb.id}`, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      {
        id: "related",
        name: "Related",
        type: "relation",
        target_database_id: targetDb.id,
      },
      { id: "owner", name: "Owner", type: "person" },
    ],
  });
  const targetRecord = await ok(
    "POST", `/databases/${targetDb.id}/records`, {
      values: { name: "Portable target record" },
    });
  const sourceRecord = await ok(
    "POST", `/databases/${sourceDb.id}/records`, {
      values: {
        name: "Portable source record",
        related: [targetRecord.id],
        owner: owner.id,
      },
    });

  const boundary = `----w17-roundtrip-${randomUUID()}`,
    attachmentText = "W17 semantic attachment bytes",
    multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="roundtrip.txt"\r\nContent-Type: text/plain\r\n\r\n${attachmentText}\r\n--${boundary}--\r\n`;
  const uploaded = await req(
    "POST",
    `/resources/${linkingPage.id}/files`,
    multipart,
    owner,
    { "content-type": `multipart/form-data; boundary=${boundary}` },
  );
  assert.equal(uploaded.statusCode, 200, uploaded.body);

  await permissionPatch(`/resources/${linkingPage.id}/permissions`, {
    inherit: false,
    grants: [],
  });
  assert.equal(
    (await req("GET", `/resources/${linkingPage.id}`, undefined, roundTripMember))
      .statusCode,
    404,
  );

  const exportJob = await ok(
    "POST", `/resources/${source.id}/export/archive/jobs`, {});
  await tick(db, undefined, fakeAntivirus);
  const exported = await ok("GET", `/jobs/${exportJob.id}`);
  assert.equal(exported.status, "completed");
  assert.equal(exported.result.resource_id, source.id);
  assert.match(exported.result.sha256, /^[a-f0-9]{64}$/);

  const download = await req(
    "GET", `/jobs/${exportJob.id}/archive`, undefined, owner);
  assert.equal(download.statusCode, 200, download.body);
  assert.match(String(download.headers["content-type"]), /application\/zip/);
  const archive = download.rawPayload as Buffer;
  assert.ok(archive.length > 0);
  const collectedArchive = inspectPortableArchive(archive, { collect: true });
  for (const [entryPath, entryBytes] of collectedArchive.entries)
    if (entryPath.endsWith(".json"))
      assert.doesNotMatch(
        entryBytes.toString("utf8"),
        new RegExp(owner.id),
        "Portable archive JSON must not carry Person-property user UUIDs",
      );

  const queuedImport = await req(
    "POST",
    `/imports/archive?parent_id=${root.id}`,
    archive,
    owner,
    { "content-type": "application/zip" },
  );
  assert.equal(queuedImport.statusCode, 200, queuedImport.body);
  const importJob = queuedImport.json();
  await tick(db, undefined, fakeAntivirus);
  const imported = await ok("GET", `/jobs/${importJob.id}`);
  assert.equal(imported.status, "completed");
  assert.notEqual(imported.result.resource_id, source.id);
  assert.equal(imported.result.report.acl_copied, false);
  assert.equal(imported.result.report.files, 1);

  const importedRootId = imported.result.resource_id;
  const children = await ok(
    "GET", `/resources?parent_id=${importedRootId}&limit=50`);
  const byTitle = new Map<string, any>(
    children.map((item: any) => [item.title, item]),
  );
  const clonedTargetPage = byTitle.get("W17 linked target");
  const clonedLinkingPage = byTitle.get("W17 linking page");
  const clonedTargetDb = byTitle.get("W17 relation target");
  const clonedSourceDb = byTitle.get("W17 relation source");
  assert.ok(clonedTargetPage && clonedLinkingPage &&
    clonedTargetDb && clonedSourceDb);

  const clonedBody = await ok(
    "GET", `/pages/${clonedLinkingPage.id}/content`);
  assert.match(JSON.stringify(clonedBody.blocks),
    new RegExp(clonedTargetPage.id));
  assert.doesNotMatch(JSON.stringify(clonedBody.blocks),
    new RegExp(targetPage.id));

  const clonedDefinition = await ok(
    "GET", `/databases/${clonedSourceDb.id}`);
  const relation = clonedDefinition.properties.find(
    (property: any) => property.id === "related");
  assert.equal(relation.target_database_id, clonedTargetDb.id);

  const clonedTargetRecords = await ok(
    "GET", `/databases/${clonedTargetDb.id}/records`);
  const clonedSourceRecords = await ok(
    "GET", `/databases/${clonedSourceDb.id}/records`);
  assert.equal(clonedTargetRecords.length, 1);
  assert.equal(clonedSourceRecords.length, 1);
  assert.notEqual(clonedTargetRecords[0].id, targetRecord.id);
  assert.notEqual(clonedSourceRecords[0].id, sourceRecord.id);
  assert.deepEqual(
    clonedSourceRecords[0].values.related,
    [clonedTargetRecords[0].id],
  );
  assert.equal(clonedSourceRecords[0].values.owner ?? null, null);

  const importedFiles = await ok(
    "GET", `/resources/${clonedLinkingPage.id}/files`);
  assert.equal(importedFiles.length, 1);
  assert.notEqual(importedFiles[0].id, uploaded.json().id);
  const importedBytes = await req(
    "GET", `/files/${importedFiles[0].id}/content`);
  assert.equal(importedBytes.statusCode, 200);
  assert.equal(importedBytes.rawPayload.toString(), attachmentText);

  assert.equal(
    (await req("GET", `/resources/${clonedLinkingPage.id}`, undefined, roundTripMember))
      .statusCode,
    200,
    "Imported resources inherit destination ACLs instead of source ACL rows",
  );

  const inputArtifacts = await db.tenant(owner.tenant, (q) =>
    q.query("SELECT kind FROM job_artifacts WHERE job_id=$1", [importJob.id]));
  assert.equal(inputArtifacts.rows.length, 0);
  const queuedDeletion = await db.tenant(owner.tenant, (q) =>
    one(q,
      "SELECT status FROM object_deletions WHERE reason='job_input_consumed'" +
        " ORDER BY created_at DESC LIMIT 1"));
  assert.ok(queuedDeletion);
  await tick(db, undefined, fakeAntivirus);
  const completedDeletion = await db.tenant(owner.tenant, (q) =>
    one(q,
      "SELECT status FROM object_deletions WHERE reason='job_input_consumed'" +
        " ORDER BY created_at DESC LIMIT 1"));
  assert.equal(completedDeletion.status, "completed");
});


test("W17 failed malware import rolls back database writes and leaves only cataloged stage bytes", async () => {
  const source = await ok("POST", "/resources", {
    kind: "page",
    parent_id: space.id,
    title: "W17 infected import source " + randomUUID().slice(0, 8),
  });
  const boundary = `----w17-infected-${randomUUID()}`,
    content = "W17 scanner rejection payload",
    multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scanner.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  const uploaded = await req(
    "POST",
    `/resources/${source.id}/files`,
    multipart,
    owner,
    { "content-type": `multipart/form-data; boundary=${boundary}` },
  );
  assert.equal(uploaded.statusCode, 200, uploaded.body);

  const exported = await req(
    "GET", `/resources/${source.id}/export/archive`, undefined, owner);
  assert.equal(exported.statusCode, 200, exported.body);
  const beforeChildren = await ok(
    "GET", `/resources?parent_id=${space.id}&limit=200`);
  const storageBeforeStage = await storedFiles(dir);

  const staged = await req(
    "POST",
    `/imports/archive?parent_id=${space.id}`,
    exported.rawPayload,
    owner,
    { "content-type": "application/zip" },
  );
  assert.equal(staged.statusCode, 200, staged.body);
  const job = staged.json();
  const artifact = await db.tenant(owner.tenant, (q) =>
    one(q,
      "SELECT object_key FROM job_artifacts WHERE job_id=$1 AND kind='input'",
      [job.id]));
  assert.ok(artifact?.object_key);
  const storageAfterStage = await storedFiles(dir);
  assert.equal(storageAfterStage.length, storageBeforeStage.length + 1,
    "Staging adds exactly one encrypted archive object");

  antivirusResult = { status: "infected", signature: "W17-Test-Signature" };
  try {
    await tick(db, undefined, fakeAntivirus);
  } finally {
    antivirusResult = { status: "clean" };
  }
  const failed = await ok("GET", `/jobs/${job.id}`);
  assert.equal(failed.status, "failed");
  assert.match(failed.result.error, /malware scanner/i);

  const afterChildren = await ok(
    "GET", `/resources?parent_id=${space.id}&limit=200`);
  assert.deepEqual(
    afterChildren.map((item: any) => item.id).sort(),
    beforeChildren.map((item: any) => item.id).sort(),
    "Failed archive import must roll back its resource subtree",
  );
  const storageAfterFailure = await storedFiles(dir);
  assert.deepEqual(storageAfterFailure, storageAfterStage,
    "Failed import must not leave imported attachment objects");
  const retained = await db.tenant(owner.tenant, (q) =>
    one(q,
      "SELECT object_key,expires_at FROM job_artifacts" +
        " WHERE job_id=$1 AND kind='input'",
      [job.id]));
  assert.equal(retained.object_key, artifact.object_key,
    "Failed staged input remains cataloged for bounded expiry/retry evidence");
});


test("W17 export redacts unreadable external relation schema metadata", async () => {
  const redactionMember = await freshMemberActor("W17 Redaction Member");
  const hiddenTarget = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W17 hidden relation target",
  });
  const visibleSource = await ok("POST", "/resources", {
    kind: "database",
    parent_id: space.id,
    title: "W17 visible relation source",
  });
  await ok("PATCH", `/databases/${visibleSource.id}`, {
    properties: [
      { id: "name", name: "Name", type: "title" },
      {
        id: "secret_relation",
        name: "Secret relation",
        type: "relation",
        target_database_id: hiddenTarget.id,
      },
    ],
  });
  await permissionPatch(`/resources/${hiddenTarget.id}/permissions`, {
    inherit: true,
    grants: [{ principal_id: redactionMember.id, level: 0 }],
  });
  assert.equal(
    (await req("GET", `/resources/${hiddenTarget.id}`, undefined, redactionMember))
      .statusCode,
    404,
  );
  assert.equal(
    (await req("GET", `/resources/${visibleSource.id}`, undefined, redactionMember))
      .statusCode,
    200,
  );

  const exported = await req(
    "GET",
    `/resources/${visibleSource.id}/export/archive`,
    undefined,
    redactionMember,
  );
  assert.equal(exported.statusCode, 200, exported.body);
  const inspected = inspectPortableArchive(
    exported.rawPayload as Buffer,
    { collect: true },
  );
  const schema = JSON.parse(String(
    inspected.entries.get(`databases/${visibleSource.id}.json`),
  ));
  assert.ok(
    !schema.properties.some((property: any) =>
      property.id === "secret_relation"),
    "Unreadable relation targets remove the relation property from portable schema",
  );
  for (const [entryPath, bytes] of inspected.entries)
    if (entryPath.endsWith(".json"))
      assert.doesNotMatch(
        bytes.toString("utf8"),
        new RegExp(hiddenTarget.id),
        "Hidden relation target UUID must not leak into archive metadata",
      );
});
