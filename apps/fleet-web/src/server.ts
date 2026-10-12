// OCP-2B: the OpenJM fleet console server.
//
// A standalone, read-only OpenJM operator console. It is a separate application from
// the customer Workspace app (apps/web) and shares no runtime with it. It is a BFF: the
// browser talks only to this server, and this server talks to the accepted OCP-2A read
// APIs using a server-side operator credential that never reaches the browser. The
// console ships no client-side JavaScript at all, and its content security policy
// forbids scripts, so there is no client bundle for a secret to leak into.

import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createFleetClient,
  fleetConsoleConfig,
  type FleetClient,
  type FleetConsoleConfig,
} from "./fleet-api.ts";
import {
  FLEET_SESSION_COOKIE,
  issueSession,
  readSession,
  sessionCookieOptions,
} from "./session.ts";
import {
  layout,
  renderAlerts,
  renderAudit,
  renderDetail,
  renderInventory,
  renderLogin,
  renderNotFound,
  renderOverview,
  renderServiceError,
  type NavKey,
} from "./render.ts";

const CONSOLE_CSS = readFileSync(new URL("./console.css", import.meta.url), "utf8");

// Every route this console exposes. Deliberately read-only: there is no route that
// registers a deployment, issues, rotates or revokes a credential, mutates a lifecycle
// state, ingests telemetry, or performs any remote action.
export const FLEET_CONSOLE_ROUTES = [
  "GET /login",
  "POST /login",
  "POST /logout",
  "GET /",
  "GET /deployments",
  "GET /deployments/:id",
  "GET /alerts",
  "GET /audit",
  "GET /assets/console.css",
] as const;

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

