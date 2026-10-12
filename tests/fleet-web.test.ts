// OCP-2B acceptance: the read-only OpenJM fleet console.
//
// Covers plane separation, bootstrap authentication and session handling, credential
// isolation from the browser, overview counts, inventory filters, honest unknown
// rendering, deployment detail, alerts, audit, fleet-API error isolation and the
// read-only boundary.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFleetConsole, fleetConsoleConfig } from "../apps/fleet-web/src/server.ts";
import { FLEET_CONSOLE_ROUTES } from "../apps/fleet-web/src/server.ts";
import {
  createFleetClient,
  isProductionMode,
  parseConsoleHost,
  parseConsolePublicUrl,
  parseFleetApiBaseUrl,
} from "../apps/fleet-web/src/fleet-api.ts";
import { FLEET_SESSION_COOKIE, issueSession, readSession } from "../apps/fleet-web/src/session.ts";
import {
  NEVER_SEEN,
  NOT_REPORTED,
  UNKNOWN,
  displayBackup,
  displayCount,
  displayLastSeen,
  displayMetric,
  displayValue,
} from "../apps/fleet-web/src/render.ts";

const OPERATOR_TOKEN = "fleet-operator-token-0123456789";
const SESSION_SECRET = "fleet-console-session-secret-0123456789";

const config = fleetConsoleConfig({
  FLEET_API_BASE_URL: "https://fleet.example.com",
  FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN,
  FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET,
});

// ---------------------------------------------------------------------------
// Deterministic fixtures: every online/lifecycle state plus unknown fields.
// ---------------------------------------------------------------------------
const base = {
  first_seen: "2026-10-01T00:00:00.000Z",
  last_seen: "2026-10-12T06:00:00.000Z",
  app_version: "1.0.0",
  build_sha: "abc123",
  schema_version: "28",
  contract_version: "openjm.workspace.operator-telemetry.v1",
  queue: { depth: 0, state: "healthy" },
  storage: 42,
  database_capacity: null,
  backup: { last_backup_at: "2026-10-12T05:00:00.000Z", state: "healthy" },
  runtime: { overall: "healthy", api: "healthy", worker: "healthy", collaboration: "unknown", database: "healthy", redis: "healthy", storage: "healthy", antivirus: "healthy" },
};

const DEPLOYMENTS = [
  { ...base, id: "d-online", workspace_deployment_id: "ws-aaa1", alias: "alpha", state: "active", online_state: "online" },
  { ...base, id: "d-stale", workspace_deployment_id: "ws-aaa2", alias: "bravo", state: "active", online_state: "stale", queue: { depth: 12, state: "degraded" } },
  {
    ...base,
    id: "d-offline",
    workspace_deployment_id: "ws-aaa3",
    alias: "charlie",
    state: "active",
    online_state: "offline",
    storage: null,
    backup: { last_backup_at: null, state: "unknown" },
  },
  { ...base, id: "d-never", workspace_deployment_id: "ws-aaa4", alias: "delta", state: "active", online_state: "never_seen", last_seen: null, first_seen: null },
  { ...base, id: "d-disabled", workspace_deployment_id: "ws-aaa5", alias: "echo", state: "disabled", online_state: "disabled" },
  { ...base, id: "d-revoked", workspace_deployment_id: "ws-aaa6", alias: "foxtrot", state: "revoked", online_state: "revoked" },
] as any[];

const ALERTS = [
  { deployment_id: "d-offline", category: "deployment.offline", severity: "warning" },
  { deployment_id: "d-stale", category: "queue.degraded", severity: "warning" },
  { deployment_id: "d-never", category: "deployment.never_seen", severity: "info" },
] as any[];

function stubClient(overrides: Partial<Record<string, any>> = {}) {
  return {
    listDeployments: async () => ({ ok: true, data: { deployments: DEPLOYMENTS } }),
    deployment: async (id: string) => {
      const deployment = DEPLOYMENTS.find((entry) => entry.id === id);
      if (!deployment) return { ok: false, error: "server_error", status: 404 };
      return {
        ok: true,
        data: {
          deployment: { ...deployment, notes: null },
          credentials: [
            { id: "cred-1", state: "active", created_at: "2026-10-01T00:00:00.000Z", rotated_at: null, revoked_at: null },
            { id: "cred-2", state: "revoked", created_at: "2026-09-01T00:00:00.000Z", rotated_at: "2026-09-02T00:00:00.000Z", revoked_at: "2026-09-03T00:00:00.000Z" },
          ],
          telemetry: {
            runtime: {
              overall: "healthy",
              api: "healthy",
              worker: "degraded",
              collaboration: "unknown",
              database: "healthy",
              redis: "unknown",
              storage: "healthy",
              antivirus: "unhealthy",
            },
            signals: {
              requests: { total: 120, by_status_class: [{ status_class: "2xx", count: 120 }] },
              errors: { total: 0, by_status_class: [] },
              latency: { samples: 120, total_seconds: 3.5, max_seconds: 0.4 },
              services: [{ name: "worker", state: "degraded", configured: true, values: [{ name: "requests", value: 12 }, { name: "failures", value: null }] }],
              queue: { depth: 12, state: "degraded" },
              capacity: { storage: null, database: null },
            },
          },
          history: [
            { observed_at: "2026-10-12T06:00:00.000Z", queue_state: "degraded", backup_state: "healthy", online_state: "online" },
            { observed_at: "2026-10-12T05:00:00.000Z", queue_state: null, backup_state: null, online_state: "online" },
          ],
          alerts: [{ deployment_id: id, category: "queue.degraded", severity: "warning" }],
        },
      };
    },
    alerts: async () => ({ ok: true, data: { alerts: ALERTS } }),
    audit: async () => ({
      ok: true,
      data: {
        audit: [
          { action: "deployment.registered", deployment_id: "d-online", detail: null, created_at: "2026-10-01T00:00:00.000Z" },
          { action: "credential.rotated", deployment_id: "d-online", detail: "cred-1", created_at: "2026-10-02T00:00:00.000Z" },
          { action: "ingestion.rejected", deployment_id: null, detail: "replayed", created_at: "2026-10-03T00:00:00.000Z" },
        ],
      },
    }),
    health: async () => ({ ok: true, data: { status: "ok" } }),
    ...overrides,
  } as any;
}

