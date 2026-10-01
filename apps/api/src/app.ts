import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { integrationOpenApi } from "../../../packages/contracts/openapi.ts";
import { stringify } from "csv-stringify/sync";
import { Database, one, type Query } from "../../../packages/database/index.ts";
import { oidcFromEnv, type OidcProvider } from "../../../packages/auth/oidc.ts";
import { sealTenantOidcSecret, validateTenantOidcRegistration } from "../../../packages/auth/tenant-provider.ts";
import {
  authenticate,
  admin,
  scope,
  csrf,
  equal,
  passwordHash,
  verifyPassword,
  createSession,
  hash,
  token,
  scopes,
  issueTicket,
  type Actor,
} from "../../../packages/auth/index.ts";
import {
  assert,
  HttpError,
  uuid,
  title,
  roles,
  json,
  textOf,
  properties,
  view,
  validateValues,
} from "../../../packages/contracts/index.ts";
import {
  requireAccess,
  access,
  visible,
  ancestry,
} from "../../../packages/permissions/index.ts";
import {
  defaultBranding,
  brandingSchema,
} from "../../../packages/branding/index.ts";
import { emit, encrypt } from "../../../packages/events/index.ts";
import {
  templates,
  blocksToMarkdown,
} from "../../../packages/editor/server.ts";
import {
  createStorage,
  inspectFile,
  type Storage,
} from "../../../packages/storage/index.ts";
import {
  HttpMetrics,
  fetchHealth,
  renderPrometheusMetrics,
  type MetricsSnapshot,
} from "../../../packages/operations/metrics.ts";
import {
  AntivirusUnavailableError,
  createAntivirus,
  type Antivirus,
} from "../../../packages/security/antivirus.ts";
import {
  registerScim,
  setScimGroupRoleMapping,
} from "./scim.ts";
import {
  createResource,
  createRecord,
  records,
  replaceDocument,
  validatePeople,
  treeLock,
  seedDemo,
  purgeDeletedResource,
} from "./domain.ts";
type Request = FastifyRequest & { actor: Actor; sessionToken: string };
type Handler = (
  q: Query,
  a: Actor,
  r: Request,
  reply: FastifyReply,
) => Promise<any>;
type Route = (
  m: "GET" | "POST" | "PATCH" | "DELETE",
  p: string,
  summary: string,
  h: Handler,
  s?: string,
) => void;
const body = <T>(s: z.ZodType<T>, r: FastifyRequest) => s.parse(r.body),
  params = (r: FastifyRequest) => r.params as Record<string, string>,
  query = (r: FastifyRequest) => r.query as Record<string, string>,
  id = (r: FastifyRequest, k = "id") => uuid.parse(params(r)[k]);
const pageScope = (k: string, w = false) =>
  (["database", "record"].includes(k)
    ? "databases"
    : ["workspace", "space"].includes(k)
      ? "workspace"
      : "pages") + (w ? ".write" : ".read");