export function buildFleetConsole(
  config: FleetConsoleConfig,
  dependencies?: {
    client?: FleetClient;
    // Verifies a submitted bootstrap credential server-side. Production always uses the
    // real OCP-2A check; injecting it keeps the sign-in path deterministically testable.
    verifier?: (token: string) => Promise<{ ok: true } | { ok: false; error: "unauthorized" | "unreachable" | "timeout" | "server_error" }>;
  },
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8_192 });
  const client = dependencies?.client ?? createFleetClient({
    baseUrl: config.baseUrl,
    operatorToken: config.operatorToken,
    timeoutMs: config.requestTimeoutMs,
  });

  // Form submissions from the sign-in page. No other body type is accepted.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      const params = new URLSearchParams(String(body));
      done(null, Object.fromEntries(params.entries()));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // Security headers: no scripts at all, no framing, no referrer leakage.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    return payload;
  });

  const session = (request: any) => readSession(parseCookies(request.headers.cookie)[FLEET_SESSION_COOKIE], config.sessionSecret);

  const page = (reply: any, request: any, status: number, nav: NavKey, title: string, body: string, refreshedAt: string | null = null, serviceNotice: string | null = null) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    reply.code(status).type("text/html; charset=utf-8").send(layout({ title, nav, body, refreshedAt, serviceNotice }));
  };

  app.get("/login", async (request, reply) => {
    if (session(request)) {
      reply.code(303).header("location", "/").send("");
      return;
    }
    reply.type("text/html; charset=utf-8").send(layout({ title: "Sign in", nav: "overview", body: renderLogin() }));
  });

  app.post("/login", async (request, reply) => {
    const submitted = String((request.body as any)?.token ?? "");
    if (!submitted) {
      reply.code(400).type("text/html; charset=utf-8").send(layout({ title: "Sign in", nav: "overview", body: renderLogin("Enter the fleet operator credential.") }));
      return;
    }
    // The credential is verified server-side against an authenticated OCP-2A read
    // endpoint. It is never echoed, logged or stored in the browser.
    const check = await (dependencies?.verifier
      ? dependencies.verifier(submitted)
      : createFleetClient({ baseUrl: config.baseUrl, operatorToken: submitted, timeoutMs: config.requestTimeoutMs }).listDeployments());
    if (!check.ok) {
      const message =
        check.error === "unauthorized"
          ? "That fleet operator credential was not accepted."
          : "The fleet API could not verify the credential right now. Try again shortly.";
      reply
        .code(check.error === "unauthorized" ? 401 : 503)
        .type("text/html; charset=utf-8")
        .send(layout({ title: "Sign in", nav: "overview", body: renderLogin(message) }));
      return;
    }
    const { cookieValue } = issueSession(config.sessionSecret, config.sessionTtlMs);
    const options = sessionCookieOptions(config);
    reply
      .header(
        "set-cookie",
        `${FLEET_SESSION_COOKIE}=${encodeURIComponent(cookieValue)}; Max-Age=${options.maxAge}; Path=${options.path}; HttpOnly; SameSite=Lax${
          options.secure ? "; Secure" : ""
        }`,
      )
      .code(303)
      .header("location", "/")
      .send("");
  });

  app.post("/logout", async (_request, reply) => {
    // Clearing the cookie destroys the session; the cookie holds only a random session
    // id, so nothing else needs revoking.
    reply
      .header("set-cookie", `${FLEET_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${config.secureCookie ? "; Secure" : ""}`)
      .code(303)
      .header("location", "/login")
      .send("");
  });

  app.get("/", async (request, reply) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    const [deployments, alerts] = await Promise.all([client.listDeployments(), client.alerts()]);
    if (!deployments.ok) {
      page(reply, request, 200, "overview", "Fleet overview", renderServiceError(deployments.error, "overview"), null, null);
      return;
    }
    const alertData = alerts.ok ? alerts.data.alerts : [];
    page(
      reply,
      request,
      200,
      "overview",
      "Fleet overview",
      renderOverview(deployments.data.deployments, alertData),
      new Date().toISOString(),
      alerts.ok ? null : "Fleet alerts are unavailable right now; deployment counts are unaffected.",
    );
  });

  app.get("/deployments", async (request, reply) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    const query = (request.query ?? {}) as any;
    const filters = {
      q: typeof query.q === "string" ? query.q.slice(0, 128) : "",
      onlineState: typeof query.online_state === "string" ? query.online_state.slice(0, 32) : "",
      lifecycle: typeof query.lifecycle === "string" ? query.lifecycle.slice(0, 32) : "",
      alerting: query.alerting === "1",
    };
    const [deployments, alerts] = await Promise.all([client.listDeployments(), client.alerts()]);
    if (!deployments.ok) {
      page(reply, request, 200, "deployments", "Deployments", renderServiceError(deployments.error, "deployments"));
      return;
    }
    page(
      reply,
      request,
      200,
      "deployments",
      "Deployments",
      renderInventory(deployments.data.deployments, filters, alerts.ok ? alerts.data.alerts : []),
      new Date().toISOString(),
      alerts.ok ? null : "Alert state is unavailable right now, so the alerting filter may under-report.",
    );
  });

  app.get("/deployments/:id", async (request, reply) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    const id = String((request.params as any).id ?? "").slice(0, 128);
    const detail = await client.deployment(id);
    if (!detail.ok) {
      if (detail.error === "unauthorized" || detail.error === "unreachable" || detail.error === "timeout" || detail.error === "server_error") {
        // A 404 from the fleet API arrives as server_error with status 404; anything else
        // is a bounded console service state.
        if (detail.status === 404) {
          page(reply, request, 404, "deployments", "Deployment not found", renderNotFound("deployment"));
          return;
        }
        page(reply, request, 200, "deployments", "Fleet API unavailable", renderServiceError(detail.error, "deployments"));
        return;
      }
    }
    page(reply, request, 200, "deployments", "Deployment", renderDetail((detail as any).data), new Date().toISOString());
  });

  app.get("/alerts", async (request, reply) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    const query = (request.query ?? {}) as any;
    const filters = {
      severity: typeof query.severity === "string" ? query.severity.slice(0, 16) : "",
      category: typeof query.category === "string" ? query.category.slice(0, 64) : "",
      deployment: typeof query.deployment === "string" ? query.deployment.slice(0, 128) : "",
    };
    const [alerts, deployments] = await Promise.all([client.alerts(), client.listDeployments()]);
    if (!alerts.ok) {
      page(reply, request, 200, "alerts", "Fleet alerts", renderServiceError(alerts.error, "alerts"));
      return;
    }
    page(
      reply,
      request,
      200,
      "alerts",
      "Fleet alerts",
      renderAlerts(alerts.data.alerts, deployments.ok ? deployments.data.deployments : [], filters),
      new Date().toISOString(),
    );
  });

  app.get("/audit", async (request, reply) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    const [audit, deployments] = await Promise.all([client.audit(), client.listDeployments()]);
    if (!audit.ok) {
      page(reply, request, 200, "audit", "Operator audit", renderServiceError(audit.error, "audit"));
      return;
    }
    page(
      reply,
      request,
      200,
      "audit",
      "Operator audit",
      renderAudit(audit.data.audit, deployments.ok ? deployments.data.deployments : []),
      new Date().toISOString(),
    );
  });

  // The only static asset, served from disk. No client-side script is served at all.
  app.get("/assets/console.css", async (_request, reply) => {
    reply.type("text/css; charset=utf-8").send(CONSOLE_CSS);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (!session(request)) {
      reply.code(303).header("location", "/login").send("");
      return;
    }
    reply.code(404).type("text/html; charset=utf-8").send(layout({ title: "Not found", nav: "overview", body: renderNotFound("surface") }));
  });

  return app;
}

export { fleetConsoleConfig };