let app: any;
let sessionCookie = "";

before(async () => {
  app = buildFleetConsole(config, { client: stubClient(), verifier: async (token: string) => (token === OPERATOR_TOKEN ? { ok: true } : { ok: false, error: "unauthorized" }) });
  await app.ready();
  sessionCookie = `${FLEET_SESSION_COOKIE}=${encodeURIComponent(issueSession(SESSION_SECRET, config.sessionTtlMs).cookieValue)}`;
});

const get = (url: string, cookies = sessionCookie) =>
  app.inject({ method: "GET", url, headers: cookies ? { cookie: cookies } : {} });

// ---------------------------------------------------------------------------
// Plane separation
// ---------------------------------------------------------------------------
test("the console is a separate plane from the customer Workspace app", () => {
  const webAppDir = fileURLToPath(new URL("../apps/web/app", import.meta.url));
  const entries = readdirSync(webAppDir);
  assert.ok(!entries.includes("fleet"), "the customer Workspace app must not gain a fleet route");
  // The console is a distinct application directory with no import from apps/web.
  const consoleSources = readdirSync(fileURLToPath(new URL("../apps/fleet-web/src", import.meta.url)));
  assert.deepEqual(consoleSources.sort(), ["console.css", "fleet-api.ts", "main.ts", "render.ts", "server.ts", "session.ts"]);
  const serverSource = readFileSync(fileURLToPath(new URL("../apps/fleet-web/src/server.ts", import.meta.url)), "utf8");
  assert.ok(!/^\s*import[^;]*apps\/web/m.test(serverSource), "the console must not import the customer Workspace app");
  // The console exposes no customer Workspace surface.
  assert.ok(!FLEET_CONSOLE_ROUTES.some((route) => /workspace|documents|settings|admin/i.test(route)));
});

// ---------------------------------------------------------------------------
// Configuration and credential isolation
// ---------------------------------------------------------------------------
test("console configuration fails closed and keeps the operator token server-side", () => {
  assert.throws(() => fleetConsoleConfig({ FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN, FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET }), /FLEET_API_BASE_URL/);
  assert.throws(() => fleetConsoleConfig({ FLEET_API_BASE_URL: "https://f", FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET }), /FLEET_OPERATOR_TOKEN/);
  assert.throws(() => fleetConsoleConfig({ FLEET_API_BASE_URL: "https://f", FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN }), /FLEET_CONSOLE_SESSION_SECRET/);
  assert.throws(
    () => fleetConsoleConfig({ FLEET_API_BASE_URL: "not-a-url", FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN, FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET }),
    /must be an absolute URL/,
  );
  const bounded = fleetConsoleConfig({
    FLEET_API_BASE_URL: "https://f",
    FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN,
    FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET,
    FLEET_CONSOLE_SESSION_TTL_MS: "999999999999",
    FLEET_CONSOLE_REQUEST_TIMEOUT_MS: "1",
  });
  assert.equal(bounded.sessionTtlMs, 86_400_000, "session lifetime is bounded upward");
  assert.equal(bounded.requestTimeoutMs, 500, "request timeout is bounded");
});