const cookies = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE !== "false",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 43200,
});
const oidcCookies = () => ({
  ...cookies(),
  path: "/api/v1/auth/oidc",
  maxAge: 600,
});
const safeReturnTo = (value: unknown) => {
  const path = typeof value === "string" ? value : "/";
  return path.startsWith("/") && !path.startsWith("//") && path.length <= 1000
    ? path
    : "/";
};
export async function buildApp(
  db: Database,
  storage: Storage = createStorage(),
  logging = true,
  oidc: OidcProvider | null = oidcFromEnv(),
  antivirus: Antivirus = createAntivirus(),
) {
  assert(
    /^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY || ""),
    500,
    "Set ENCRYPTION_KEY to 64 hexadecimal characters",
  );
  const dummyPasswordHash = await passwordHash("dummy-password-constant"),
    localAuth = process.env.LOCAL_AUTH_ENABLED !== "false",
    allowOrganisationCreation =
      process.env.ALLOW_SELF_SERVICE_ORGANISATIONS === "true",
    metricsToken = process.env.METRICS_BEARER_TOKEN?.trim() || "",
    appUrl = process.env.APP_URL || "http://localhost:3000",
    oidcRedirectUri = new URL("/api/v1/auth/oidc/callback", appUrl).href,
    metricsStartedAt = Date.now(),
    httpMetrics = new HttpMetrics(),
    antivirusMetrics = { clean: 0, infected: 0, error: 0 },
    requestStarted = new WeakMap<FastifyRequest, bigint>();
  assert(
    !metricsToken || metricsToken.length >= 32,
    500,
    "METRICS_BEARER_TOKEN must contain at least 32 characters",
  );
  const healthTarget = (name: "COLLAB" | "WORKER") => {
    const value = process.env[`METRICS_${name}_HEALTH_URL`]?.trim();
    if (!value) return "";
    const url = new URL(value);
    assert(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password,
      500,
      `METRICS_${name}_HEALTH_URL must be an HTTP(S) URL without credentials`,
    );
    return url.href;
  };
  const collabHealthUrl = healthTarget("COLLAB"),
    workerHealthUrl = healthTarget("WORKER");
  const app = Fastify({
    logger: logging
      ? {
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "req.headers.x-csrf-token",
            "req.headers.x-setup-token",
          ],
        }
      : false,
    bodyLimit: 6291456,
    trustProxy: process.env.TRUST_PROXY === "true",
    requestIdHeader: false,
  });
  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
    : undefined;
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    ...(redis ? { redis } : {}),
  });
  await app.register(multipart, { limits: { fileSize: 26214400, files: 1 } });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 20000 },
    (_request, payload, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(payload))));
      } catch (error) {
        done(error as Error);
      }
    },
  );
  await app.register(swagger, {
    openapi: {
      info: { title: "Workspace API", version: "1.0.0" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "workspace_session" },
          serviceToken: { type: "http", scheme: "bearer" },
        },
      },
    },
  });
  await app.register(swaggerUI, { routePrefix: "/api/docs" });
  app.setErrorHandler((e: any, r, reply) => {
    const status =
      e instanceof z.ZodError
        ? 400
        : e.statusCode || (["23505", "23503"].includes(e.code) ? 409 : 500);
    if (status >= 500) r.log.error({ err: e }, "Request failed");
    reply.code(status).send({
      error:
        status >= 500
          ? "Internal error"
          : e instanceof z.ZodError
            ? e.issues
                .map((i: any) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")
            : e.message,
      request_id: r.id,
    });
  });
  app.addHook("onRequest", async (r, reply) => {
    requestStarted.set(r, process.hrtime.bigint());
    reply.header("X-Request-Id", r.id);
    reply.header("Cache-Control", "no-store");
  });
  app.addHook("onResponse", async (r, reply) => {
    const started = requestStarted.get(r);
    if (!started) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    httpMetrics.record(r.method, reply.statusCode, durationMs);
    requestStarted.delete(r);
  });
  const auth = async (req: FastifyRequest) => {
    const r = req as Request,
      header = r.headers.authorization;
    r.sessionToken = header?.startsWith("Bearer ")
      ? header.slice(7)
      : r.cookies.workspace_session || "";
    r.actor = await authenticate(db, r.sessionToken);
    r.actor.requestId = r.id;
    assert(
      header ? !!r.actor.scopes : !r.actor.scopes,
      401,
      "Credential transport mismatch",
    );
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method) && !header) {
      assert(
        equal(String(r.headers["x-csrf-token"] || ""), csrf(r.sessionToken)),
        403,
        "Invalid CSRF token",
      );
      assert(
        !r.headers.origin ||
          r.headers.origin === (process.env.APP_URL || "http://localhost:3000"),
        403,
        "Origin not allowed",
      );
    }
  };
  const route: Route = (method, p, summary, h, s) =>
    app.route({
      method,
      url: `/api/v1${p}`,
      schema: {
        summary,
        tags: [p.split("/")[1]],
        security: [{ session: [] }, { serviceToken: [] }],
        ...(integrationOpenApi[`${method} ${p}`] || {}),
      },
      preHandler: auth,
      handler: async (req, reply) => {
        const r = req as Request;
        if (s) scope(r.actor, s);
        return db.tenant(r.actor.tenant_id, (q) => h(q, r.actor, r, reply));
      },
    });
  const dependencyReadiness = async () => {
    const dependencies: Record<string, boolean> = {
      database: false,
      storage: false,
    };
    if (redis) dependencies.redis = false;
    if (antivirus.enabled) dependencies.antivirus = false;
    try {
      await db.system((q) => q.query("SELECT 1"));
      dependencies.database = true;
    } catch {
      /* Report through readiness/metrics without leaking the database error. */
    }
    if (redis)
      try {
        await redis.ping();
        dependencies.redis = true;
      } catch {
        /* Report through readiness/metrics without leaking the Redis error. */
      }
    try {
      await storage.health();
      dependencies.storage = true;
    } catch {
      /* Report through readiness/metrics without leaking the storage error. */
    }
    if (antivirus.enabled)
      try {
        await antivirus.health();
        dependencies.antivirus = true;
      } catch {
        /* Required malware scanning is part of production readiness. */
      }
    return dependencies;
  };
  const serviceMetrics = async (
    service: "collaboration" | "worker",
    url: string,
  ): Promise<MetricsSnapshot["services"][string]> => {
    if (!url) return { configured: false as const };
    const health = await fetchHealth(url);
    if (service === "collaboration")
      return {
        configured: true as const,
        healthy: health.healthy,
        values: {
          documents: Number(health.documents) || 0,
          connections: Number(health.connections) || 0,
          loading_documents: Number(health.loading_documents) || 0,
        },
      };
    const completed = health.last_completed_at
      ? Date.parse(String(health.last_completed_at))
      : NaN;
    return {
      configured: true as const,
      healthy: health.healthy,
      values: {
        running: health.running === true ? 1 : 0,
        running_seconds: Math.max(0, Number(health.running_for_ms) || 0) / 1000,
        consecutive_failures: Math.max(
          0,
          Number(health.consecutive_failures) || 0,
        ),
        last_completed_age_seconds: Number.isFinite(completed)
          ? Math.max(0, (Date.now() - completed) / 1000)
          : null,
      },
    };
  };
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_r, reply) => {
    const dependencies = await dependencyReadiness();
    if (!Object.values(dependencies).every(Boolean)) reply.code(503);
    return {
      status: Object.values(dependencies).every(Boolean)
        ? "ready"
        : "unavailable",
    };
  });
  app.get(
    "/metrics",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      logLevel: "warn",
    },
    async (r, reply) => {
      if (!metricsToken) {
        reply.code(404);
        return { error: "Not found" };
      }
      const authorization = String(r.headers.authorization || "");
      const supplied = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      if (!supplied || !equal(supplied, metricsToken)) {
        reply.header("WWW-Authenticate", "Bearer");
        reply.code(401);
        return { error: "Metrics credential required" };
      }
      const [dependencies, collaboration, worker] = await Promise.all([
        dependencyReadiness(),
        serviceMetrics("collaboration", collabHealthUrl),
        serviceMetrics("worker", workerHealthUrl),
      ]);
      reply.type("text/plain; version=0.0.4; charset=utf-8");
      return renderPrometheusMetrics({
        startedAt: metricsStartedAt,
        dependencies,
        services: {
          api: { configured: true, healthy: true },
          collaboration,
          worker,
        },
        http: httpMetrics.snapshot(),
        antivirus: antivirusMetrics,
      });
    },
  );
  app.get("/api/v1/branding", async () => defaultBranding());
  app.get("/api/v1/auth/methods", async () => ({
    local: localAuth,
    oidc: oidc ? { enabled: true, label: oidc.label } : { enabled: false },
  }));
  app.post(
    "/api/v1/auth/oidc/backchannel-logout",
    {
      config: { rateLimit: { max: 120, timeWindow: "5 minutes" } },
      logLevel: "warn",
    },
    async (r, reply) => {
      assert(oidc, 404, "OIDC sign-in is not configured");
      const v = body(
          z
            .object({ logout_token: z.string().min(20).max(16384) })
            .passthrough(),
          r,
        ),
        logout = await oidc.validateBackchannelLogout(v.logout_token),
        result = await db.systemTransaction(async (q) => {
          await q.query(
            "DELETE FROM oidc_logout_events WHERE expires_at<=now()",
          );
          const accepted = await one(
            q,
            "INSERT INTO oidc_logout_events(issuer,jti,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING jti",
            [logout.issuer, logout.jti, logout.expiresAt],
          );
          if (!accepted) return { revoked: 0, replayed: true };

          const deleted = logout.sid
            ? (
                await q.query(
                  `DELETE FROM sessions
                   WHERE oidc_issuer=$1 AND oidc_sid=$2
                     AND ($3::text IS NULL OR oidc_subject=$3)
                   RETURNING tenant_id,user_id`,
                  [logout.issuer, logout.sid, logout.subject || null],
                )
              ).rows
            : (
                await q.query(
                  "DELETE FROM sessions WHERE oidc_issuer=$1 AND oidc_subject=$2 RETURNING tenant_id,user_id",
                  [logout.issuer, logout.subject],
                )
              ).rows;

          const tenants = new Map<string, string>();
          for (const row of deleted)
            if (!tenants.has(row.tenant_id))
              tenants.set(row.tenant_id, row.user_id);
          for (const [tenantId] of tenants) {
            await q.query("SELECT set_config('app.tenant_id',$1,true)", [
              tenantId,
            ]);
            await q.query(
              "INSERT INTO audit_events(id,tenant_id,actor_id,action,request_id) VALUES($1,$2,NULL,'auth.oidc_backchannel_logout',$3)",
              [randomUUID(), tenantId, r.id],
            );
          }
          return { revoked: deleted.length, replayed: false };
        });

      reply.code(200);
      return { ok: true, ...result };
    },
  );
  app.get(
    "/api/v1/auth/oidc/start",
    {
      config: { rateLimit: { max: 20, timeWindow: "5 minutes" } },
      logLevel: "warn",
    },
    async (r, reply) => {
      assert(oidc, 404, "OIDC sign-in is not configured");
      const p = query(r),
        invite = p.invite
          ? z.string().min(20).max(200).parse(p.invite)
          : undefined,
        started = await oidc.start(oidcRedirectUri);
      await db.systemTransaction(async (q) => {
        await q.query("DELETE FROM oidc_login_states WHERE expires_at<=now()");
        await q.query(
          "INSERT INTO oidc_login_states(state_hash,code_verifier,nonce,invite_token_hash,return_to) VALUES($1,$2,$3,$4,$5)",
          [
            hash(started.state),
            started.codeVerifier,
            started.nonce,
            invite ? hash(invite) : null,
            safeReturnTo(p.return_to),
          ],
        );
      });
      reply.setCookie("workspace_oidc_state", started.state, oidcCookies());
      return reply.redirect(started.url);
    },
  );
  app.get(
    "/api/v1/auth/oidc/callback",
    {
      config: { rateLimit: { max: 30, timeWindow: "5 minutes" } },
      logLevel: "warn",
    },
    async (r, reply) => {
      assert(oidc, 404, "OIDC sign-in is not configured");
      const state = z.string().min(20).max(500).parse(query(r).state),
        browserState = r.cookies.workspace_oidc_state || "";
      assert(
        browserState && equal(browserState, state),
        400,
        "OIDC browser state mismatch",
      );
      reply.clearCookie("workspace_oidc_state", {
        path: "/api/v1/auth/oidc",
      });
      const pending = await db.system((q) =>
        one(
          q,
          "DELETE FROM oidc_login_states WHERE state_hash=$1 AND expires_at>now() RETURNING *",
          [hash(state)],
        ),
      );
      assert(pending, 400, "OIDC login state expired or already used");

      const profile = await oidc.finish(new URL(r.url, appUrl), {
          state,
          codeVerifier: pending.code_verifier,
          nonce: pending.nonce,
        }),
        sessionToken = await db.systemTransaction(async (q) => {
          let identity = await one(
              q,
              "SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2",
              [profile.issuer, profile.subject],
            ),
            user = identity
              ? await one(
                  q,
                  "SELECT id,email,is_service FROM users WHERE id=$1",
                  [identity.user_id],
                )
              : await one(
                  q,
                  "SELECT id,email,is_service FROM users WHERE email=$1",
                  [profile.email],
                ),
            invitation = pending.invite_token_hash
              ? await one(q, "SELECT * FROM invitation_context($1)", [
                  pending.invite_token_hash,
                ])
              : null;

          if (pending.invite_token_hash) {
            assert(invitation, 400, "Invitation invalid or expired");
            assert(
              invitation.email === profile.email,
              403,
              "SSO email does not match the invitation",
            );
          }

          if (!user) {
            assert(
              invitation,
              403,
              "SSO account has no provisioned Workspace access",
            );
            user = { id: randomUUID(), email: profile.email, is_service: false };
            await q.query(
              "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,NULL)",
              [user.id, profile.email, profile.name],
            );
          }
          assert(!user.is_service, 403, "Service principals cannot use SSO");

          if (invitation) {
            await q.query("SELECT set_config('app.tenant_id',$1,true)", [
              invitation.tenant_id,
            ]);
            const consumed = await one(
              q,
              "DELETE FROM invitations WHERE token_hash=$1 AND expires_at>now() RETURNING tenant_id,role",
              [pending.invite_token_hash],
            );
            assert(consumed, 400, "Invitation already used");
            await q.query(
              "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET active=true",
              [invitation.tenant_id, user.id, invitation.role],
            );
          }

          if (!identity) {
            await q.query(
              "INSERT INTO oidc_identities(issuer,subject,user_id,email) VALUES($1,$2,$3,$4)",
              [profile.issuer, profile.subject, user.id, profile.email],
            );
            identity = { user_id: user.id };
          }
          assert(
            identity.user_id === user.id,
            409,
            "OIDC identity is already linked to another account",
          );
          await q.query(
            "UPDATE oidc_identities SET email=$3,last_login_at=now() WHERE issuer=$1 AND subject=$2",
            [profile.issuer, profile.subject, profile.email],
          );

          const memberships = (
            await q.query("SELECT * FROM user_tenants($1)", [user.id])
          ).rows;
          assert(memberships.length, 403, "No active membership");
          const selected =
            (invitation &&
              memberships.find(
                (m: any) => m.tenant_id === invitation.tenant_id,
              )) ||
            memberships[0];

          await q.query("SELECT set_config('app.tenant_id',$1,true)", [
            selected.tenant_id,
          ]);
          await q.query(
            "INSERT INTO audit_events(id,tenant_id,actor_id,action,request_id) VALUES($1,$2,$3,$4,$5)",
            [
              randomUUID(),
              selected.tenant_id,
              user.id,
              "auth.oidc_login",
              r.id,
            ],
          );
          return createSession(q, selected.tenant_id, user.id, null, null, {
            issuer: profile.issuer,
            subject: profile.subject,
            sid: profile.sid,
          });
        });

      reply.setCookie("workspace_session", sessionToken, cookies());
      return reply.redirect(pending.return_to);
    },
  );
  app.get("/api/v1/setup", async () => ({
    required: !(
      await db.system((q) => q.query("SELECT id FROM worker_tenants() LIMIT 1"))
    ).rowCount,
  }));
  app.post(
    "/api/v1/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (r, reply) => {
      assert(
        process.env.SETUP_TOKEN &&
          equal(
            String(r.headers["x-setup-token"] || ""),
            process.env.SETUP_TOKEN,
          ),
        403,
        "Setup token required",
      );
      const v = body(
          z
            .object({
              organisation: title,
              workspace: title,
              name: title,
              email: z.email().transform((s) => s.toLowerCase()),
              password: z.string(),
              demo: z.boolean().default(true),
            })
            .strict(),
          r,
        ),
        tenant = randomUUID(),
        user = randomUUID(),
        encoded = await passwordHash(v.password);
      const t = await db.tenant(tenant, async (q) => {
        await q.query("SELECT pg_advisory_xact_lock(8831242)");
        assert(
          !(await q.query("SELECT id FROM worker_tenants() LIMIT 1")).rowCount,
          409,
          "Setup already completed",
        );
        await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
          tenant,
          v.organisation,
        ]);
        await q.query(
          "INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)",
          [user, v.name, v.email, encoded],
        );
        await q.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
          [tenant, user],
        );
        const a: Actor = {
          tenant_id: tenant,
          user_id: user,
          role: "owner",
          name: v.name,
          email: v.email,
          scopes: null,
          expires_at: new Date(Date.now() + 43200000),
        };
        const w = await createResource(q, a, {
          kind: "workspace",
          title: v.workspace,
        });
        if (v.demo) await seedDemo(q, a, w.id);
        return createSession(q, tenant, user);
      });
      reply.setCookie("workspace_session", t, cookies());
      return { ok: true, csrf: csrf(t) };
    },
  );
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (r, reply) => {
      assert(localAuth, 403, "Password sign-in is disabled");
      const v = body(
        z
          .object({
            email: z.email().transform((s) => s.toLowerCase()),
            password: z.string().max(256),
          })
          .strict(),
        r,
      );
      const u = await db.system((q) =>
        one(
          q,
          "SELECT id,password_hash FROM users WHERE email=$1 AND NOT is_service",
          [v.email],
        ),
      );
      const valid = await verifyPassword(
        v.password,
        u?.password_hash || dummyPasswordHash,
      );
      assert(u && valid, 401, "Incorrect email or password");
      const m = (
        await db.system((q) =>
          q.query("SELECT * FROM user_tenants($1)", [u.id]),
        )
      ).rows;
      assert(m.length, 401, "No active membership");
      const t = await db.tenant(m[0].tenant_id, (q) =>
        createSession(q, m[0].tenant_id, u.id),
      );
      reply.setCookie("workspace_session", t, cookies());
      return { ok: true, csrf: csrf(t) };
    },
  );
  app.post(
    "/api/v1/auth/accept-invite",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (r, reply) => {
      assert(localAuth, 403, "Password invitation acceptance is disabled");
      const v = body(
          z
            .object({
              token: z.string().min(20).max(200),
              password: z.string().min(12).max(256),
            })
            .strict(),
          r,
        ),
        invite = await db.system((q) =>
          one(q, "SELECT * FROM invitation_context($1)", [hash(v.token)]),
        );
      assert(invite, 400, "Invitation invalid or expired");
      const t = await db.tenant(invite.tenant_id, async (q) => {
        const row = await one(
          q,
          "DELETE FROM invitations WHERE token_hash=$1 AND expires_at>now() RETURNING *",
          [hash(v.token)],
        );
        assert(row, 400, "Invitation already used");
        let u = await one(q, "SELECT * FROM users WHERE email=$1", [row.email]);
        if (u)
          assert(
            !u.is_service &&
              (await verifyPassword(v.password, u.password_hash)),
            401,
            "Use the existing account password",
          );
        else {
          u = { id: randomUUID() };
          await q.query(
            "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
            [u.id, row.email, row.name, await passwordHash(v.password)],
          );
        }
        await q.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [row.tenant_id, u.id, row.role],
        );
        return createSession(q, row.tenant_id, u.id);
      });
      reply.setCookie("workspace_session", t, cookies());
      return { ok: true };
    },
  );
  route("GET", "/me", "Session and organisation", async (q, a, r) => {
    const o = await one(q, "SELECT * FROM organisations WHERE id=$1", [
      a.tenant_id,
    ]);
    return {
      user: { id: a.user_id, name: a.name, email: a.email, role: a.role },
      organisation: o,
      branding: { ...defaultBranding(), ...o.branding },
      csrf: a.scopes ? null : csrf(r.sessionToken),
      authentication: {
        local: localAuth,
        oidc: oidc ? { enabled: true, label: oidc.label } : { enabled: false },
      },
      capabilities: {
        self_service_organisation_creation: allowOrganisationCreation,
      },
      organisations: (
        await q.query("SELECT * FROM user_tenants($1)", [a.user_id])
      ).rows,
    };
  });
  route("POST", "/auth/logout", "End session", async (q, a, _r, reply) => {
    await q.query("DELETE FROM sessions WHERE token_hash=$1", [a.tokenHash]);
    reply.clearCookie("workspace_session", { path: "/" });
    return { ok: true };
  });
  route(
    "POST",
    "/auth/switch",
    "Switch organisation",
    async (q, a, r, reply) => {
      assert(!a.scopes, 403, "Human session required");
      const t = body(z.object({ tenant_id: uuid }), r).tenant_id;
      // A tenant switch must never turn an issuer-bound OIDC session into
      // a fresh, unbound local session. Lock the source to serialize against
      // concurrent logout/revocation and fail closed if already revoked.
      const source = await one(
        q,
        "SELECT oidc_issuer FROM sessions" +
          " WHERE token_hash=$1 AND tenant_id=$2 AND user_id=$3" +
          " AND scopes IS NULL AND expires_at>now() FOR UPDATE",
        [a.tokenHash, a.tenant_id, a.user_id],
      );
      assert(source, 401, "Session expired or revoked");
      assert(
        !source.oidc_issuer,
        403,
        "SSO sessions cannot switch organisations; sign in to the destination organisation",
      );
      assert(
        (
          await q.query("SELECT * FROM user_tenants($1)", [a.user_id])
        ).rows.some((m) => m.tenant_id === t),
        404,
        "Organisation not found",
      );
      await q.query("DELETE FROM sessions WHERE token_hash=$1", [a.tokenHash]);
      const s = await createSession(q, t, a.user_id);
      reply.setCookie("workspace_session", s, cookies());
      return { ok: true };
    },
  );
  route(
    "POST",
    "/auth/password",
    "Change password and revoke other sessions",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required");
      assert(localAuth, 403, "Local password authentication is disabled");
      const v = body(
          z.object({ current: z.string(), password: z.string() }),
          r,
        ),
        u = await one(q, "SELECT password_hash FROM users WHERE id=$1", [
          a.user_id,
        ]);
      assert(
        await verifyPassword(v.current, u.password_hash),
        403,
        "Current password incorrect",
      );
      await q.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
        a.user_id,
        await passwordHash(v.password),
      ]);
      await q.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
        [a.user_id, a.tokenHash],
      );
      await emit(q, a, "user.password_changed", a.user_id);
      return { ok: true };
    },
  );
  route("POST", "/organisations", "Create organisation", async (q, a, r) => {
    admin(a);
    assert(
      allowOrganisationCreation,
      403,
      "Self-service organisation creation is disabled for this deployment",
    );
    const v = body(z.object({ name: title }), r),
      t = randomUUID();
    await q.query("SELECT set_config('app.tenant_id',$1,true)", [t]);
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      t,
      v.name,
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
      [t, a.user_id],
    );
    return { id: t, name: v.name };
  });
  route(
    "GET",
    "/resources",
    "List accessible children, recent pages or favourites",
    async (q, a, r) => {
      const p = query(r),
        limit = Math.min(200, Math.max(1, Number(p.limit) || 60)),
        offset = Math.max(0, Number(p.offset) || 0);
      let rows: any[];
      if (p.recent === "true")
        rows = (
          await q.query(
            "SELECT * FROM resources WHERE deleted_at IS NULL AND kind IN ('page','record','database') ORDER BY updated_at DESC LIMIT $1 OFFSET $2",
            [limit, offset],
          )
        ).rows;
      else if (p.favourites === "true")
        rows = (
          await q.query(
            "SELECT r.* FROM resources r JOIN bookmarks b ON b.resource_id=r.id WHERE b.user_id=$1 AND b.favourite AND r.deleted_at IS NULL ORDER BY b.visited_at DESC LIMIT $2 OFFSET $3",
            [a.user_id, limit, offset],
          )
        ).rows;
      else {
        const parent = p.parent_id ? uuid.parse(p.parent_id) : null;
        if (parent) await requireAccess(q, a, parent);
        rows = (
          await q.query(
            "SELECT * FROM resources WHERE parent_id IS NOT DISTINCT FROM $1::uuid AND deleted_at IS NULL ORDER BY position,id LIMIT $2 OFFSET $3",
            [parent, limit, offset],
          )
        ).rows;
      }
      return (await visible(q, a, rows)).filter(
        (v) => !a.scopes || a.scopes.includes(pageScope(v.kind)),
      );
    },
  );
  route("POST", "/resources", "Create resource", async (q, a, r) => {
    const v = body(
      z
        .object({
          kind: z.enum(["workspace", "space", "page", "database"]),
          title,
          parent_id: uuid.nullable().optional(),
          icon: z.string().max(20).optional(),
          template: z.string().optional(),
        })
        .strict(),
      r,
    );
    scope(a, pageScope(v.kind, true));
    return createResource(q, a, {
      ...v,
      blocks: templates[v.template || ""]?.blocks || [],
      tasks: v.template === "tasks",
    });
  });
  route(
    "GET",
    "/resources/:id",
    "Read resource and breadcrumbs",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      return {
        ...n,
        path: (await ancestry(q, n.id)).map((p) => ({
          id: p.id,
          title: p.title,
          kind: p.kind,
        })),
        favourite: !!(
          await one(
            q,
            "SELECT favourite FROM bookmarks WHERE resource_id=$1 AND user_id=$2",
            [n.id, a.user_id],
          )
        )?.favourite,
      };
    },
  );
  route(
    "PATCH",
    "/resources/:id",
    "Rename, move, reorder or set icon",
    async (q, a, r) => {
      await treeLock(q, a.tenant_id);
      const n = await requireAccess(q, a, id(r), 3);
      scope(a, pageScope(n.kind, true));
      const v = body(
        z
          .object({
            title: title.optional(),
            parent_id: uuid.optional(),
            icon: z.string().max(20).optional(),
            position: z.number().finite().optional(),
          })
          .strict(),
        r,
      );
      if (v.parent_id) {
        assert(
          !["workspace", "record"].includes(n.kind),
          400,
          "This resource cannot be moved",
        );
        const p = await requireAccess(q, a, v.parent_id, 3);
        assert(
          n.kind === "space"
            ? p.kind === "workspace"
            : ["page", "space"].includes(p.kind),
          400,
          "Invalid parent",
        );
        const path = await ancestry(q, p.id);
        assert(
          !path.some((p) => p.id === n.id) && path.length < 32,
          400,
          "Invalid recursive hierarchy",
        );
      }
      assert(
        n.kind !== "record" || !v.title,
        400,
        "Rename records through their title property",
      );
      await q.query(
        "UPDATE resources SET title=coalesce($2,title),parent_id=coalesce($3,parent_id),icon=coalesce($4,icon),position=coalesce($5,position),updated_by=$6,updated_at=now() WHERE id=$1",
        [
          n.id,
          v.title ?? null,
          v.parent_id ?? null,
          v.icon ?? null,
          v.position ?? null,
          a.user_id,
        ],
      );
      await emit(q, a, `${n.kind}.updated`, n.id);
      return one(q, "SELECT * FROM resources WHERE id=$1", [n.id]);
    },
  );
  route(
    "POST",
    "/resources/:id/duplicate",
    "Duplicate a page body",
    async (q, a, r) => {
      scope(a, "pages.write");
      const n = await requireAccess(q, a, id(r));
      assert(n.kind === "page", 400, "Duplicate supports pages");
      const d = await one(
        q,
        "SELECT blocks FROM page_documents WHERE resource_id=$1",
        [n.id],
      );
      return createResource(q, a, {
        kind: "page",
        title: `${n.title} (copy)`,
        parent_id: n.parent_id,
        icon: n.icon,
        blocks: d.blocks,
      });
    },
  );
  route(
    "DELETE",
    "/resources/:id",
    "Soft-delete resource and descendants",
    async (q, a, r) => {
      await treeLock(q, a.tenant_id);
      const n = await requireAccess(q, a, id(r), 3);
      assert(
        n.kind !== "workspace",
        400,
        "Workspace deletion is not available",
      );
      const all = (
        await q.query(
          "WITH RECURSIVE subtree AS(SELECT id,kind FROM resources WHERE id=$1 UNION ALL SELECT r.id,r.kind FROM resources r JOIN subtree s ON r.parent_id=s.id WHERE r.deleted_at IS NULL) SELECT * FROM subtree",
          [n.id],
        )
      ).rows;
      for (const child of all) {
        await requireAccess(q, a, child.id, 3);
        scope(a, pageScope(child.kind, true));
      }
      for (const child of all) {
        await q.query(
          "UPDATE resources SET deleted_at=now(),updated_at=now(),updated_by=$2 WHERE id=$1",
          [child.id, a.user_id],
        );
        await emit(q, a, `${child.kind}.deleted`, child.id);
      }
      return { ok: true };
    },
  );
  route(
    "GET",
    "/trash",
    "Read trash",
    async (q, a) =>
      visible(
        q,
        a,
        (
          await q.query(
            "SELECT * FROM resources WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200",
          )
        ).rows,
        true,
      ),
    "workspace.read",
  );
  route(
    "POST",
    "/resources/:id/restore",
    "Restore trashed item",
    async (q, a, r) => {
      await treeLock(q, a.tenant_id);
      const n = await requireAccess(q, a, id(r), 3, true);
      scope(a, pageScope(n.kind, true));
      if (n.parent_id) await requireAccess(q, a, n.parent_id, 3);
      await q.query(
        "UPDATE resources SET deleted_at=NULL,updated_at=now(),updated_by=$2 WHERE id=$1",
        [n.id, a.user_id],
      );
      await emit(q, a, `${n.kind}.restored`, n.id);
      return { ok: true };
    },
  );
  route(
    "GET",
    "/retention",
    "Read trash retention policy",
    async (q, a) => {
      admin(a);
      return one(q, "SELECT trash_retention_days FROM organisations WHERE id=$1", [
        a.tenant_id,
      ]);
    },
  );
  route(
    "PATCH",
    "/retention",
    "Update trash retention policy",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z
          .object({
            trash_retention_days: z.number().int().min(1).max(3650).nullable(),
          })
          .strict(),
        r,
      );
      await q.query(
        "UPDATE organisations SET trash_retention_days=$2 WHERE id=$1",
        [a.tenant_id, v.trash_retention_days],
      );
      await emit(q, a, "retention.updated", null);
      return v;
    },
  );
  route(
    "DELETE",
    "/resources/:id/purge",
    "Permanently purge a trashed resource subtree",
    async (q, a, r) => {
      admin(a);
      const n = await requireAccess(q, a, id(r), 4, true);
      assert(n.deleted_at, 409, "Resource must be in trash before purge");
      return purgeDeletedResource(q, a.tenant_id, n.id, a);
    },
  );
  route(
    "POST",
    "/resources/:id/bookmark",
    "Record visit or favourite",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required");
      await requireAccess(q, a, id(r));
      const v = body(z.object({ favourite: z.boolean().optional() }), r);
      await q.query(
        "INSERT INTO bookmarks(tenant_id,user_id,resource_id,favourite) VALUES($1,$2,$3,coalesce($4,false)) ON CONFLICT(tenant_id,user_id,resource_id) DO UPDATE SET visited_at=now(),favourite=coalesce($4,bookmarks.favourite)",
        [a.tenant_id, a.user_id, id(r), v.favourite ?? null],
      );
      return { ok: true };
    },
  );
  route(
    "GET",
    "/pages/:id/content",
    "Read canonical content and source metadata",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      const d = await one(
        q,
        "SELECT blocks,plain_text,revision,epoch FROM page_documents WHERE resource_id=$1",
        [n.id],
      );
      assert(d, 404, "Content not found");
      const path = await ancestry(q, n.id);
      return {
        id: n.id,
        tenant_id: a.tenant_id,
        workspace_id: path.find((p) => p.kind === "workspace")?.id,
        space_id: path.find((p) => p.kind === "space")?.id,
        parent_id: n.parent_id,
        title: n.title,
        created_at: n.created_at,
        updated_at: n.updated_at,
        ...d,
      };
    },
  );
  route(
    "PATCH",
    "/pages/:id/content",
    "Replace canonical content with a revision precondition",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r), 3);
      scope(a, pageScope(n.kind, true));
      const v = body(
        z
          .object({
            blocks: z.array(z.any()),
            expected_revision: z.number().int().positive(),
          })
          .strict(),
        r,
      );
      return replaceDocument(
        q,
        a,
        n.id,
        v.blocks,
        v.expected_revision,
        "Before content replacement",
      );
    },
  );
  route(
    "POST",
    "/pages/:id/collab",
    "Issue a document-bound collaboration ticket",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required");
      const n = await requireAccess(q, a, id(r)),
        d = await one(
          q,
          "SELECT epoch FROM page_documents WHERE resource_id=$1",
          [n.id],
        );
      assert(d, 404, "Content not found");
      return {
        name: `${a.tenant_id}/${n.id}/${d.epoch}`,
        token: issueTicket({
          tenant: a.tenant_id,
          user: a.user_id,
          resource: n.id,
          epoch: d.epoch,
          sessionHash: a.tokenHash!,
        }),
        readOnly: n.effective_permission < 3,
      };
    },
  );
  route(
    "GET",
    "/pages/:id/versions",
    "List document history",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      return (
        await q.query(
          "SELECT v.id,v.revision,v.context,v.created_at,u.name author FROM page_versions v LEFT JOIN users u ON u.id=v.author_id WHERE resource_id=$1 ORDER BY created_at DESC LIMIT 100",
          [id(r)],
        )
      ).rows;
    },
  );
  route(
    "GET",
    "/pages/:id/versions/:version",
    "Read historical blocks",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      const v = await one(
        q,
        "SELECT id,revision,blocks,context,created_at FROM page_versions WHERE resource_id=$1 AND id=$2",
        [id(r), id(r, "version")],
      );
      assert(v, 404, "Version not found");
      return v;
    },
  );
  route(
    "POST",
    "/pages/:id/versions/:version/restore",
    "Restore a version without destroying history",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r), 3);
      scope(a, pageScope(n.kind, true));
      const v = body(
          z.object({ expected_revision: z.number().int().positive() }),
          r,
        ),
        old = await one(
          q,
          "SELECT blocks FROM page_versions WHERE resource_id=$1 AND id=$2",
          [id(r), id(r, "version")],
        );
      assert(old, 404, "Version not found");
      return replaceDocument(
        q,
        a,
        id(r),
        old.blocks,
        v.expected_revision,
        "Before version restore",
      );
    },
  );
  route(
    "GET",
    "/search",
    "Permission-filtered full-text and file metadata search",
    async (q, a, r) => {
      const term = (query(r).q || "").trim().slice(0, 200);
      if (!term) return [];
      const escaped = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = (
        await q.query(
          "SELECT id,title,kind,left(search_text,240) snippet,parent_id,updated_at FROM resources WHERE deleted_at IS NULL AND(to_tsvector('simple',title||' '||search_text)@@websearch_to_tsquery('simple',$1) OR title ILIKE $2 ESCAPE '\\') ORDER BY updated_at DESC LIMIT 300",
          [term, escaped],
        )
      ).rows;
      const result = (await visible(q, a, rows))
        .filter((n) => !a.scopes || a.scopes.includes(pageScope(n.kind)))
        .slice(0, 50);
      if (!a.scopes || a.scopes.includes("files.read"))
        for (const f of (
          await q.query(
            "SELECT id,resource_id,name title,'file' kind,created_at updated_at FROM files WHERE deleted_at IS NULL AND name ILIKE $1 ESCAPE '\\' LIMIT 100",
            [escaped],
          )
        ).rows)
          if (await access(q, a, f.resource_id)) result.push(f);
      return result.slice(0, 60);
    },
  );
  route(
    "GET",
    "/templates",
    "List built-in templates",
    async () =>
      Object.entries(templates).map(([id, t]) => ({ id, title: t.title })),
    "workspace.read",
  );
  dataRoutes(route, storage, antivirus, antivirusMetrics);
  await registerScim(app, db);
  app.addHook("onClose", async () => {
    try {
      await redis?.quit();
    } finally {
      storage.close?.();
    }
  });
  return app;
}
function dataRoutes(
  route: Route,
  storage: Storage,
  antivirus: Antivirus,
  antivirusMetrics: { clean: number; infected: number; error: number },
) {
  route(
    "GET",
    "/databases/:id",
    "Read schema and views",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r)),
        d = await one(
          q,
          "SELECT properties FROM databases WHERE resource_id=$1",
          [n.id],
        );
      assert(d, 404, "Database not found");
      return {
        ...n,
        ...d,
        views: (
          await q.query(
            "SELECT * FROM database_views WHERE database_id=$1 ORDER BY name",
            [n.id],
          )
        ).rows,
      };
    },
    "databases.read",
  );
  route(
    "PATCH",
    "/databases/:id",
    "Update validated property schema",
    async (q, a, r) => {
      await requireAccess(q, a, id(r), 3);
      const v = body(z.object({ properties }).strict(), r);
      await q.query("SELECT 1 FROM databases WHERE resource_id=$1 FOR UPDATE", [
        id(r),
      ]);
      for (const row of (
        await q.query(
          "SELECT values FROM database_records WHERE database_id=$1",
          [id(r)],
        )
      ).rows)
        validateValues(v.properties, row.values);
      await q.query("UPDATE databases SET properties=$2 WHERE resource_id=$1", [
        id(r),
        json(v.properties),
      ]);
      await emit(q, a, "database.updated", id(r));
      return { ok: true };
    },
    "databases.write",
  );
  route(
    "GET",
    "/databases/:id/records",
    "Read filtered and sorted records",
    async (q, a, r) => {
      const p = query(r);
      let c = view.parse({ type: "table" });
      if (p.view) {
        const v = await one(
          q,
          "SELECT config FROM database_views WHERE id=$1 AND database_id=$2",
          [uuid.parse(p.view), id(r)],
        );
        assert(v, 404, "View not found");
        c = view.parse(v.config);
      }
      return records(
        q,
        a,
        id(r),
        c,
        Math.max(0, Number(p.offset) || 0),
        Math.min(200, Math.max(1, Number(p.limit) || 100)),
      );
    },
    "databases.read",
  );
  route(
    "POST",
    "/databases/:id/records",
    "Create record and page body",
    async (q, a, r) =>
      createRecord(
        q,
        a,
        id(r),
        body(
          z.object({ values: z.record(z.string(), z.unknown()) }).strict(),
          r,
        ).values,
      ),
    "databases.write",
  );
  route(
    "GET",
    "/records/:id",
    "Read record properties",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r)),
        v = await one(
          q,
          "SELECT v.*,d.properties FROM database_records v JOIN databases d ON d.resource_id=v.database_id WHERE v.resource_id=$1",
          [n.id],
        );
      assert(v, 404, "Record not found");
      return { ...n, ...v };
    },
    "databases.read",
  );
  route(
    "PATCH",
    "/records/:id",
    "Update record with optimistic concurrency",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r), 3),
        v = body(
          z
            .object({
              values: z.record(z.string(), z.unknown()),
              expected_revision: z.number().int().positive(),
            })
            .strict(),
          r,
        ),
        d = await one(
          q,
          "SELECT v.*,d.properties FROM database_records v JOIN databases d ON d.resource_id=v.database_id WHERE v.resource_id=$1 FOR UPDATE OF v,d",
          [n.id],
        );
      assert(d, 404, "Record not found");
      assert(
        d.revision === v.expected_revision,
        409,
        "Record changed; reload before saving",
      );
      const values = validateValues(d.properties, { ...d.values, ...v.values });
      await validatePeople(q, d.properties, values);
      await q.query(
        "UPDATE database_records SET values=$2,revision=revision+1 WHERE resource_id=$1",
        [n.id, json(values)],
      );
      await q.query(
        "UPDATE resources SET title=$2,search_text=$3,updated_at=now(),updated_by=$4 WHERE id=$1",
        [
          n.id,
          values[d.properties.find((p: any) => p.type === "title").id],
          Object.values(values).join(" "),
          a.user_id,
        ],
      );
      await emit(q, a, "record.updated", n.id, d.revision + 1);
      return { ...n, values, revision: d.revision + 1 };
    },
    "databases.write",
  );
  for (const method of ["POST", "PATCH"] as const)
    route(
      method,
      `/databases/:id/views${method === "PATCH" ? "/:view" : ""}`,
      "Save a table or board view",
      async (q, a, r) => {
        await requireAccess(q, a, id(r), 3);
        const v = body(z.object({ name: title, config: view }).strict(), r),
          d = await one(
            q,
            "SELECT properties FROM databases WHERE resource_id=$1",
            [id(r)],
          );
        assert(d, 404, "Database not found");
        const keys = d.properties.map((p: any) => p.id);
        for (const k of [
          ...v.config.filters.map((f) => f.property),
          ...v.config.sort.map((s) => s.property),
          ...(v.config.visible || []),
          ...(v.config.order || []),
        ])
          assert(keys.includes(k), 400, "Unknown view property");
        if (v.config.type === "board")
          assert(
            d.properties.some(
              (p: any) =>
                p.id === v.config.groupBy &&
                ["select", "status"].includes(p.type),
            ),
            400,
            "Board requires Select or Status grouping",
          );
        const vid = method === "POST" ? randomUUID() : id(r, "view");
        if (method === "POST")
          await q.query(
            "INSERT INTO database_views(id,tenant_id,database_id,name,config) VALUES($1,$2,$3,$4,$5)",
            [vid, a.tenant_id, id(r), v.name, json(v.config)],
          );
        else
          assert(
            (
              await q.query(
                "UPDATE database_views SET name=$3,config=$4 WHERE id=$1 AND database_id=$2",
                [vid, id(r), v.name, json(v.config)],
              )
            ).rowCount,
            404,
            "View not found",
          );
        await emit(q, a, "database.updated", id(r));
        return { id: vid, ...v };
      },
      "databases.write",
    );
  route(
    "GET",
    "/resources/:id/comments",
    "Read discussions",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      return (
        await q.query(
          "SELECT c.*,u.name author FROM comments c JOIN users u ON u.id=c.author_id WHERE resource_id=$1 ORDER BY created_at",
          [n.id],
        )
      ).rows;
    },
  );
  route(
    "POST",
    "/resources/:id/comments",
    "Post a comment and mention notification",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r), 2);
      scope(a, pageScope(n.kind, true));
      const v = body(
          z
            .object({
              body: z.string().trim().min(1).max(10000),
              block_id: z.string().max(100).optional(),
            })
            .strict(),
          r,
        ),
        cid = randomUUID();
      await q.query(
        "INSERT INTO comments(id,tenant_id,resource_id,author_id,body,block_id) VALUES($1,$2,$3,$4,$5,$6)",
        [cid, a.tenant_id, n.id, a.user_id, v.body, v.block_id || null],
      );
      for (const m of v.body.matchAll(/@\{([0-9a-f-]{36})\}/g)) {
        const member = await one(
          q,
          "SELECT role FROM memberships WHERE user_id=$1 AND active",
          [m[1]],
        );
        if (
          member &&
          (await access(q, { ...a, user_id: m[1], role: member.role }, n.id))
        )
          await q.query(
            "INSERT INTO notifications(id,tenant_id,user_id,resource_id,message) VALUES($1,$2,$3,$4,$5)",
            [
              randomUUID(),
              a.tenant_id,
              m[1],
              n.id,
              `${a.name} mentioned you in ${n.title}`,
            ],
          );
      }
      await emit(q, a, "comment.created", n.id);
      return { id: cid, ...v };
    },
  );
  route(
    "PATCH",
    "/resources/:id/comments/:comment",
    "Edit or resolve a comment",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r), 2);
      scope(a, pageScope(n.kind, true));
      const v = body(
          z
            .object({
              body: z.string().trim().min(1).max(10000).optional(),
              resolved: z.boolean().optional(),
            })
            .strict(),
          r,
        ),
        c = await one(
          q,
          "SELECT * FROM comments WHERE id=$1 AND resource_id=$2",
          [id(r, "comment"), n.id],
        );
      assert(c, 404, "Comment not found");
      assert(
        c.author_id === a.user_id || n.effective_permission >= 3,
        403,
        "Only the author or an editor may resolve",
      );
      if (v.body)
        assert(
          c.author_id === a.user_id || ["owner", "admin"].includes(a.role),
          403,
          "Only the author or admin may edit",
        );
      await q.query(
        "UPDATE comments SET body=coalesce($2,body),resolved=coalesce($3,resolved),edited_at=CASE WHEN $2::text IS NULL THEN edited_at ELSE now() END WHERE id=$1",
        [c.id, v.body ?? null, v.resolved ?? null],
      );
      await emit(q, a, "comment.updated", n.id);
      return { ok: true };
    },
  );
  route(
    "DELETE",
    "/resources/:id/comments/:comment",
    "Delete or moderate a comment",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r), 2);
      scope(a, pageScope(n.kind, true));
      const c = await one(
        q,
        "SELECT * FROM comments WHERE id=$1 AND resource_id=$2",
        [id(r, "comment"), n.id],
      );
      assert(c, 404, "Comment not found");
      assert(
        c.author_id === a.user_id || ["owner", "admin"].includes(a.role),
        403,
        "Author or administrator required",
      );
      await q.query("DELETE FROM comments WHERE id=$1", [c.id]);
      await emit(q, a, "comment.deleted", n.id);
      return { ok: true };
    },
  );
  route(
    "GET",
    "/resources/:id/files",
    "List private attachments",
    async (q, a, r) => {
      await requireAccess(q, a, id(r));
      return (
        await q.query(
          "SELECT id,name,mime,size,created_at FROM files WHERE resource_id=$1 AND deleted_at IS NULL ORDER BY created_at",
          [id(r)],
        )
      ).rows;
    },
    "files.read",
  );
  route(
    "POST",
    "/resources/:id/files",
    "Upload a private attachment",
    async (q, a, r, reply) => {
      await requireAccess(q, a, id(r), 3);
      const part = await r.file();
      assert(part, 400, "Choose a file");
      const bytes = await part.toBuffer();
      assert(!part.file.truncated, 413, "File exceeds 25 MB");
      let mime: string;
      try {
        mime = inspectFile(part.filename, part.mimetype, bytes);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      let scan;
      try {
        scan = await antivirus.scan(bytes);
      } catch (error) {
        antivirusMetrics.error += 1;
        if (error instanceof AntivirusUnavailableError)
          throw new HttpError(503, "Malware scanner unavailable");
        throw error;
      }
      antivirusMetrics[scan.status] += 1;
      if (scan.status === "infected") {
        await emit(q, a, "file.malware_blocked", id(r));
        reply.code(422);
        return { error: "File rejected by malware scanner" };
      }
      const fid = randomUUID(),
        key = `${a.tenant_id}/${id(r)}/${fid}`;
      await storage.put(key, bytes, mime);
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          fid,
          a.tenant_id,
          id(r),
          key,
          part.filename.replace(/[\r\n\x00]/g, "").slice(0, 255),
          mime,
          bytes.length,
        ],
      );
      await emit(q, a, "file.created", id(r));
      return {
        id: fid,
        name: part.filename,
        url: `/api/v1/files/${fid}/content`,
      };
    },
    "files.write",
  );
  route(
    "GET",
    "/files/:id/content",
    "Authorize parent before returning bytes",
    async (q, a, r, reply) => {
      const f = await one(
        q,
        "SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL",
        [id(r)],
      );
      assert(f, 404, "File not found");
      await requireAccess(q, a, f.resource_id);
      reply
        .type(f.mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header(
          "Content-Disposition",
          `${f.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        );
      return reply.send(await storage.get(f.object_key));
    },
    "files.read",
  );
  route(
    "DELETE",
    "/files/:id",
    "Soft-delete attachment",
    async (q, a, r) => {
      const f = await one(
        q,
        "SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL",
        [id(r)],
      );
      assert(f, 404, "File not found");
      await requireAccess(q, a, f.resource_id, 3);
      await q.query("UPDATE files SET deleted_at=now() WHERE id=$1", [f.id]);
      await emit(q, a, "file.deleted", f.resource_id);
      return { ok: true };
    },
    "files.write",
  );
  route(
    "GET",
    "/scim/connectors",
    "List SCIM connectors",
    async (q, a) => {
      admin(a);
      return (
        await q.query(
          "SELECT id,label,default_role,created_at,last_used_at,revoked_at FROM scim_connectors ORDER BY created_at DESC",
        )
      ).rows;
    },
  );
  route(
    "POST",
    "/scim/connectors",
    "Create tenant-scoped SCIM connector",
    async (q, a, r) => {
      admin(a);
      const v = body(
          z
            .object({
              label: z.string().trim().min(1).max(120),
              default_role: z.enum(["member", "guest"]).default("member"),
            })
            .strict(),
          r,
        ),
        id = randomUUID(),
        value = `scim_${token()}`;
      await q.query(
        "INSERT INTO scim_connectors(id,tenant_id,label,token_hash,default_role,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [id, a.tenant_id, v.label, hash(value), v.default_role, a.user_id],
      );
      await emit(q, a, "scim.connector_created", null);
      return {
        id,
        label: v.label,
        default_role: v.default_role,
        token: value,
        base_url: new URL(
          "/scim/v2",
          process.env.APP_URL || "http://localhost:3000",
        ).href.replace(/\/$/, ""),
        warning: "This token is shown once. Store it in the identity provider secret store.",
      };
    },
  );
  route(
    "DELETE",
    "/scim/connectors/:id",
    "Revoke SCIM connector",
    async (q, a, r) => {
      admin(a);
      const changed = await one(
        q,
        "UPDATE scim_connectors SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id",
        [id(r)],
      );
      assert(changed, 404, "SCIM connector not found");
      await emit(q, a, "scim.connector_revoked", null);
      return { ok: true };
    },
  );
  route(
    "GET",
    "/scim/groups",
    "List SCIM groups and role mappings",
    async (q, a) => {
      admin(a);
      return (
        await q.query(
          `SELECT g.id,g.display_name,g.external_id,g.created_at,g.updated_at,
             rm.role AS mapped_role,
             count(gm.scim_user_id)::int AS member_count
           FROM scim_groups g
           LEFT JOIN scim_group_role_mappings rm ON rm.group_id=g.id
           LEFT JOIN scim_group_members gm ON gm.group_id=g.id
           WHERE g.deleted_at IS NULL
           GROUP BY g.id,rm.role
           ORDER BY lower(g.display_name),g.id`,
        )
      ).rows;
    },
  );
  route(
    "PATCH",
    "/scim/groups/:id/role",
    "Map SCIM group to Workspace role",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z
          .object({
            role: z.enum(["member", "guest"]).nullable(),
          })
          .strict(),
        r,
      );
      await setScimGroupRoleMapping(
        q,
        a.tenant_id,
        id(r),
        v.role,
        a.user_id,
      );
      await emit(q, a, "scim.group_role_mapping_updated", null);
      return { ok: true, role: v.role };
    },
  );
  route(
    "GET",
    "/members",
    "Read tenant members",
    async (q) =>
      (
        await q.query(
          "SELECT u.id,u.name,u.email,u.is_service,m.role,m.active FROM memberships m JOIN users u ON u.id=m.user_id ORDER BY u.name",
        )
      ).rows,
    "users.read",
  );
  route(
    "POST",
    "/members/invite",
    "Generate one-time invitation",
    async (q, a, r) => {
      admin(a);
      const v = body(
          z
            .object({
              name: title,
              email: z.email().transform((v) => v.toLowerCase()),
              role: roles.exclude(["owner"]).default("member"),
            })
            .strict(),
          r,
        ),
        t = token();
      await q.query(
        "INSERT INTO invitations(token_hash,tenant_id,name,email,role) VALUES($1,$2,$3,$4,$5)",
        [hash(t), a.tenant_id, v.name, v.email, v.role],
      );
      await emit(q, a, "membership.invited", null);
      return {
        url: `${process.env.APP_URL || "http://localhost:3000"}/?invite=${t}`,
        expires_in_days: 7,
      };
    },
  );
  route(
    "PATCH",
    "/members/:id",
    "Change role or active state",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z
          .object({ role: roles.optional(), active: z.boolean().optional() })
          .strict(),
        r,
      );
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `members:${a.tenant_id}`,
      ]);
      const m = await one(q, "SELECT * FROM memberships WHERE user_id=$1", [
        id(r),
      ]);
      assert(m, 404, "Member not found");
      assert(
        a.role === "owner" || (m.role !== "owner" && v.role !== "owner"),
        403,
        "Only owners manage ownership",
      );
      if (
        m.role === "owner" &&
        (v.active === false || (v.role && v.role !== "owner"))
      )
        assert(
          Number(
            (
              await one(
                q,
                "SELECT count(*) n FROM memberships WHERE role='owner' AND active",
              )
            ).n,
          ) > 1,
          409,
          "An active owner is required",
        );
      await q.query(
        "UPDATE memberships SET role=coalesce($2,role),active=coalesce($3,active) WHERE user_id=$1",
        [id(r), v.role ?? null, v.active ?? null],
      );
      if (v.active === false)
        await q.query(
          "DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2",
          [a.tenant_id, id(r)],
        );
      await emit(q, a, "membership.updated", id(r));
      return { ok: true };
    },
  );
  route(
    "GET",
    "/resources/:id/permissions",
    "Read source ACL chain",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      return {
        tenant_id: a.tenant_id,
        resource_id: n.id,
        effective_permission: n.effective_permission,
        revision: n.permission_revision,
        policy: (await ancestry(q, n.id)).map((p) => ({
          id: p.id,
          inherit: p.inherit_permissions,
          grants: p.acl,
        })),
        semantics:
          "ancestor restrictions; user grant overrides everyone; owner/admin manage",
      };
    },
    "permissions.read",
  );
  route(
    "GET",
    "/resources/:id/permissions/check",
    "Recheck end-user access for evidence",
    async (q, a, r) => {
      await requireAccess(q, a, id(r));
      const u = uuid.parse(query(r).user_id),
        m = await one(
          q,
          "SELECT role FROM memberships WHERE user_id=$1 AND active",
          [u],
        );
      return {
        allowed:
          !!m &&
          (await access(q, { ...a, user_id: u, role: m.role }, id(r))) > 0,
      };
    },
    "permissions.read",
  );
  route(
    "PATCH",
    "/resources/:id/permissions",
    "Replace local access grants",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required");
      await treeLock(q, a.tenant_id);
      await requireAccess(q, a, id(r), 4);
      const v = body(
        z
          .object({
            inherit: z.boolean(),
            expected_revision: z.number().int().positive(),
            grants: z
              .array(
                z.object({
                  principal_id: z.union([uuid, z.literal("*")]),
                  level: z.number().int().min(0).max(4),
                }),
              )
              .max(500),
          })
          .strict(),
        r,
      );
      assert(
        new Set(v.grants.map((g) => g.principal_id)).size === v.grants.length,
        400,
        "Duplicate principal grant",
      );
      for (const g of v.grants)
        if (g.principal_id !== "*")
          assert(
            await one(
              q,
              "SELECT 1 FROM memberships WHERE user_id=$1 AND active",
              [g.principal_id],
            ),
            400,
            "Principal must be an active member of this organisation",
          );
      const current = await one(
        q,
        "SELECT permission_revision FROM resources WHERE id=$1 FOR UPDATE",
        [id(r)],
      );
      assert(current, 404, "Resource not found");
      assert(
        current.permission_revision === v.expected_revision,
        409,
        "Access policy changed; reload before saving",
      );
      await q.query(
        "UPDATE resources SET inherit_permissions=$2,permission_revision=permission_revision+1 WHERE id=$1",
        [id(r), v.inherit],
      );
      await q.query("DELETE FROM acl WHERE resource_id=$1", [id(r)]);
      for (const g of v.grants)
        await q.query(
          "INSERT INTO acl(tenant_id,resource_id,principal_id,level) VALUES($1,$2,$3,$4)",
          [a.tenant_id, id(r), g.principal_id, g.level],
        );
      await emit(q, a, "permission.updated", id(r));
      return { ok: true, revision: current.permission_revision + 1 };
    },
  );
  route(
    "PATCH",
    "/branding",
    "Apply runtime organisation branding",
    async (q, a, r) => {
      admin(a);
      const v = body(brandingSchema, r);
      await q.query("UPDATE organisations SET branding=$2 WHERE id=$1", [
        a.tenant_id,
        json(v),
      ]);
      await emit(q, a, "branding.updated", a.tenant_id);
      return v;
    },
  );
  route(
    "GET",
    "/operations/status",
    "Read tenant operational queue status",
    async (q, a) => {
      assert(!a.scopes, 403, "Human session required");
      admin(a);
      const jobs = await one(
          q,
          "SELECT count(*) FILTER (WHERE status='pending')::int pending,count(*) FILTER (WHERE status='failed')::int failed,min(created_at) FILTER (WHERE status='pending') oldest_pending_at FROM jobs",
        ),
        webhooks = await one(
          q,
          "SELECT count(*) FILTER (WHERE status IN ('pending','retry'))::int pending,count(*) FILTER (WHERE status='dead')::int dead,min(next_at) FILTER (WHERE status IN ('pending','retry')) oldest_pending_at FROM webhook_deliveries",
        ),
        objects = await one(
          q,
          "SELECT count(*) FILTER (WHERE status IN ('pending','retry'))::int pending,count(*) FILTER (WHERE status='dead')::int dead,min(next_at) FILTER (WHERE status IN ('pending','retry')) oldest_pending_at FROM object_deletions",
        ),
        events = await one(
          q,
          "SELECT count(*) FILTER (WHERE dispatched_at IS NULL)::int pending,min(created_at) FILTER (WHERE dispatched_at IS NULL) oldest_pending_at FROM event_outbox",
        );
      return {
        generated_at: new Date().toISOString(),
        attention_required:
          jobs.failed > 0 || webhooks.dead > 0 || objects.dead > 0,
        queues: {
          imports: jobs,
          webhooks,
          object_deletions: objects,
          events,
        },
      };
    },
  );
  route("GET", "/audit", "Read append-only audit", async (q, a, r) => {
    admin(a);
    return (
      await q.query(
        "SELECT e.*,u.name actor FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC LIMIT 100 OFFSET $1",
        [Math.max(0, Number(query(r).offset) || 0)],
      )
    ).rows;
  });
  route(
    "GET",
    "/audit/export",
    "Export append-only audit as CSV",
    async (q, a, r, reply) => {
      admin(a);
      const p = query(r),
        limit = Math.min(10000, Math.max(1, Number(p.limit) || 10000)),
        values: any[] = [],
        where: string[] = [];
      if (p.since) {
        values.push(z.iso.datetime({ offset: true }).parse(p.since));
        where.push(`e.created_at >= $${values.length}::timestamptz`);
      }
      if (p.until) {
        values.push(z.iso.datetime({ offset: true }).parse(p.until));
        where.push(`e.created_at <= $${values.length}::timestamptz`);
      }
      if (p.action) {
        values.push(z.string().max(200).parse(p.action));
        where.push(`e.action = $${values.length}`);
      }
      values.push(limit);
      const rows = (
        await q.query(
          `SELECT e.id,e.action,e.resource_id,e.request_id,e.created_at,u.name actor
           FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""}
           ORDER BY e.created_at DESC,e.id
           LIMIT $${values.length}`,
          values,
        )
      ).rows;
      const safe = (v: unknown) => {
        const text = v == null ? "" : String(v);
        return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      };
      reply
        .type("text/csv")
        .header("Content-Disposition", 'attachment; filename="audit.csv"');
      return reply.send(
        stringify(
          rows.map((row) => ({
            id: row.id,
            action: safe(row.action),
            actor: safe(row.actor),
            resource_id: row.resource_id || "",
            request_id: safe(row.request_id),
            created_at:
              row.created_at instanceof Date
                ? row.created_at.toISOString()
                : String(row.created_at),
          })),
          {
            header: true,
            columns: [
              "id",
              "action",
              "actor",
              "resource_id",
              "request_id",
              "created_at",
            ],
          },
        ),
      );
    },
  );
  route(
    "GET",
    "/resources/:id/activity",
    "Read resource activity",
    async (q, a, r) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      return (
        await q.query(
          "SELECT e.id,e.action,e.created_at,u.name actor FROM audit_events e LEFT JOIN users u ON u.id=e.actor_id WHERE resource_id=$1 ORDER BY e.created_at DESC LIMIT 50",
          [n.id],
        )
      ).rows;
    },
  );
  route(
    "GET",
    "/notifications",
    "Read still-accessible mentions",
    async (q, a) =>
      visible(
        q,
        a,
        (
          await q.query(
            "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
            [a.user_id],
          )
        ).rows,
      ),
  );

  // T2: registrations are inert. No live sign-in or logout route reads this
  // table; enabling a tenant provider requires a separately reviewed T3/T4.
  route(
    "GET",
    "/identity/providers",
    "List tenant identity providers without secrets",
    async (q, a) => {
      admin(a);
      return (
        await q.query(
          "SELECT id,label,issuer,client_id,token_auth_method,scopes," +
          " require_verified_email,enabled,revision,created_at,revoked_at" +
          " FROM oidc_tenant_providers WHERE tenant_id=$1" +
          " ORDER BY created_at DESC,id LIMIT 100",
          [a.tenant_id],
        )
      ).rows;
    },
  );
  route(
    "POST",
    "/identity/providers",
    "Register disabled tenant OIDC provider",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z
          .object({
            label: z.string().trim().min(1).max(120),
            issuer: z.url().max(2048),
            client_id: z.string().min(1).max(256),
            client_secret: z.string().min(12).max(2048).optional(),
            token_auth_method: z.enum([
              "client_secret_basic",
              "client_secret_post",
              "none",
            ]),
            scopes: z
              .array(z.string().min(1).max(80))
              .min(1)
              .max(12)
              .default(["openid", "profile", "email"]),
          })
          .strict(),
        r,
      );
      const issuer = validateTenantOidcRegistration({
        label: v.label,
        issuer: v.issuer,
        clientId: v.client_id,
        clientSecret: v.client_secret,
        tokenAuthMethod: v.token_auth_method,
        scopes: v.scopes,
      });
      const providerId = randomUUID();
      const sealed = v.client_secret
        ? sealTenantOidcSecret(v.client_secret, a.tenant_id, providerId)
        : null;
      const provider = await one(
        q,
        "INSERT INTO oidc_tenant_providers" +
        " (id,tenant_id,label,issuer,client_id,client_secret_encrypted," +
        " token_auth_method,scopes,created_by)" +
        " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)" +
        " RETURNING id,label,issuer,client_id,token_auth_method,scopes," +
        " require_verified_email,enabled,revision,created_at,revoked_at",
        [
          providerId,
          a.tenant_id,
          v.label,
          issuer,
          v.client_id,
          sealed,
          v.token_auth_method,
          v.scopes,
          a.user_id,
        ],
      );
      await emit(q, a, "identity.provider_registered", null);
      return provider;
    },
  );
  route(
    "DELETE",
    "/identity/providers/:id",
    "Revoke tenant OIDC provider registration",
    async (q, a, r) => {
      admin(a);
      const providerId = uuid.parse(params(r).id);
      const revoked = await one(
        q,
        "UPDATE oidc_tenant_providers" +
        " SET revoked_at=now(),revision=revision+1" +
        " WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL" +
        " RETURNING id,revision,revoked_at",
        [a.tenant_id, providerId],
      );
      assert(revoked, 404, "Identity provider not found");
      await emit(q, a, "identity.provider_revoked", null);
      return { ok: true, ...revoked };
    },
  );
  route(
    "GET",
    "/integrations",
    "List credentials without secrets",
    async (q, a) => {
      admin(a);
      return (
        await q.query(
          "SELECT token_hash credential_id,label,user_id,scopes,expires_at FROM sessions WHERE tenant_id=$1 AND scopes IS NOT NULL",
          [a.tenant_id],
        )
      ).rows;
    },
  );
  route(
    "POST",
    "/integrations",
    "Create separately permissioned service principal",
    async (q, a, r) => {
      admin(a);
      const v = body(
          z
            .object({
              name: title,
              scopes: z
                .array(z.enum(scopes))
                .min(1)
                .default([
                  "workspace.read",
                  "pages.read",
                  "databases.read",
                  "files.read",
                  "permissions.read",
                  "events.read",
                ]),
            })
            .strict(),
          r,
        ),
        u = randomUUID();
      await q.query(
        "INSERT INTO users(id,email,name,is_service) VALUES($1,$2,$3,true)",
        [u, `${u}@service.internal`, v.name],
      );
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'guest')",
        [a.tenant_id, u],
      );
      const t = await createSession(q, a.tenant_id, u, v.scopes, v.name);
      await emit(q, a, "integration.created", u);
      return { token: t, principal_id: u, scopes: v.scopes };
    },
  );
  route(
    "DELETE",
    "/integrations/:credential",
    "Revoke service credential",
    async (q, a, r) => {
      admin(a);
      const h = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(params(r).credential);
      await q.query(
        "DELETE FROM sessions WHERE token_hash=$1 AND tenant_id=$2 AND scopes IS NOT NULL",
        [h, a.tenant_id],
      );
      await emit(q, a, "integration.revoked", null);
      return { ok: true };
    },
  );
  route(
    "GET",
    "/events",
    "Read accessible integration events",
    async (q, a, r) => {
      const out = [];
      for (const e of (
        await q.query(
          "SELECT * FROM event_outbox WHERE created_at>$1::timestamptz ORDER BY created_at,id LIMIT 200",
          [query(r).since || "1970-01-01"],
        )
      ).rows)
        if (e.resource_id && (await access(q, a, e.resource_id, true)))
          out.push(e);
      return out;
    },
    "events.read",
  );
  route(
    "GET",
    "/webhooks",
    "Read subscriptions and deliveries",
    async (q, a) => {
      admin(a);
      return {
        subscriptions: (
          await q.query(
            "SELECT id,url,events,active FROM webhook_subscriptions",
          )
        ).rows,
        deliveries: (
          await q.query(
            "SELECT * FROM webhook_deliveries ORDER BY next_at DESC LIMIT 100",
          )
        ).rows,
      };
    },
  );
  route(
    "POST",
    "/webhooks",
    "Register allowlisted signed webhook",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z
          .object({
            url: z.url(),
            events: z
              .array(z.string().regex(/^[a-z]+\.[a-z_]+$/))
              .min(1)
              .max(50),
          })
          .strict(),
        r,
      );
      validateWebhook(v.url);
      const secret = token(),
        wid = randomUUID();
      await q.query(
        "INSERT INTO webhook_subscriptions(id,tenant_id,url,events,secret_encrypted) VALUES($1,$2,$3,$4,$5)",
        [wid, a.tenant_id, v.url, v.events, encrypt(secret)],
      );
      await emit(q, a, "integration.configured", wid);
      return { id: wid, secret, ...v };
    },
  );
  route(
    "PATCH",
    "/webhooks/:id",
    "Enable or disable a webhook",
    async (q, a, r) => {
      admin(a);
      const v = body(z.object({ active: z.boolean() }), r);
      assert(
        (
          await q.query(
            "UPDATE webhook_subscriptions SET active=$2 WHERE id=$1",
            [id(r), v.active],
          )
        ).rowCount,
        404,
        "Webhook not found",
      );
      await emit(q, a, "integration.configured", id(r));
      return { ok: true };
    },
  );
  route("POST", "/imports", "Queue Markdown or CSV import", async (q, a, r) => {
    const v = body(
      z
        .object({
          parent_id: uuid,
          format: z.enum(["markdown", "csv"]),
          name: title,
          content: z.string().max(2097152),
        })
        .strict(),
      r,
    );
    scope(a, v.format === "csv" ? "databases.write" : "pages.write");
    await requireAccess(q, a, v.parent_id, 3);
    const jid = randomUUID();
    await q.query(
      "INSERT INTO jobs(id,tenant_id,user_id,resource_id,payload) VALUES($1,$2,$3,$4,$5)",
      [jid, a.tenant_id, a.user_id, v.parent_id, json(v)],
    );
    return { id: jid, status: "pending" };
  });
  route(
    "GET",
    "/jobs/:id",
    "Read user-owned import status",
    async (q, a, r) => {
      const j = await one(
        q,
        "SELECT id,user_id,resource_id,status,result FROM jobs WHERE id=$1",
        [id(r)],
      );
      assert(j && j.user_id === a.user_id, 404, "Job not found");
      await requireAccess(q, a, j.resource_id);
      return j;
    },
  );
  route(
    "GET",
    "/resources/:id/export",
    "Export Markdown, CSV or JSON",
    async (q, a, r, reply) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      const format = query(r).format || "markdown";
      await emit(q, a, "export.performed", n.id);
      if (n.kind === "database") {
        const d = await one(
            q,
            "SELECT properties FROM databases WHERE resource_id=$1",
            [n.id],
          ),
          rows = await records(
            q,
            a,
            n.id,
            view.parse({ type: "table" }),
            0,
            10000,
          );
        if (format === "json")
          return { resource: n, schema: d.properties, records: rows };
        assert(format === "csv", 400, "Database export requires CSV or JSON");
        reply
          .type("text/csv")
          .header("Content-Disposition", 'attachment; filename="database.csv"');
        return reply.send(
          stringify(
            rows.map((row) =>
              d.properties.map((p: any) => {
                let v = row.values[p.id] ?? "";
                if (Array.isArray(v)) v = v.join(";");
                return typeof v === "string" && /^[=+\-@\t\r]/.test(v)
                  ? `'${v}`
                  : v;
              }),
            ),
            { header: true, columns: d.properties.map((p: any) => p.name) },
          ),
        );
      }
      const d = await one(
        q,
        "SELECT blocks,plain_text,revision FROM page_documents WHERE resource_id=$1",
        [n.id],
      );
      assert(d, 400, "No exportable body");
      if (format === "json") return { resource: n, content: d };
      assert(
        format === "markdown",
        400,
        "Page export requires Markdown or JSON",
      );
      reply
        .type("text/markdown")
        .header("Content-Disposition", 'attachment; filename="page.md"');
      return reply.send(`# ${n.title}\n\n${await blocksToMarkdown(d.blocks)}`);
    },
  );
}
export function validateWebhook(text: string) {
  const u = new URL(text);
  assert(
    ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      (process.env.WEBHOOK_ALLOWED_ORIGINS || "")
        .split(",")
        .map((v) => v.trim())
        .includes(u.origin),
    400,
    "Webhook origin must be allowlisted by deployment administrator",
  );
  return u;
}