test("no console response or asset can contain the fleet operator credential", async () => {
  const pages = ["/", "/deployments", "/deployments/d-online", "/alerts", "/audit", "/login"];
  for (const url of pages) {
    const response = await get(url);
    assert.ok(!response.body.includes(OPERATOR_TOKEN), `${url} must not contain the operator token`);
    assert.ok(!response.body.includes("FLEET_OPERATOR_TOKEN"), `${url} must not reference the operator token setting`);
  }
  const css = await get("/assets/console.css");
  assert.ok(!css.body.includes(OPERATOR_TOKEN));
  // There is no client-side script at all, so there is no client bundle to leak into.
  for (const url of pages) {
    const response = await get(url);
    assert.ok(!/<script/i.test(response.body), `${url} must not load client-side script`);
    assert.ok(!/localStorage|sessionStorage|NEXT_PUBLIC/.test(response.body), `${url} must not use browser storage or public env`);
  }
  const csp = (await get("/")).headers["content-security-policy"];
  assert.match(String(csp), /default-src 'none'/);
  assert.match(String(csp), /style-src 'self'/);
  assert.doesNotMatch(String(csp), /script-src[^;]*unsafe-inline/);
  // The session cookie is HttpOnly and carries no credential material.
  const login = await app.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${encodeURIComponent(OPERATOR_TOKEN)}` });
  const setCookie = String(login.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.ok(!setCookie.includes(OPERATOR_TOKEN), "the session cookie must not carry the operator token");
});

// ---------------------------------------------------------------------------
// Authentication and session
// ---------------------------------------------------------------------------
test("unauthenticated access is denied and sign-in establishes a bounded session", async () => {
  for (const url of ["/", "/deployments", "/deployments/d-online", "/alerts", "/audit", "/nope"]) {
    const response = await get(url, "");
    assert.equal(response.statusCode, 303, `${url} must redirect an unauthenticated visitor`);
    assert.equal(response.headers.location, "/login");
    assert.equal(response.body, "", "no console content is served when unauthenticated");
  }
  const bad = await app.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "token=wrong-credential-value" });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers["set-cookie"], undefined, "a failed sign-in issues no session");
  const good = await app.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `token=${encodeURIComponent(OPERATOR_TOKEN)}` });
  assert.equal(good.statusCode, 303);
  assert.equal(good.headers.location, "/");
  // Tampered and expired sessions are unauthenticated.
  const forged = `${FLEET_SESSION_COOKIE}=${encodeURIComponent("tampered.value")}`;
  assert.equal((await get("/", forged)).statusCode, 303);
  const expired = issueSession(SESSION_SECRET, -1_000).cookieValue;
  assert.equal(readSession(expired, SESSION_SECRET), null, "an expired session is refused");
  assert.equal(readSession(`${expired}x`, SESSION_SECRET), null, "a tampered session is refused");
});

test("sign-out invalidates access", async () => {
  const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie: sessionCookie } });
  assert.equal(out.statusCode, 303);
  assert.equal(out.headers.location, "/login");
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/, "the session cookie is cleared");
  // The cleared cookie no longer authenticates anything.
  assert.equal((await get("/", `${FLEET_SESSION_COOKIE}=`)).statusCode, 303);
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
test("the overview reports factual state counts with no fabricated metrics", async () => {
  const response = await get("/");
  assert.equal(response.statusCode, 200);
  const body = response.body;
  assert.match(body, /Total deployments<\/p>\s*<p class="stat__value">6</);
  for (const [label, count] of [["Online", 1], ["Stale", 1], ["Offline", 1], ["Never seen", 1], ["Disabled", 1], ["Revoked", 1]] as const) {
    const pattern = new RegExp(`>${label}</p>\\s*<p class="stat__value">${count}<`);
    assert.match(body, pattern, `${label} count must be ${count}`);
  }
  assert.match(body, /3 deployments with at least one active alert, 2 warnings and 3 alerts total/);
  // No percentages or SLA claims are invented.
  assert.ok(!/%/.test(body.replace(/[^%]*?storage[^%]*/g, "")), "no percentage figures are fabricated");
  assert.match(body, /No percentages or SLA claims are derived/, "the console states that it derives no SLA claims");
  assert.ok(!/\b\d+(\.\d+)?%\s*(of|availability|uptime)/i.test(body), "no availability target claim is rendered");
  // A manual refresh affordance and a freshness statement are present.
  assert.match(body, /Refresh console data/);
  assert.match(body, /Data refreshed/);
  // The three-plane boundary is visible in the product chrome.
  assert.match(body, /OpenJM Fleet Console/);
  assert.match(body, /operator plane/);
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
test("the deployment inventory renders, filters, searches and links to detail", async () => {
  const all = await get("/deployments");
  assert.equal(all.statusCode, 200);
  assert.match(all.body, /6 of 6 registered deployments shown/);
  for (const alias of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) assert.ok(all.body.includes(alias));
  for (const id of ["ws-aaa1", "ws-aaa6"]) assert.ok(all.body.includes(id));
  assert.match(all.body, /href="\/deployments\/d-offline"/, "rows navigate to detail");

  const filtered = await get("/deployments?online_state=offline");
  assert.match(filtered.body, /1 of 6 registered deployments shown/);
  assert.ok(filtered.body.includes("charlie") && !filtered.body.includes("bravo"));

  const searched = await get("/deployments?q=brav");
  assert.match(searched.body, /1 of 6 registered deployments shown/);
  assert.ok(searched.body.includes("bravo"));

  const byId = await get("/deployments?q=ws-aaa5");
  assert.match(byId.body, /1 of 6 registered deployments shown/);
  assert.ok(byId.body.includes("echo"));

  const lifecycle = await get("/deployments?lifecycle=revoked");
  assert.match(lifecycle.body, /1 of 6 registered deployments shown/);
  assert.ok(lifecycle.body.includes("foxtrot"));

  const alerting = await get("/deployments?alerting=1");
  assert.match(alerting.body, /3 of 6 registered deployments shown/);

  const empty = await get("/deployments?q=nothing-matches");
  assert.match(empty.body, /No deployments match these filters/);
});

// ---------------------------------------------------------------------------
// Unknown semantics
// ---------------------------------------------------------------------------
test("null, unknown and absent values are never rendered as zero or healthy", () => {
  assert.equal(displayValue(null), UNKNOWN);
  assert.equal(displayValue(undefined), UNKNOWN);
  assert.equal(displayValue(""), UNKNOWN);
  assert.equal(displayValue("unknown"), UNKNOWN);
  assert.equal(displayCount(null), UNKNOWN);
  assert.equal(displayCount(0), "0", "a real zero stays zero");
  assert.equal(displayMetric(null), NOT_REPORTED);
  assert.equal(displayMetric(0), "0");
  assert.equal(displayLastSeen(null), NEVER_SEEN);
  assert.equal(displayBackup(null), UNKNOWN);
  assert.equal(displayBackup({ last_backup_at: null, state: "unknown" }), "Unknown");
  assert.equal(displayBackup({ last_backup_at: null, state: "healthy" }), "Healthy");
});

test("the rendered detail and inventory preserve unknown semantics in specific cells", async () => {
  const detail = await get("/deployments/d-online");
  const body = detail.body;
  // Database capacity is reported unknown by OCP-1 and must not become 0.
  assert.match(body, /Database capacity<\/td><td>Not reported<\/td>/);
  // Storage is not reported by the telemetry snapshot here either.
  assert.ok(body.includes("Local storage used %"), "the local storage signal is labelled");
  // Collaboration and redis are unknown in the snapshot.
  assert.match(body, /Collaboration<\/td><td>.*Unknown/);
  assert.match(body, /Redis<\/td><td>.*Unknown/);
  // A null service value is not reported, not zero.
  assert.match(body, /failures: Not reported/);
  // The history shows unknown queue/backup states honestly.
  assert.match(body, /(Unknown)/, "unknown history fields render as Unknown");

  const never = await get("/deployments/d-never");
  assert.match(never.body, /Never seen/, "a never-seen deployment stays Never seen");
  assert.ok(!/Last seen<\/td><td>0/.test(never.body), "never seen must never render as zero");

  const offline = await get("/deployments/d-offline");
  assert.match(offline.body, /Not reported/, "a null storage signal is Not reported");
  assert.match(offline.body, /Backup<\/td><td>Unknown<\/td>/, "unknown backup state renders as Unknown");
  // The specific storage cell is not a fabricated zero.
  assert.ok(!/Local storage used %<\/td><td>0<\/td>/.test(offline.body), "null storage must not become 0");
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
test("the deployment detail shows identity, health, telemetry, credentials, history and alerts", async () => {
  const response = await get("/deployments/d-stale");
  assert.equal(response.statusCode, 200);
  const body = response.body;
  assert.match(body, /Identity and inventory/);
  assert.match(body, /Runtime health/);
  assert.match(body, /Current telemetry/);
  assert.match(body, /not a time series/, "the snapshot is labelled as current telemetry, not a trend");
  assert.match(body, /Antivirus<\/td><td>.*Unhealthy/, "component health is shown");
  assert.match(body, /Queue depth<\/td><td>12/);
  assert.match(body, /Backup/);
  assert.match(body, /Credential status/);
  assert.match(body, /cred-1/);
  assert.match(body, /cred-2/);
  assert.ok(!/secret_encrypted|fleet-v1\./.test(body), "no credential secret envelope is displayed");
  assert.ok(!/\bBearer\s+[A-Za-z0-9._-]{8,}/.test(body), "no bearer credential is rendered");
  assert.match(body, /Recent state history/);
  assert.match(body, /Bounded state observations/);
  assert.match(body, /Alerts/);
  assert.match(body, /Queue degraded/);
  // Bounded deep-link behaviour.
  assert.equal((await get("/deployments/does-not-exist")).statusCode, 404);
  assert.match((await get("/deployments/does-not-exist")).body, /Deployment not found/);
});

// ---------------------------------------------------------------------------
// Alerts and audit
// ---------------------------------------------------------------------------
test("the alerts view renders, filters and shows an empty state", async () => {
  const response = await get("/alerts");
  assert.match(response.body, /3 of 3 current alerts shown/);
  assert.match(response.body, /Deployment offline/);
  assert.match(response.body, /Queue degraded/);
  assert.match(response.body, /Deployment never seen/);
  assert.match(response.body, /deployment\.offline/, "the canonical category is retained");
  const filtered = await get("/alerts?severity=info");
  assert.match(filtered.body, /1 of 3 current alerts shown/);
  const byCategory = await get("/alerts?category=queue.degraded");
  assert.match(byCategory.body, /1 of 3 current alerts shown/);
  const byDeployment = await get("/alerts?deployment=d-offline");
  assert.match(byDeployment.body, /1 of 3 current alerts shown/);

  const empty = buildFleetConsole({ ...config, baseUrl: "https://fleet.example.com" }, {
    client: stubClient({ alerts: async () => ({ ok: true, data: { alerts: [] } }) }),
  });
  const emptyResponse = await empty.inject({ method: "GET", url: "/alerts", headers: { cookie: sessionCookie } });
  assert.match(emptyResponse.body, /No current fleet alerts/);
  await empty.close();
});

test("the audit view renders bounded records without secrets", async () => {
  const response = await get("/audit");
  assert.match(response.body, /Deployment registered/);
  assert.match(response.body, /Credential rotated/);
  assert.match(response.body, /Telemetry ingestion rejected/);
  assert.match(response.body, /deployment\.registered/, "the canonical action is retained");
  assert.ok(!response.body.includes(OPERATOR_TOKEN));
  assert.ok(!/secret_encrypted|fleet-v1\./.test(response.body), "no credential envelope appears in audit output");
  assert.ok(!/\bBearer\s+[A-Za-z0-9._-]{8,}/.test(response.body), "no bearer credential appears in audit output");
  assert.ok(!/delete|export/i.test(response.body.replace(/This view is read-only[^<]*/g, "")), "no audit mutation or export controls");
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------
test("a fleet API outage is a bounded service error, never a fleet-wide outage claim", async () => {
  for (const failure of ["unreachable", "timeout", "unauthorized", "server_error"] as const) {
    const broken = buildFleetConsole(config, {
      client: stubClient({
        listDeployments: async () => ({ ok: false, error: failure, status: failure === "server_error" ? 500 : undefined }),
        alerts: async () => ({ ok: false, error: failure }),
      }),
    });
    const response = await broken.inject({ method: "GET", url: "/", headers: { cookie: sessionCookie } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Fleet API unavailable/);
    assert.match(
      response.body,
      /must never be rendered as deployments being offline or stale|not a statement about any deployment/,
      "the outage is not reinterpreted as deployments being offline",
    );
    for (const alias of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
      assert.ok(!response.body.includes(alias), `deployment ${alias} must not be reported during a fleet-API outage`);
    }
    assert.ok(!/Offline<\/p>\s*<p class="stat__value">[1-9]/.test(response.body), "no deployment is counted as offline from an outage");
    await broken.close();
  }
});

// ---------------------------------------------------------------------------
// Read-only boundary
// ---------------------------------------------------------------------------
test("the console exposes no mutation surface", async () => {
  const routes = app.printRoutes();
  // Only read routes, sign-in and sign-out are registered.
  assert.deepEqual([...FLEET_CONSOLE_ROUTES].sort(), [
    "GET /",
    "GET /alerts",
    "GET /assets/console.css",
    "GET /audit",
    "GET /deployments",
    "GET /deployments/:id",
    "GET /login",
    "POST /login",
    "POST /logout",
  ]);
  assert.ok(!/POST \/(deployments|ingest|deployments\/:id)/.test(routes), "no OCP-2A mutation route is exposed");
  const page = await get("/deployments/d-online");
  const markup = page.body;
  for (const forbidden of ["/ingest", "/lifecycle", "/credentials", "/rotate", "/revoke", "Register deployment", "Rotate credential"]) {
    assert.ok(!markup.includes(forbidden), `the console markup must not expose ${forbidden}`);
  }
  // The only forms are sign-out (and the read-only filter forms, which are GET).
  const forms: string[] = markup.match(/<form[^>]*>/g) ?? [];
  for (const form of forms) assert.match(form, /method="(get|post)"/);
  const posts = forms.filter((form) => form.includes('method="post"'));
  assert.deepEqual(posts.map((form) => form.match(/action="([^"]+)"/)?.[1]), ["/logout"]);
});

test("the fleet API client uses only read paths with bounded, normalized errors", async () => {
  const seen: string[] = [];
  const client = createFleetClient({
    baseUrl: "https://fleet.example.com",
    operatorToken: OPERATOR_TOKEN,
    timeoutMs: 50,
    fetchImpl: (async (url: any, init: any) => {
      seen.push(`${init.method} ${String(url)}`);
      return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
    }) as any,
  });
  await client.listDeployments();
  await client.deployment("abc");
  await client.alerts();
  await client.audit();
  await client.health();
  assert.deepEqual(seen, [
    "GET https://fleet.example.com/deployments",
    "GET https://fleet.example.com/deployments/abc",
    "GET https://fleet.example.com/alerts",
    "GET https://fleet.example.com/audit",
    "GET https://fleet.example.com/health",
  ]);
  // A timeout and an unreachable API are bounded, distinct outcomes.
  const timingOut = createFleetClient({
    baseUrl: "https://fleet.example.com",
    operatorToken: OPERATOR_TOKEN,
    timeoutMs: 20,
    fetchImpl: ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as any,
  });
  const timeout = await timingOut.listDeployments();
  assert.deepEqual(timeout, { ok: false, error: "timeout" });
  const unreachable = createFleetClient({
    baseUrl: "https://fleet.example.com",
    operatorToken: OPERATOR_TOKEN,
    timeoutMs: 50,
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as any,
  });
  assert.deepEqual(await unreachable.listDeployments(), { ok: false, error: "unreachable" });
  const unauthorized = createFleetClient({
    baseUrl: "https://fleet.example.com",
    operatorToken: OPERATOR_TOKEN,
    timeoutMs: 50,
    fetchImpl: (async () => new Response("{}", { status: 401 })) as any,
  });
  assert.deepEqual(await unauthorized.listDeployments(), { ok: false, error: "unauthorized", status: 401 });
});

// ---------------------------------------------------------------------------
// Accessibility structure
// ---------------------------------------------------------------------------
test("primary surfaces carry landmarks, headings, labels and text status", async () => {
  for (const url of ["/", "/deployments", "/deployments/d-online", "/alerts", "/audit"]) {
    const body = (await get(url)).body;
    assert.match(body, /<a class="skiplink" href="#main"/, `${url} offers a skip link`);
    assert.match(body, /<nav[^>]*aria-label="Fleet console sections"/, `${url} has a labelled navigation landmark`);
    assert.match(body, /<main id="main"/, `${url} has a main landmark`);
    assert.match(body, /<h1>/, `${url} has a level-one heading`);
    assert.match(body, /<h2[^>]*>/, `${url} has section headings`);
    assert.match(body, /<html lang="en">/, `${url} declares a language`);
    // Status values are always text, so meaning never depends on colour alone. Surfaces
    // that carry per-item status render textual badges; the overview states its counts
    // as text labels.
    if (url === "/") {
      for (const label of ["Online", "Stale", "Offline", "Never seen", "Disabled", "Revoked"]) {
        assert.match(body, new RegExp(`>${label}</p>`), `${url} states the ${label} count as text`);
      }
    } else if (url === "/audit") {
      // The audit surface carries no per-item status, so it renders canonical action
      // text instead of badges.
      assert.match(body, /<code>deployment\.registered<\/code>/, `${url} renders canonical actions as text`);
    } else {
      assert.match(body, /class="badge badge--/, `${url} shows textual status badges`);
    }
    assert.ok(!/style="[^"]*color/i.test(body), `${url} does not encode status in inline colour`);
  }
  const inventory = (await get("/deployments")).body;
  const select = inventory.match(/<select[^>]*id="online_state"[^>]*>/)?.[0] ?? "";
  assert.ok(inventory.includes('<label for="online_state">'), "filters are labelled");
  assert.match(inventory, /aria-label="Fleet deployments"|aria-label="Fleet deployments"/, "tables are labelled");
  assert.ok(inventory.includes("<th scope="), "table headers use scope");
});

// ---------------------------------------------------------------------------
// Review pass 2 findings
// ---------------------------------------------------------------------------
test("the fleet API transport refuses to carry the operator credential insecurely", () => {
  const production = (url: string) => parseFleetApiBaseUrl(url, true);
  const development = (url: string) => parseFleetApiBaseUrl(url, false);

  // Production HTTPS is the supported transport.
  assert.equal(production("https://fleet.example.com"), "https://fleet.example.com");
  assert.equal(production("https://fleet.example.com:8443/"), "https://fleet.example.com:8443");
  // A path prefix is preserved and normalized for reverse-proxy deployment.
  assert.equal(production("https://fleet.example.com/fleet-api/"), "https://fleet.example.com/fleet-api");

  // Production plaintext to a remote host is refused.
  assert.throws(() => production("http://fleet.example.com"), /must use https in production/);
  assert.throws(() => production("http://fleet.example.com:4100"), /must use https in production/);
  // Private, container and RFC1918 destinations are NOT treated as loopback.
  for (const privateUrl of [
    "http://10.0.0.10:4100",
    "http://192.168.1.5:4100",
    "http://172.16.4.4:4100",
    "http://fleet.internal:4100",
    "http://fleet-service:4100",
    "http://169.254.1.1:4100",
  ]) {
    assert.throws(() => production(privateUrl), /must use https in production/, `${privateUrl} must be refused in production`);
  }
  // Plaintext is permitted only for an explicitly local loopback destination.
  for (const loopback of ["http://127.0.0.1:4100", "http://localhost:4100", "http://[::1]:4100", "http://127.0.0.1:4100/"]) {
    assert.ok(production(loopback).startsWith("http://"), `${loopback} is permitted as a loopback destination`);
  }
  // Development HTTP remains usable for local testing.
  assert.equal(development("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
  assert.equal(development("http://fleet.internal:4100"), "http://fleet.internal:4100");

  // Embedded credentials, query strings, fragments and malformed URLs are refused.
  assert.throws(() => production("https://user:pass@fleet.example.com"), /must not embed credentials/);
  assert.throws(() => production("https://fleet.example.com?token=abc"), /must not contain a query string/);
  assert.throws(() => production("https://fleet.example.com#frag"), /must not contain a fragment/);
  assert.throws(() => production("fleet.example.com"), /must be an absolute URL/);
  assert.throws(() => production("ftp://fleet.example.com"), /must use http or https/);
  assert.throws(() => production(""), /FLEET_API_BASE_URL is required/);

  // Production configuration is enforced through fleetConsoleConfig itself.
  const base = {
    FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN,
    FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET,
    NODE_ENV: "production",
    FLEET_CONSOLE_PUBLIC_URL: "https://console.example.com",
  };
  assert.equal(fleetConsoleConfig({ ...base, FLEET_API_BASE_URL: "https://fleet.example.com" }).baseUrl, "https://fleet.example.com");
  assert.throws(() => fleetConsoleConfig({ ...base, FLEET_API_BASE_URL: "http://fleet.example.com" }), /must use https in production/);
  assert.throws(() => fleetConsoleConfig({ ...base, FLEET_API_BASE_URL: "http://10.0.0.10:4100" }), /must use https in production/);
  assert.equal(fleetConsoleConfig({ ...base, FLEET_API_BASE_URL: "http://127.0.0.1:4100" }).baseUrl, "http://127.0.0.1:4100");
  assert.equal(
    fleetConsoleConfig({ ...base, NODE_ENV: "development", FLEET_API_BASE_URL: "http://fleet.internal:4100" }).baseUrl,
    "http://fleet.internal:4100",
  );
});

test("the bearer credential is sent only on the server-side hop and never returned", async () => {
  const seen: { url: string; authorization: string | undefined }[] = [];
  const client = createFleetClient({
    baseUrl: parseFleetApiBaseUrl("https://fleet.example.com/fleet-api", true),
    operatorToken: OPERATOR_TOKEN,
    timeoutMs: 50,
    fetchImpl: (async (url: any, init: any) => {
      seen.push({ url: String(url), authorization: init.headers?.authorization });
      return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
    }) as any,
  });
  await client.listDeployments();
  // The prefix is honoured so read endpoints resolve beneath the configured base.
  assert.equal(seen[0].url, "https://fleet.example.com/fleet-api/deployments");
  assert.equal(seen[0].authorization, `Bearer ${OPERATOR_TOKEN}`, "the bearer travels on the outbound server-side request");
  // A console page never carries the bearer to the browser.
  const page = await get("/deployments");
  assert.ok(!/Bearer\s/.test(page.body), "no bearer token is rendered into a page");
  assert.ok(!page.body.includes(OPERATOR_TOKEN));
});

test("malformed cookie input cannot turn an unauthenticated request into a server error", async () => {
  // Invalid percent-encoding in the console cookie is ignored, not fatal.
  for (const bad of ["fleet_console_session=%E0%A4%A", "fleet_console_session=%", "fleet_console_session=%ZZ", "=nokey", "fleet_console_session"]) {
    const response = await app.inject({ method: "GET", url: "/", headers: { cookie: bad } });
    assert.equal(response.statusCode, 303, `cookie ${bad} must be ignored rather than erroring`);
    assert.equal(response.headers.location, "/login");
  }
  // A malformed cookie alongside a valid session does not break authentication.
  const mixed = await app.inject({ method: "GET", url: "/", headers: { cookie: `other=%E0%A4%A; ${sessionCookie}` } });
  assert.equal(mixed.statusCode, 200, "a valid session still works when another cookie is malformed");
  assert.match(mixed.body, /Fleet overview/);
  // And an outright hostile cookie header is still bounded.
  const hostile = await app.inject({ method: "GET", url: "/", headers: { cookie: "%E0%A4%A; ; ;=;%ZZ" } });
  assert.equal(hostile.statusCode, 303);
});

// ---------------------------------------------------------------------------
// Review pass 3 findings
// ---------------------------------------------------------------------------
const PRODUCTION_SECRETS = { FLEET_OPERATOR_TOKEN: OPERATOR_TOKEN, FLEET_CONSOLE_SESSION_SECRET: SESSION_SECRET };

test("one production boolean drives transport, cookies and the browser-facing contract", () => {
  // Either mechanism, independently, means production. There is no second interpretation.
  assert.equal(isProductionMode({ NODE_ENV: "production" }), true);
  assert.equal(isProductionMode({ FLEET_CONSOLE_PRODUCTION: "true" }), true);
  assert.equal(isProductionMode({ FLEET_CONSOLE_PRODUCTION: "TRUE" }), true);
  assert.equal(isProductionMode({ NODE_ENV: "development" }), false);
  assert.equal(isProductionMode({}), false);

  for (const env of [{ NODE_ENV: "production" }, { FLEET_CONSOLE_PRODUCTION: "true" }]) {
    const config = fleetConsoleConfig({
      ...PRODUCTION_SECRETS,
      ...env,
      FLEET_API_BASE_URL: "https://fleet.example.com",
      FLEET_CONSOLE_PUBLIC_URL: "https://console.example.com",
    });
    assert.equal(config.production, true, `${JSON.stringify(env)} is production`);
    // Secure cookie, through either mechanism.
    assert.equal(config.secureCookie, true, `${JSON.stringify(env)} yields a Secure cookie`);
    // Production API transport rules apply.
    assert.throws(
      () => fleetConsoleConfig({ ...PRODUCTION_SECRETS, ...env, FLEET_API_BASE_URL: "http://fleet.example.com", FLEET_CONSOLE_PUBLIC_URL: "https://console.example.com" }),
      /must use https in production/,
      `${JSON.stringify(env)} enforces https for the fleet API`,
    );
    // Secure public-origin requirement applies.
    assert.throws(
      () => fleetConsoleConfig({ ...PRODUCTION_SECRETS, ...env, FLEET_API_BASE_URL: "https://fleet.example.com" }),
      /FLEET_CONSOLE_PUBLIC_URL is required in production/,
      `${JSON.stringify(env)} requires the public origin`,
    );
    assert.throws(
      () => fleetConsoleConfig({ ...PRODUCTION_SECRETS, ...env, FLEET_API_BASE_URL: "https://fleet.example.com", FLEET_CONSOLE_PUBLIC_URL: "http://console.example.com" }),
      /must use https in production/,
      `${JSON.stringify(env)} requires an https public origin`,
    );
  }
  // Outside production the public origin is optional and HTTP remains usable locally.
  const development = fleetConsoleConfig({
    ...PRODUCTION_SECRETS,
    NODE_ENV: "development",
    FLEET_API_BASE_URL: "http://127.0.0.1:4100",
  });
  assert.equal(development.production, false);
  assert.equal(development.secureCookie, false);
  assert.equal(development.publicUrl, null);
  assert.equal(development.host, "127.0.0.1", "the default bind is loopback");
  // The explicit Secure-cookie setting can add protection outside production, never remove it.
  assert.equal(fleetConsoleConfig({ ...PRODUCTION_SECRETS, FLEET_CONSOLE_SECURE_COOKIE: "true", FLEET_API_BASE_URL: "http://127.0.0.1:4100" }).secureCookie, true);
});

test("the browser-facing public origin must be a clean HTTPS origin in production", () => {
  assert.equal(parseConsolePublicUrl("https://fleet-console.example.com", true), "https://fleet-console.example.com");
  // A trailing root slash is normalized away.
  assert.equal(parseConsolePublicUrl("https://fleet-console.example.com/", true), "https://fleet-console.example.com");
  // A custom HTTPS port is preserved.
  assert.equal(parseConsolePublicUrl("https://fleet-console.example.com:8443", true), "https://fleet-console.example.com:8443");
  assert.equal(parseConsolePublicUrl("https://fleet-console.example.com:8443/", true), "https://fleet-console.example.com:8443");
  // Sub-path mounting is refused rather than accepted and then broken: the 1.0 console is
  // published at the origin root and is not prefix-aware.
  for (const prefixed of ["https://fleet-console.example.com/console", "https://fleet-console.example.com/console/", "https://host/fleet/"]) {
    assert.throws(
      () => parseConsolePublicUrl(prefixed, true),
      /must not contain a path; deploy the 1\.0 console at the origin root/,
      `${prefixed} must be refused`,
    );
    assert.throws(() => parseConsolePublicUrl(prefixed, false), /must not contain a path/, `${prefixed} is refused outside production too`);
  }
  assert.throws(() => parseConsolePublicUrl("http://fleet-console.example.com", true), /must use https in production/);
  assert.throws(() => parseConsolePublicUrl("https://user:pass@fleet-console.example.com", true), /must not embed credentials/);
  assert.throws(() => parseConsolePublicUrl("https://fleet-console.example.com?a=b", true), /must not contain a query string/);
  assert.throws(() => parseConsolePublicUrl("https://fleet-console.example.com#f", true), /must not contain a fragment/);
  assert.throws(() => parseConsolePublicUrl("not a url", true), /must be an absolute URL/);
  assert.throws(() => parseConsolePublicUrl("ftp://fleet-console.example.com", true), /must use http or https/);
  assert.throws(() => parseConsolePublicUrl("", true), /FLEET_CONSOLE_PUBLIC_URL is required in production/);
  // Development may remain on local HTTP, and may omit the setting entirely.
  assert.equal(parseConsolePublicUrl("http://localhost:4200", false), "http://localhost:4200");
  assert.equal(parseConsolePublicUrl(undefined, false), null);
});

test("the production bind stays loopback so plaintext exposure is not possible", () => {
  assert.equal(parseConsoleHost(undefined, true), "127.0.0.1");
  assert.equal(parseConsoleHost(undefined, false), "127.0.0.1");
  for (const loopback of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
    assert.equal(parseConsoleHost(loopback, true), loopback, `${loopback} is an acceptable production bind`);
  }
  for (const exposed of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.10", "fleet-console.internal"]) {
    assert.throws(() => parseConsoleHost(exposed, true), /must be a loopback address in production/, `${exposed} must be refused in production`);
  }
  // Non-production local and development binds remain usable.
  assert.equal(parseConsoleHost("0.0.0.0", false), "0.0.0.0");
  assert.equal(parseConsoleHost("127.0.0.1", false), "127.0.0.1");
  // Production configuration enforces the same rule end to end.
  for (const env of [{ NODE_ENV: "production" }, { FLEET_CONSOLE_PRODUCTION: "true" }]) {
    const base = { ...PRODUCTION_SECRETS, ...env, FLEET_API_BASE_URL: "https://fleet.example.com", FLEET_CONSOLE_PUBLIC_URL: "https://console.example.com" };
    assert.equal(fleetConsoleConfig({ ...base, FLEET_CONSOLE_HOST: "127.0.0.1" }).host, "127.0.0.1");
    assert.throws(() => fleetConsoleConfig({ ...base, FLEET_CONSOLE_HOST: "0.0.0.0" }), /must be a loopback address in production/);
  }
  assert.equal(
    fleetConsoleConfig({ ...PRODUCTION_SECRETS, NODE_ENV: "development", FLEET_API_BASE_URL: "http://127.0.0.1:4100", FLEET_CONSOLE_HOST: "0.0.0.0" }).host,
    "0.0.0.0",
  );
});

test("production mode through either indicator yields a Secure session cookie with no credential", async () => {
  for (const env of [{ NODE_ENV: "production" }, { FLEET_CONSOLE_PRODUCTION: "true" }]) {
    const productionConfig = fleetConsoleConfig({
      ...PRODUCTION_SECRETS,
      ...env,
      FLEET_API_BASE_URL: "https://fleet.example.com",
      FLEET_CONSOLE_PUBLIC_URL: "https://console.example.com",
      FLEET_CONSOLE_HOST: "127.0.0.1",
    });
    const productionApp = buildFleetConsole(productionConfig, {
      client: stubClient(),
      verifier: async (token: string) => (token === OPERATOR_TOKEN ? { ok: true } : { ok: false, error: "unauthorized" }),
    });
    const response = await productionApp.inject({
      method: "POST",
      url: "/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(OPERATOR_TOKEN)}`,
    });
    const setCookie = String(response.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/, `${JSON.stringify(env)}: HttpOnly`);
    assert.match(setCookie, /SameSite=Lax/, `${JSON.stringify(env)}: SameSite=Lax`);
    assert.match(setCookie, /; Secure/, `${JSON.stringify(env)}: Secure`);
    assert.ok(!setCookie.includes(OPERATOR_TOKEN), `${JSON.stringify(env)}: no credential in the cookie`);
    await productionApp.close();
  }
});
