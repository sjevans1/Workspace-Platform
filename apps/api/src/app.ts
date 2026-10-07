import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { normalizedNetworkIdentity } from "../../../packages/security/rate-network.ts";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import Redis from "ioredis";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as Y from "yjs";
import { z } from "zod";
import { integrationOpenApi } from "../../../packages/contracts/openapi.ts";
import { stringify } from "csv-stringify/sync";
import { Database, one, type Query } from "../../../packages/database/index.ts";
import {
  databasePageFingerprint,
  decodeDatabasePageCursor,
  encodeDatabasePageCursor,
  newDatabasePageCursor,
} from "../../../packages/database/page-cursor.ts";
import { oidcFromEnv, type OidcProvider } from "../../../packages/auth/oidc.ts";
import {
  sealTenantOidcSecret,
  validateTenantOidcRegistration,
} from "../../../packages/auth/tenant-provider.ts";
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
  directChildCanReadSql,
  batchReadableResourceIds,
} from "../../../packages/permissions/index.ts";
import {
  defaultBranding,
  brandingSchema,
} from "../../../packages/branding/index.ts";
import { emit, encrypt } from "../../../packages/events/index.ts";
import {
  beginEventCursor,
  decodeEventCursor,
  encodeEventCursor,
} from "../../../packages/events/cursor.ts";
import {
  beginReconcileCursor,
  decodeReconcileCursor,
  encodeReconcileCursor,
} from "../../../packages/events/reconcile-cursor.ts";
import {
  csvMappingSchema,
  previewCsvImport,
  csvSchemaDigest,
} from "../../../packages/imports/csv.ts";
import {
  templates,
  blocksToMarkdown,
  project,
} from "../../../packages/editor/server.ts";
import { linkedWorkspaceResources } from "../../../packages/editor/links.ts";
import { syncWorkspaceResourceLinks } from "../../../packages/editor/link-index.ts";
import {
  beginLinkReconcileCursor,
  decodeBacklinkPageCursor,
  decodeLinkReconcileCursor,
  encodeBacklinkPageCursor,
  encodeLinkReconcileCursor,
  newBacklinkPageCursor,
  type BacklinkPageCursor,
} from "../../../packages/editor/backlink-cursor.ts";
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
import { registerScim, setScimGroupRoleMapping } from "./scim.ts";
import {
  createResource,
  createRecord,
  records,
  replaceDocument,
  validatePeople,
  treeLock,
  seedDemo,
  purgeDeletedResource,
  duplicateResourceTree,
} from "./domain.ts";
import {
  indexedRecordText,
  validateRelationSchema,
  validateRelationWrites,
} from "./relations.ts";
import { validateFormulaDefinitions } from "../../../packages/formulas/index.ts";
import {
  presentedRecordValues,
  presentedSchema,
  validateRollupDefinitions,
} from "./rollups.ts";
import { exportPortableTree } from "./portable-export.ts";
import {
  inspectPortableArchive,
  portableArchiveLimits,
} from "../../../packages/portable-archive/index.ts";
type Request = FastifyRequest & {
  actor: Actor;
  sessionToken: string;
  // Verified by the global limiter, then reused by the route auth handler.
  rateActor?: Actor;
  rateSessionToken?: string;
};
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

const searchCursorSchema = z
  .object({
    v: z.literal(1),
    tenant: z.uuid(),
    principal: z.uuid(),
    role: z.enum(["owner", "admin", "member", "guest"]),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    limit: z.number().int().min(1).max(50),
    rank: z.number().finite().nonnegative(),
    updated_us: z.string().regex(/^[0-9]{1,20}$/),
    after: z.uuid(),
    issued: z.number().int().nonnegative(),
    expires: z.number().int().positive(),
  })
  .strict();
type SearchCursor = z.infer<typeof searchCursorSchema>;
const searchCursorLifetime = 1800;
function searchCursorKey() {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw new Error("ENCRYPTION_KEY must be configured");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(raw, "hex"),
      Buffer.from("openjm-workspace"),
      Buffer.from("workspace-search-cursor-v1"),
      32,
    ),
  );
}
function encodeSearchCursor(value: SearchCursor) {
  const state = searchCursorSchema.parse(value);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", searchCursorKey(), nonce);
  cipher.setAAD(Buffer.from("openjm-workspace-search-cursor-v1"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return (
    "search-v1." +
    Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url")
  );
}
function decodeSearchCursor(
  token: string,
  context: {
    tenant: string;
    principal: string;
    role: SearchCursor["role"];
    fingerprint: string;
    limit: number;
  },
  now = Math.floor(Date.now() / 1000),
) {
  try {
    if (
      typeof token !== "string" ||
      token.length < 50 ||
      token.length > 2048 ||
      !token.startsWith("search-v1.")
    )
      throw new Error("Invalid cursor");
    const encoded = token.slice("search-v1.".length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid cursor");
    const bytes = Buffer.from(encoded, "base64url");
    if (
      bytes.length < 29 ||
      bytes.length > 1024 ||
      bytes.toString("base64url") !== encoded
    )
      throw new Error("Invalid cursor");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      searchCursorKey(),
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("openjm-workspace-search-cursor-v1"));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const state = searchCursorSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
    if (
      state.tenant !== context.tenant ||
      state.principal !== context.principal ||
      state.role !== context.role ||
      state.fingerprint !== context.fingerprint ||
      state.limit !== context.limit ||
      state.issued > now + 30 ||
      state.expires <= now ||
      state.expires - state.issued !== searchCursorLifetime
    )
      throw new Error("Wrong search cursor scope");
    return state;
  } catch {
    throw new HttpError(400, "Invalid search cursor");
  }
}

async function backlinkPage(
  q: Query,
  a: Actor,
  targetId: string,
  limit: number,
  after?: Pick<BacklinkPageCursor, "after_us" | "after"> | null,
) {
  // Bound the target-index scan first. Full hierarchy ACL is then evaluated
  // once, set-wise, for at most this fixed candidate window. Hidden candidates
  // never materialize titles/document bodies into application memory;
  // canonical content remains the final disclosure authority.
  const scanLimit = Math.min(10000, Math.max(500, limit * 250));
  const allowedKinds = a.scopes
    ? [
        ...(a.scopes.includes("pages.read") ? ["page"] : []),
        ...(a.scopes.includes("databases.read") ? ["record"] : []),
      ]
    : ["page", "record"];
  if (!allowedKinds.length)
    return { items: [], hasMore: false, scanned: 0, after: null };

  const rawValues: any[] = [a.tenant_id, targetId, allowedKinds];
  let continuationSql = "";
  if (after) {
    rawValues.push(after.after_us, after.after);
    continuationSql =
      " AND ((extract(epoch from link.source_updated_at)*1000000)::bigint,link.source_id)<($" +
      (rawValues.length - 1) +
      "::bigint,$" +
      rawValues.length +
      "::uuid)";
  }
  rawValues.push(scanLimit + 1);
  const raw = (
    await q.query(
      "SELECT source.id," +
        " ((extract(epoch from link.source_updated_at)*1000000)::bigint)::text updated_us" +
        " FROM resource_links link" +
        " JOIN resources source ON source.tenant_id=link.tenant_id" +
        " AND source.id=link.source_id" +
        " WHERE link.tenant_id=$1 AND link.target_id=$2" +
        " AND source.deleted_at IS NULL" +
        " AND source.kind=ANY($3::text[])" +
        continuationSql +
        " ORDER BY link.source_updated_at DESC,link.source_id DESC LIMIT $" +
        rawValues.length,
      rawValues,
    )
  ).rows;
  const bounded = raw.slice(0, scanLimit);
  if (!bounded.length)
    return { items: [], hasMore: false, scanned: 0, after: null };

  const readableIds = await batchReadableResourceIds(
    q,
    a,
    bounded.map((candidate: any) => candidate.id),
  );
  const readableRows = readableIds.size
    ? (
        await q.query(
          "SELECT source.id,source.title,source.kind,source.updated_at,d.blocks" +
            " FROM resources source" +
            " JOIN page_documents d ON d.tenant_id=source.tenant_id" +
            " AND d.resource_id=source.id" +
            " WHERE source.id=ANY($1::uuid[])" +
            " AND source.tenant_id=$2" +
            " AND source.deleted_at IS NULL" +
            " AND source.kind=ANY($3::text[])",
          [[...readableIds], a.tenant_id, allowedKinds],
        )
      ).rows
    : [];
  const readable = new Map<string, any>(
    readableRows.map((source: any) => [source.id, source]),
  );

  const items: any[] = [];
  let processed = 0;
  let last: any = null;
  for (const candidate of bounded) {
    processed++;
    last = candidate;
    const source = readable.get(candidate.id);
    if (!source) continue;
    if (!linkedWorkspaceResources(source.blocks).has(targetId)) continue;
    // Recheck through the application evaluator after canonical parsing so a
    // permission change between SQL statements still fails closed.
    if (!(await access(q, a, source.id))) continue;
    items.push({
      id: source.id,
      title: source.title,
      kind: source.kind,
      updated_at: source.updated_at,
    });
    if (items.length === limit) break;
  }
  const hasMore = processed < raw.length;
  return {
    items,
    hasMore,
    scanned: processed,
    after:
      hasMore && last
        ? {
            after_us: String(last.updated_us),
            after: last.id as string,
          }
        : null,
  };
}
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
  // Only a Caddy-controlled, single upstream hop may supply X-Forwarded-For.
  // The Caddy edge overwrites incoming client-supplied forwarding headers.
  // Direct developer launches never trust those headers.
  const proxyMode = process.env.TRUST_PROXY;
  assert(
    !proxyMode || proxyMode === "false" || proxyMode === "1",
    500,
    "TRUST_PROXY must be false or 1 (one sanitized Caddy hop); never true",
  );
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
    // Fastify v5 accepts an explicit trust function; only hop 0 is Caddy.
    // Any additional upstream XFF entries remain untrusted.
    trustProxy:
      proxyMode === "1" ? (_address: string, hop: number) => hop === 0 : false,
    requestIdHeader: false,
  });
  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
    : undefined;
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    // Keep the existing per-network budget for public and sensitive routes.
    // Valid authenticated page/data reads instead use a per-tenant principal
    // budget so coworkers behind a single corporate NAT cannot exhaust each
    // other's allowance. Never trust a user-supplied identity/header/token
    // without verifying the session against the database first.
    max: 300,
    timeWindow: "1 minute",
    ...(redis ? { redis } : {}),
    keyGenerator: async (r) => {
      const networkKey = "ip:" + normalizedNetworkIdentity(r.ip);
      if (
        !["GET", "HEAD"].includes(r.method) ||
        !r.url.startsWith("/api/v1/") ||
        r.url.startsWith("/api/v1/auth/") ||
        r.url.startsWith("/api/v1/setup")
      )
        return networkKey;
      const authorization = r.headers.authorization;
      const isBearer = !!authorization;
      const credential = isBearer
        ? authorization?.startsWith("Bearer ")
          ? authorization.slice(7)
          : ""
        : r.cookies.workspace_session;
      if (!credential) return networkKey;
      try {
        const actor = await authenticate(db, credential);
        // A service token must use Bearer transport; a human session must
        // use its cookie. Transport mismatch is not a verified identity.
        if (isBearer ? !actor.scopes : !!actor.scopes) return networkKey;
        const request = r as Request;
        request.rateActor = actor;
        request.rateSessionToken = credential;
        return "principal:" + actor.tenant_id + ":" + actor.user_id;
      } catch {
        // Forged, expired or revoked sessions must share their actual network
        // key; a caller cannot evade throttling with arbitrary cookie values.
        return networkKey;
      }
    },
  });
  await app.register(multipart, { limits: { fileSize: 26214400, files: 1 } });
  for (const archiveType of [
    "application/zip",
    "application/vnd.openjm.workspace-archive+zip",
  ])
    app.addContentTypeParser(
      archiveType,
      { parseAs: "buffer", bodyLimit: portableArchiveLimits.maxArchiveBytes },
      (_request, payload, done) => done(null, payload),
    );
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
    r.actor =
      r.rateSessionToken === r.sessionToken && r.rateActor
        ? r.rateActor
        : await authenticate(db, r.sessionToken);
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
            user = {
              id: randomUUID(),
              email: profile.email,
              is_service: false,
            };
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
            // Recent is a private visit timeline, not the organisation's
            // latest edits. Re-check active ACLs before returning each item.
            "SELECT r.*,b.visited_at AS viewed_at FROM bookmarks b JOIN resources r" +
              " ON r.tenant_id=b.tenant_id AND r.id=b.resource_id" +
              " WHERE b.user_id=$1 AND r.deleted_at IS NULL" +
              " AND r.kind IN ('page','record','database')" +
              " ORDER BY b.visited_at DESC,r.id DESC LIMIT $2 OFFSET $3",
            [a.user_id, limit, offset],
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
    const template = v.template ? templates[v.template] : undefined;
    assert(!v.template || template, 400, "Unknown template");
    assert(
      !template || template.kind === v.kind,
      400,
      "Template does not match resource type",
    );
    const created = await createResource(q, a, {
      ...v,
      icon: v.icon || template?.icon,
      blocks: template?.blocks || [],
      tasks: template?.tasks === true,
    });
    if (template?.children?.length) {
      for (const child of template.children) {
        scope(a, pageScope(child.kind, true));
        const childTemplate = child.template
          ? templates[child.template]
          : undefined;
        assert(
          !childTemplate || childTemplate.kind === child.kind,
          500,
          "Invalid built-in child template",
        );
        await createResource(q, a, {
          kind: child.kind,
          parent_id: created.id,
          title: child.title,
          icon: child.icon || childTemplate?.icon,
          blocks: childTemplate?.blocks || [],
          tasks: childTemplate?.tasks === true,
        });
      }
    }
    return created;
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
    "GET",
    "/resources/:id/backlinks",
    "List readable backlinks with opaque bounded pagination",
    async (q, a, r) => {
      const target = await requireAccess(q, a, id(r));
      scope(a, pageScope(target.kind));
      assert(["page", "record"].includes(target.kind), 404, "Page not found");
      const p = query(r);
      const limit = p.limit === undefined ? 20 : Number(p.limit);
      assert(
        Number.isInteger(limit) && limit >= 1 && limit <= 40,
        400,
        "Invalid backlink page limit",
      );
      const state = p.cursor
        ? decodeBacklinkPageCursor(p.cursor, {
            tenant: a.tenant_id,
            principal: a.user_id,
            target: target.id,
            limit,
          })
        : null;
      const page = await backlinkPage(q, a, target.id, limit, state);
      const next =
        page.hasMore && page.after
          ? encodeBacklinkPageCursor(
              newBacklinkPageCursor(
                a.tenant_id,
                a.user_id,
                target.id,
                limit,
                page.after.after_us,
                page.after.after,
              ),
            )
          : null;
      return {
        items: page.items,
        next_cursor: next,
        has_more: page.hasMore,
      };
    },
  );
  route(
    "POST",
    "/resource-links/reconcile",
    "Rebuild tenant link-index batches from canonical documents",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z
          .object({
            cursor: z.string().min(1).max(2048).optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .strict(),
        r,
      );
      const limit = v.limit ?? 100;
      const state = v.cursor
        ? decodeLinkReconcileCursor(v.cursor, a.tenant_id, a.user_id)
        : beginLinkReconcileCursor(a.tenant_id, a.user_id);
      const rows = (
        await q.query(
          "SELECT d.resource_id,d.blocks FROM page_documents d" +
            " JOIN resources r ON r.tenant_id=d.tenant_id AND r.id=d.resource_id" +
            " WHERE d.tenant_id=$1 AND d.resource_id>$2::uuid" +
            " AND r.kind IN ('page','record')" +
            " ORDER BY d.resource_id LIMIT $3",
          [a.tenant_id, state.after, limit + 1],
        )
      ).rows;
      const batch = rows.slice(0, limit);
      for (const row of batch)
        await syncWorkspaceResourceLinks(
          q,
          a.tenant_id,
          row.resource_id,
          row.blocks,
        );
      const hasMore = rows.length > limit;
      const last = batch.at(-1)?.resource_id || state.after;
      return {
        processed: batch.length,
        next_cursor: hasMore
          ? encodeLinkReconcileCursor({ ...state, after: last })
          : null,
        has_more: hasMore,
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
    "Safely duplicate a page, database or space subtree",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required for subtree duplication");
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind, true));
      const v = body(z.object({ parent_id: uuid.optional() }).strict(), r);
      return duplicateResourceTree(q, a, n.id, v.parent_id);
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
  route("GET", "/retention", "Read trash retention policy", async (q, a) => {
    admin(a);
    return one(
      q,
      "SELECT trash_retention_days FROM organisations WHERE id=$1",
      [a.tenant_id],
    );
  });
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
    "Ranked, permission-safe workspace search",
    async (q, a, r) => {
      const p = query(r),
        term = (p.q || "").trim().slice(0, 200),
        filter = String(p.kind || "all");
      assert(
        ["all", "page", "record", "database", "file"].includes(filter),
        400,
        "Unsupported search kind",
      );
      const size = p.limit === undefined ? 20 : Number(p.limit);
      assert(
        Number.isSafeInteger(size) && size >= 1 && size <= 50,
        400,
        "Search page limit must be an integer from 1 to 50",
      );
      if (!term) return { items: [], next_cursor: null, has_more: false };

      const resourceKinds =
        filter === "all"
          ? ["space", "page", "database", "record"]
          : filter === "file"
            ? []
            : [filter];
      const scopedKinds = resourceKinds.filter(
        (kind) => !a.scopes || a.scopes.includes(pageScope(kind)),
      );
      const includeFiles =
        (filter === "all" || filter === "file") &&
        (!a.scopes || a.scopes.includes("files.read"));
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            term,
            filter,
            kinds: scopedKinds,
            files: includeFiles,
            scopes: [...(a.scopes || [])].sort(),
          }),
        )
        .digest("hex");
      const state =
        p.cursor === undefined
          ? null
          : decodeSearchCursor(String(p.cursor), {
              tenant: a.tenant_id,
              principal: a.user_id,
              role: a.role,
              fingerprint,
              limit: size,
            });
      const escaped = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const binds: any[] = [
        term,
        escaped,
        scopedKinds,
        a.user_id,
        a.role,
        includeFiles,
      ];
      let continuation = "";
      if (state) {
        binds.push(state.rank, state.updated_us, state.after);
        continuation =
          " AND (rank,updated_at,id)<($" +
          (binds.length - 2) +
          "::double precision,to_timestamp($" +
          (binds.length - 1) +
          "::bigint/1000000.0),$" +
          binds.length +
          "::uuid)";
      }
      binds.push(size + 1);
      const rows = (
        await q.query(
          "WITH candidates AS MATERIALIZED (" +
            " SELECT r.id,r.id resource_id,r.title,r.kind,r.updated_at," +
            " CASE WHEN r.search_text='' THEN '' ELSE left(r.search_text,240) END snippet," +
            " round((CASE WHEN lower(r.title)=lower($1) THEN 3.0" +
            " WHEN r.title ILIKE $2 ESCAPE '\\' THEN 2.0 ELSE 0.0 END +" +
            " ts_rank_cd(to_tsvector('simple',r.title||' '||r.search_text)," +
            " websearch_to_tsquery('simple',$1)))::numeric,6)::double precision rank" +
            " FROM resources r WHERE cardinality($3::text[])>0" +
            " AND r.kind=ANY($3::text[]) AND r.deleted_at IS NULL" +
            " AND (to_tsvector('simple',r.title||' '||r.search_text)" +
            " @@websearch_to_tsquery('simple',$1) OR r.title ILIKE $2 ESCAPE '\\')" +
            " UNION ALL" +
            " SELECT f.id,f.resource_id,f.name,'file',f.created_at,'' snippet," +
            " (CASE WHEN lower(f.name)=lower($1) THEN 3.0 ELSE 2.0 END)::double precision rank" +
            " FROM files f WHERE $6::boolean AND f.deleted_at IS NULL" +
            " AND f.name ILIKE $2 ESCAPE '\\'" +
            " AND workspace_can_read_resource(f.resource_id,$4::uuid,$5::text)" +
            ")" +
            " SELECT id,resource_id,title,kind,snippet,updated_at,rank," +
            " ((extract(epoch from updated_at)*1000000)::bigint)::text updated_us" +
            // Text filtering runs first inside the materialized candidates step
            // so the GIN text index bounds the row set; the per-row ACL
            // predicate then applies only to text-matched candidates. Files are
            // ACL-checked inside their branch (their permission anchors on
            // resource_id, not the file id).
            " FROM candidates WHERE kind='file'" +
            " OR workspace_can_read_resource(id,$4::uuid,$5::text)" +
            continuation +
            " ORDER BY rank DESC,updated_at DESC,id DESC LIMIT $" +
            binds.length,
          binds,
        )
      ).rows;
      const items = rows.slice(0, size).map((row: any) => ({
        id: row.id,
        resource_id: row.resource_id,
        title: row.title,
        kind: row.kind,
        snippet: row.snippet,
        updated_at: row.updated_at,
      }));
      const hasMore = rows.length > size;
      const tail = rows[size - 1];
      const now = Math.floor(Date.now() / 1000);
      const nextCursor =
        hasMore && tail
          ? encodeSearchCursor(
              searchCursorSchema.parse({
                v: 1,
                tenant: a.tenant_id,
                principal: a.user_id,
                role: a.role,
                fingerprint,
                limit: size,
                rank: Number(tail.rank),
                updated_us: String(tail.updated_us),
                after: tail.id,
                issued: now,
                expires: now + searchCursorLifetime,
              }),
            )
          : null;
      return { items, next_cursor: nextCursor, has_more: hasMore };
    },
  );
  route(
    "GET",
    "/templates",
    "List built-in templates",
    async () =>
      Object.entries(templates).map(([id, t]) => ({
        id,
        title: t.title,
        description: t.description,
        icon: t.icon,
        kind: t.kind,
      })),
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
        properties: await presentedSchema(q, a, d.properties),
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
    "GET",
    "/databases/:id/relation-targets",
    "Discover readable relation target databases",
    async (q, a, r) => {
      const source = await requireAccess(q, a, id(r));
      assert(source.kind === "database", 404, "Database not found");
      const params = query(r),
        search = String(params.search || "")
          .slice(0, 120)
          .toLowerCase(),
        limit = Math.min(50, Math.max(1, Number(params.limit) || 20)),
        offset = Math.max(0, Math.min(10000, Number(params.offset) || 0));
      // Execute visibility inside SQL BEFORE sorting and paging; select one
      // extra permitted row to compute has_more without exposing hidden rows.
      const rows = (
        await q.query(
          "SELECT id,title FROM resources WHERE kind='database'" +
            " AND deleted_at IS NULL AND id<>$1" +
            " AND position($2 in lower(title))>0" +
            " AND workspace_can_read_resource(id,$3::uuid,$4::text)" +
            " ORDER BY lower(title),id LIMIT $5 OFFSET $6",
          [source.id, search, a.user_id, a.role, limit + 1, offset],
        )
      ).rows;
      const readable = await visible(q, a, rows);
      return {
        items: readable
          .slice(0, limit)
          .map((item) => ({ id: item.id, title: item.title })),
        next_offset: offset + limit,
        has_more: readable.length > limit,
      };
    },
    "databases.read",
  );
  route(
    "GET",
    "/databases/:id/relation-candidates",
    "Find or resolve accessible related records",
    async (q, a, r) => {
      const source = await requireAccess(q, a, id(r));
      assert(source.kind === "database", 404, "Database not found");
      const definition = await one(
        q,
        "SELECT properties FROM databases WHERE resource_id=$1",
        [source.id],
      );
      const params = query(r),
        field = definition?.properties.find(
          (p: any) => p.id === params.property && p.type === "relation",
        );
      assert(field?.target_database_id, 404, "Relation unavailable");
      const target = await requireAccess(q, a, field.target_database_id);
      assert(target.kind === "database", 404, "Target unavailable");
      const limit = Math.min(40, Math.max(1, Number(params.limit) || 20)),
        offset = Math.max(0, Math.min(10000, Number(params.offset) || 0));
      if (params.selected) {
        const chosen = String(params.selected).split(",");
        assert(chosen.length <= 20, 400, "Too many selected records");
        const ids = chosen.map((value) => uuid.parse(value));
        const rows = (
          await q.query(
            "SELECT id,title FROM resources WHERE id=ANY($1::uuid[])" +
              " AND parent_id=$2 AND kind='record' AND deleted_at IS NULL",
            [ids, target.id],
          )
        ).rows;
        return {
          items: (await visible(q, a, rows)).map((item) => ({
            id: item.id,
            title: item.title,
          })),
          next_offset: 0,
          has_more: false,
        };
      }
      const search = String(params.search || "")
        .slice(0, 120)
        .toLowerCase();
      // Source target database has been permission checked. Every candidate
      // record is an immediate child; use indexed personal/wildcard grants
      // instead of re-running ancestry for all search matches.
      const bind: any[] = [target.id, search];
      let gate = "TRUE";
      if (a.role === "member" || a.role === "guest") {
        bind.push(a.tenant_id, a.user_id, target.effective_permission);
        gate = directChildCanReadSql(
          "r",
          a.role,
          bind.length - 2,
          bind.length - 1,
          bind.length,
        );
      } else {
        assert(
          a.role === "owner" || a.role === "admin",
          403,
          "Unknown membership role",
        );
      }
      bind.push(limit + 1, offset);
      // Bind positions must be continuous for both member and admin; no
      // unused untyped parameters in the trusted owner fast path.
      const sql =
        "SELECT r.id,r.title FROM resources r" +
        " WHERE r.kind='record' AND r.parent_id=$1" +
        " AND r.deleted_at IS NULL" +
        " AND position($2 in lower(r.title))>0" +
        " AND " +
        gate +
        " ORDER BY lower(r.title),r.id LIMIT $" +
        String(bind.length - 1) +
        " OFFSET $" +
        String(bind.length);
      const rows = (await q.query(sql, bind)).rows;
      // Defense in depth; visible() must agree with the SQL predicate.
      const readable = await visible(q, a, rows);
      return {
        items: readable
          .slice(0, limit)
          .map((item) => ({ id: item.id, title: item.title })),
        next_offset: offset + limit,
        has_more: readable.length > limit,
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
      await validateRelationSchema(q, a, id(r), v.properties);
      validateFormulaDefinitions(v.properties);
      await validateRollupDefinitions(q, a, v.properties);
      for (const row of (
        await q.query(
          "SELECT values FROM database_records WHERE database_id=$1",
          [id(r)],
        )
      ).rows) {
        const existing = validateValues(v.properties, row.values);
        await validateRelationWrites(q, a, v.properties, existing);
      }
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
    "/databases/:id/records/page",
    "Read permission-filtered database records with an encrypted keyset cursor",
    async (q, a, r) => {
      const params = query(r),
        databaseId = id(r);
      assert(
        Object.keys(params).every((key) =>
          ["view", "month", "limit", "cursor"].includes(key),
        ),
        400,
        "Unsupported database cursor query parameter",
      );
      const size = params.limit === undefined ? 100 : Number(params.limit);
      assert(
        Number.isSafeInteger(size) && size >= 1 && size <= 200,
        400,
        "Cursor page limit must be an integer from 1 to 200",
      );
      let config = view.parse({ type: "table" });
      const viewId = params.view ? uuid.parse(params.view) : null;
      if (viewId) {
        const stored = await one(
          q,
          "SELECT config FROM database_views WHERE id=$1 AND database_id=$2",
          [viewId, databaseId],
        );
        assert(stored, 404, "View not found");
        config = view.parse(stored.config);
      }
      // Only scalar values with a deterministic text/numeric SQL order are
      // permitted in encrypted cursor sorts. Relation/derived values could
      // leak unreadable data if sorted by raw JSON, and lists are not scalar.
      const definition = await one(
        q,
        "SELECT properties FROM databases WHERE resource_id=$1",
        [databaseId],
      );
      // A continuation for a foreign/hidden database must not distinguish
      // cross-tenant resource presence from an invalid encrypted cursor.
      // First-page requests retain their ordinary 404 resource behavior.
      if (!definition && params.cursor !== undefined)
        throw new HttpError(400, "Invalid database page cursor");
      assert(definition, 404, "Database unavailable");
      const allowedSortTypes = new Set([
        "title",
        "text",
        "number",
        "select",
        "status",
        "date",
        "checkbox",
        "url",
        "email",
      ]);
      const sortFields = config.sort.map((term: any) => {
        const property = definition.properties.find(
          (field: any) => field.id === term.property,
        );
        assert(
          property && allowedSortTypes.has(property.type),
          400,
          "Cursor sorting requires readable scalar properties",
        );
        return {
          id: property.id,
          type: property.type,
          direction: term.direction,
        };
      });
      if (config.type === "calendar") {
        assert(
          typeof params.month === "string" &&
            /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(params.month),
          400,
          "Calendar view requires YYYY-MM month",
        );
        await requireAccess(q, a, databaseId);
        assert(
          definition.properties.some(
            (field: any) => field.id === config.dateBy && field.type === "date",
          ),
          400,
          "Calendar view requires a valid date property",
        );
        const begin = new Date(params.month + "-01T00:00:00.000Z");
        const last = new Date(begin.getTime() - 86400000)
          .toISOString()
          .slice(0, 10);
        const next = new Date(
          Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth() + 1, 1),
        )
          .toISOString()
          .slice(0, 10);
        config = {
          ...config,
          filters: [
            ...config.filters,
            { property: config.dateBy!, op: "after", value: last },
            { property: config.dateBy!, op: "before", value: next },
          ],
        };
      } else {
        assert(
          params.month === undefined,
          400,
          "Month filter requires a calendar view",
        );
      }
      // Bind both view configuration and current sort property types.
      // A schema change invalidates old tokens even if view JSON is stable.
      const fingerprint = databasePageFingerprint(
        { ...config, sortFields },
        params.month,
      );
      const state =
        params.cursor === undefined
          ? null
          : decodeDatabasePageCursor(params.cursor, {
              tenant: a.tenant_id,
              principal: a.user_id,
              role: a.role,
              database: databaseId,
              view: viewId,
              fingerprint,
              limit: size,
            });
      const pageRows = await records(
        q,
        a,
        databaseId,
        config,
        0,
        size + 1,
        state
          ? {
              position: state.position,
              id: state.after,
              sort_values: state.sort_values,
            }
          : undefined,
      );
      const hasMore = pageRows.length > size;
      const items = pageRows.slice(0, size);
      const tail = items.at(-1);
      assert(
        !hasMore || (tail && Number.isFinite(tail.position)),
        500,
        "Invalid database record position",
      );
      const sortValues = tail
        ? sortFields.map((field: any) => {
            const value = tail.values[field.id];
            if (value === undefined || value === null) return null;
            if (field.type === "number") {
              assert(
                typeof value === "number" && Number.isFinite(value),
                400,
                "Cursor numeric value is invalid",
              );
              return value;
            }
            assert(
              ["string", "boolean"].includes(typeof value),
              400,
              "Unsupported cursor sort value",
            );
            const scalar = String(value);
            assert(
              scalar.length <= 512,
              400,
              "Sort value too large for encrypted cursor",
            );
            return scalar;
          })
        : [];
      assert(
        JSON.stringify(sortValues).length <= 900,
        400,
        "Sort keys exceed encrypted cursor size budget",
      );
      const nextCursor =
        hasMore && tail
          ? encodeDatabasePageCursor(
              newDatabasePageCursor(
                a.tenant_id,
                a.user_id,
                a.role,
                databaseId,
                viewId,
                fingerprint,
                size,
                tail.position,
                tail.id,
                undefined,
                sortValues,
              ),
            )
          : null;
      return { items, next_cursor: nextCursor, has_more: hasMore };
    },
    "databases.read",
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
      if (c.type === "calendar") {
        assert(
          typeof p.month === "string" &&
            /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(p.month),
          400,
          "Calendar view requires YYYY-MM month",
        );
        await requireAccess(q, a, id(r));
        const definition = await one(
          q,
          "SELECT properties FROM databases WHERE resource_id=$1",
          [id(r)],
        );
        assert(
          definition?.properties.some(
            (field: any) => field.id === c.dateBy && field.type === "date",
          ),
          400,
          "Calendar view requires a valid date property",
        );
        const start = new Date(p.month + "-01T00:00:00.000Z"),
          previous = new Date(start.getTime() - 86400000)
            .toISOString()
            .slice(0, 10),
          next = new Date(
            Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
          )
            .toISOString()
            .slice(0, 10);
        c = {
          ...c,
          filters: [
            ...c.filters,
            { property: c.dateBy!, op: "after", value: previous },
            { property: c.dateBy!, op: "before", value: next },
          ],
        };
      } else {
        assert(!p.month, 400, "Month filter requires a calendar view");
      }
      const requestedOffset = p.offset === undefined ? 0 : Number(p.offset);
      assert(
        Number.isSafeInteger(requestedOffset) &&
          requestedOffset >= 0 &&
          requestedOffset <= 50000,
        400,
        "Database page offset must be an integer from 0 to 50000",
      );
      return records(
        q,
        a,
        id(r),
        c,
        requestedOffset,
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
      return {
        ...n,
        ...v,
        properties: await presentedSchema(q, a, v.properties),
        values: await presentedRecordValues(q, a, v.properties, v.values),
      };
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
      await validateRelationWrites(q, a, d.properties, v.values);
      await q.query(
        "UPDATE database_records SET values=$2,revision=revision+1 WHERE resource_id=$1",
        [n.id, json(values)],
      );
      await q.query(
        "UPDATE resources SET title=$2,search_text=$3,updated_at=now(),updated_by=$4 WHERE id=$1",
        [
          n.id,
          values[d.properties.find((p: any) => p.type === "title").id],
          indexedRecordText(d.properties, values),
          a.user_id,
        ],
      );
      await emit(q, a, "record.updated", n.id, d.revision + 1);
      return {
        ...n,
        values: await presentedRecordValues(q, a, d.properties, values),
        revision: d.revision + 1,
      };
    },
    "databases.write",
  );
  for (const method of ["POST", "PATCH"] as const)
    route(
      method,
      `/databases/:id/views${method === "PATCH" ? "/:view" : ""}`,
      "Save a table, board or calendar view",
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
        for (const field of [...v.config.filters, ...v.config.sort])
          assert(
            !["relation", "formula", "rollup"].includes(
              d.properties.find((p: any) => p.id === field.property)?.type,
            ),
            400,
            "Relation sorting/filtering requires permission-aware indexing",
          );
        for (const k of [
          ...v.config.filters.map((f) => f.property),
          ...v.config.sort.map((s) => s.property),
          ...(v.config.visible || []),
          ...(v.config.order || []),
          ...(v.config.dateBy ? [v.config.dateBy] : []),
        ])
          assert(keys.includes(k), 400, "Unknown view property");
        if (v.config.type === "calendar")
          assert(
            d.properties.some(
              (p: any) => p.id === v.config.dateBy && p.type === "date",
            ),
            400,
            "Calendar view requires a date property",
          );
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
              block_id: uuid.optional(),
              expected_revision: z.number().int().nonnegative().optional(),
              reply_to: uuid.optional(),
            })
            .strict(),
          r,
        ),
        cid = randomUUID();
      const parent = v.reply_to
        ? await one(
            q,
            "SELECT id,author_id,block_id,parent_comment_id,resolved FROM comments WHERE tenant_id=$1 AND resource_id=$2 AND id=$3 FOR SHARE",
            [a.tenant_id, n.id, v.reply_to],
          )
        : null;
      if (v.reply_to) {
        assert(parent, 404, "Comment not found");
        assert(
          parent.parent_comment_id === null,
          400,
          "Reply to a root discussion, not another reply",
        );
        assert(!parent.resolved, 409, "Discussion resolved");
        assert(
          !v.block_id && v.expected_revision === undefined,
          400,
          "Replies inherit their parent anchor",
        );
      }
      // A supplied block anchor is a resource-owned *canonical Yjs block ID*.
      // Never accept an arbitrary or neighbouring DOM selector: a guessed
      // UUID can otherwise misdirect discussion into a different page.
      if (v.block_id) {
        assert(
          ["page", "record"].includes(n.kind),
          400,
          "Anchored comments require a page",
        );
        assert(
          v.expected_revision !== undefined,
          400,
          "Anchored comments require the current page revision",
        );
        // Keep the authenticated document stable until this comment commits:
        // page replacement takes a conflicting row lock.
        const current = await one(
          q,
          "SELECT revision,y_state FROM page_documents WHERE resource_id=$1 FOR SHARE",
          [n.id],
        );
        assert(current, 404, "Block not found");
        assert(
          current.revision === v.expected_revision,
          409,
          "Page changed; select the block again",
        );
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, current.y_state);
          const blocks = project(doc).blocks;
          const contains = (items: any[]): boolean =>
            items.some(
              (block) =>
                block.id === v.block_id ||
                contains(Array.isArray(block.children) ? block.children : []),
            );
          assert(contains(blocks), 404, "Block not found");
        } finally {
          doc.destroy();
        }
      } else {
        assert(
          v.expected_revision === undefined,
          400,
          "A revision is only valid with a block anchor",
        );
      }
      const inheritedAnchor = parent?.block_id ?? v.block_id ?? null;
      await q.query(
        "INSERT INTO comments(id,tenant_id,resource_id,author_id,body,block_id,parent_comment_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          cid,
          a.tenant_id,
          n.id,
          a.user_id,
          v.body,
          inheritedAnchor,
          parent?.id ?? null,
        ],
      );
      // Deduplicate @mention and thread-owner notifications inside the
      // comment transaction; never notify revoked or unauthorized members.
      const delivered = new Set<string>();
      const notifyMember = async (
        recipient: string,
        message: string,
        kind: "mention" | "reply",
      ) => {
        if (delivered.has(recipient)) return;
        const member = await one(
          q,
          "SELECT role FROM memberships WHERE user_id=$1 AND active",
          [recipient],
        );
        if (
          !member ||
          !(await access(
            q,
            { ...a, user_id: recipient, role: member.role },
            n.id,
          ))
        )
          return;
        const preferences = await one(
          q,
          "SELECT mentions_enabled,replies_enabled FROM notification_preferences WHERE user_id=$1",
          [recipient],
        );
        // No preference row means both are on (preserving prior behavior).
        if (kind === "mention" && preferences?.mentions_enabled === false)
          return;
        if (kind === "reply" && preferences?.replies_enabled === false) return;
        await q.query(
          "INSERT INTO notifications(id,tenant_id,user_id,resource_id,message) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), a.tenant_id, recipient, n.id, message],
        );
        delivered.add(recipient);
      };
      for (const mention of v.body.matchAll(/@\{([0-9a-f-]{36})\}/g)) {
        await notifyMember(
          mention[1],
          `${a.name} mentioned you in ${n.title}`,
          "mention",
        );
      }
      if (parent?.author_id && parent.author_id !== a.user_id) {
        await notifyMember(
          parent.author_id,
          `${a.name} replied to your comment in ${n.title}`,
          "reply",
        );
      }
      await emit(q, a, "comment.created", n.id);
      // Preserve W11a's legacy response contract: no new block_id key for
      // unanchored root comments. A reply explicitly carries its inherited
      // anchor and parent ID, even when that anchor was later orphaned.
      return {
        id: cid,
        ...v,
        ...(parent
          ? { block_id: inheritedAnchor, parent_comment_id: parent.id }
          : { parent_comment_id: null }),
      };
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
  route("GET", "/scim/connectors", "List SCIM connectors", async (q, a) => {
    admin(a);
    return (
      await q.query(
        "SELECT id,label,default_role,created_at,last_used_at,revoked_at FROM scim_connectors ORDER BY created_at DESC",
      )
    ).rows;
  });
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
        warning:
          "This token is shown once. Store it in the identity provider secret store.",
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
      await setScimGroupRoleMapping(q, a.tenant_id, id(r), v.role, a.user_id);
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

  route(
    "PATCH",
    "/notifications/:notice",
    "Set own visible notification read state",
    async (q, a, r) => {
      const noticeId = id(r, "notice");
      const v = body(z.object({ read: z.boolean() }).strict(), r);
      const notice = await one(
        q,
        "SELECT id,resource_id FROM notifications WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [noticeId, a.user_id],
      );
      assert(notice, 404, "Notification not found");
      // An old notification identifier never conveys a lasting capability.
      // Reauthorize against the resource on every mutation, just like GET.
      await requireAccess(q, a, notice.resource_id);
      const updated = await one(
        q,
        "UPDATE notifications SET read_at=CASE WHEN $3::boolean THEN COALESCE(read_at,now()) ELSE NULL END WHERE id=$1 AND user_id=$2 RETURNING id,read_at",
        [noticeId, a.user_id, v.read],
      );
      assert(updated, 404, "Notification not found");
      return updated;
    },
  );

  route(
    "GET",
    "/notification-preferences",
    "Read own notification preferences",
    async (q, a) => {
      const saved = await one(
        q,
        "SELECT mentions_enabled,replies_enabled FROM notification_preferences WHERE user_id=$1",
        [a.user_id],
      );
      return {
        mentions_enabled: saved?.mentions_enabled ?? true,
        replies_enabled: saved?.replies_enabled ?? true,
      };
    },
  );
  route(
    "PATCH",
    "/notification-preferences",
    "Update own notification preferences",
    async (q, a, r) => {
      const choices = body(
        z
          .object({
            mentions_enabled: z.boolean(),
            replies_enabled: z.boolean(),
          })
          .strict(),
        r,
      );
      const saved = await one(
        q,
        "INSERT INTO notification_preferences(tenant_id,user_id,mentions_enabled,replies_enabled) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,user_id) DO UPDATE SET mentions_enabled=EXCLUDED.mentions_enabled,replies_enabled=EXCLUDED.replies_enabled,updated_at=now() RETURNING mentions_enabled,replies_enabled",
        [
          a.tenant_id,
          a.user_id,
          choices.mentions_enabled,
          choices.replies_enabled,
        ],
      );
      return saved;
    },
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
    "/events/cursor",
    "Page through permission-filtered integration events",
    async (q, a, r) => {
      const p = query(r);
      assert(!(p.cursor && p.since), 400, "Provide cursor or since, not both");
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(100)
        .parse(p.limit);
      const marker = p.cursor
        ? decodeEventCursor(p.cursor, a.tenant_id, a.user_id)
        : beginEventCursor(a.tenant_id, a.user_id, p.since);

      // Keyset scan is ordered by the original PostgreSQL microsecond
      // timestamp and UUID. Convert cursor timestamps in SQL, not JavaScript:
      // JS Dates truncate microseconds and can repeat a full page indefinitely.
      const scanned = (
        await q.query(
          "SELECT id,tenant_id,type,resource_id,version,created_at," +
            " to_char(created_at AT TIME ZONE 'UTC'," +
            ' \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS cursor_at' +
            " FROM event_outbox" +
            " WHERE tenant_id=$1 AND (created_at,id)>($2::timestamptz,$3::uuid)" +
            " ORDER BY created_at,id LIMIT $4",
          [a.tenant_id, marker.at, marker.id, limit + 1],
        )
      ).rows;
      const batch = scanned.slice(0, limit);
      const events = [];
      for (const event of batch) {
        if (
          !event.resource_id ||
          !(await access(q, a, event.resource_id, true))
        )
          continue;
        events.push({
          id: event.id,
          tenant_id: event.tenant_id,
          type: event.type,
          resource_id: event.resource_id,
          version: event.version,
          created_at: event.created_at,
        });
      }
      const last = batch.at(-1);
      return {
        events,
        next_cursor: encodeEventCursor(
          last ? { ...marker, at: last.cursor_at, id: last.id } : marker,
        ),
        has_more: scanned.length > limit,
      };
    },
    "events.read",
  );
  route(
    "GET",
    "/events/reconcile",
    "Scan currently accessible resource references for integration reconciliation",
    async (q, a, r) => {
      const p = query(r);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .parse(p.limit);
      const state = p.cursor
        ? decodeReconcileCursor(p.cursor, a.tenant_id, a.user_id)
        : beginReconcileCursor(a.tenant_id, a.user_id);

      // The query consumes bounded raw scan positions under enforced tenant
      // RLS, even for inaccessible resources. Never put scanned IDs or
      // inaccessible totals in the response or an unencrypted cursor.
      const scanned = (
        await q.query(
          "SELECT id,kind,parent_id,updated_at FROM resources" +
            " WHERE tenant_id=$1 AND id>$2::uuid AND deleted_at IS NULL" +
            " ORDER BY id LIMIT $3",
          [a.tenant_id, state.after, limit + 1],
        )
      ).rows;
      const batch = scanned.slice(0, limit);
      const resources = [];
      for (const item of batch) {
        if (a.scopes && !a.scopes.includes(pageScope(item.kind))) continue;
        if (!(await access(q, a, item.id))) continue;
        resources.push({
          id: item.id,
          kind: item.kind,
          parent_id: item.parent_id,
          updated_at: item.updated_at,
        });
      }
      const last = batch.at(-1);
      return {
        resources,
        next_cursor: encodeReconcileCursor({
          ...state,
          after: last?.id || state.after,
        }),
        has_more: scanned.length > limit,
      };
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
            "SELECT id,url,events,active,signing_revision," +
              " pending_secret_encrypted IS NOT NULL AS rotation_pending" +
              " FROM webhook_subscriptions",
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
  route(
    "POST",
    "/webhooks/:id/secret-rotation",
    "Prepare a one-time webhook signing secret without activating it",
    async (q, a, r) => {
      admin(a);
      const v = body(
        z.object({ expected_revision: z.number().int().positive() }).strict(),
        r,
      );
      const subscriptionId = id(r);
      const current = await one(
        q,
        "SELECT signing_revision,pending_secret_encrypted FROM webhook_subscriptions" +
          " WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [subscriptionId, a.tenant_id],
      );
      assert(current, 404, "Webhook not found");
      assert(
        current.signing_revision === v.expected_revision &&
          !current.pending_secret_encrypted,
        409,
        "Webhook rotation changed; reload before preparing a secret",
      );
      const secret = token();
      const next = await one(
        q,
        "UPDATE webhook_subscriptions SET pending_secret_encrypted=$2," +
          " signing_revision=signing_revision+1 WHERE id=$1" +
          " RETURNING signing_revision",
        [subscriptionId, encrypt(secret)],
      );
      await emit(q, a, "integration.secret_prepared", subscriptionId);
      return {
        id: subscriptionId,
        secret,
        signing_revision: next.signing_revision,
        rotation_pending: true,
      };
    },
  );
  for (const [method, suffix, activate] of [
    ["POST", "/activate", true],
    ["DELETE", "", false],
  ] as const) {
    route(
      method,
      "/webhooks/:id/secret-rotation" + suffix,
      activate
        ? "Activate a prepared webhook signing secret"
        : "Discard a prepared webhook signing secret",
      async (q, a, r) => {
        admin(a);
        const v = body(
          z.object({ expected_revision: z.number().int().positive() }).strict(),
          r,
        );
        const subscriptionId = id(r);
        const current = await one(
          q,
          "SELECT signing_revision,pending_secret_encrypted FROM webhook_subscriptions" +
            " WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
          [subscriptionId, a.tenant_id],
        );
        assert(current, 404, "Webhook not found");
        assert(
          current.signing_revision === v.expected_revision &&
            current.pending_secret_encrypted,
          409,
          "Prepared webhook secret changed; reload before continuing",
        );
        if (activate) {
          // Preserve the accepted rotation contract without holding the
          // worker's tenant transaction across network I/O. This activation
          // transaction already owns the subscription row; new claims block
          // on FOR SHARE, while an already-leased delivery may finalize
          // independently because finalization touches only the delivery row.
          // Wait through the normal 10s HTTP timeout, then fail closed if a
          // crashed worker still owns an unexpired lease.
          let leased;
          for (let attempt = 0; attempt < 120; attempt++) {
            leased = await one(
              q,
              "SELECT id FROM webhook_deliveries" +
                " WHERE subscription_id=$1 AND tenant_id=$2" +
                " AND status IN ('pending','retry')" +
                " AND lease_token IS NOT NULL AND lease_expires_at>now()" +
                " LIMIT 1",
              [subscriptionId, a.tenant_id],
            );
            if (!leased) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert(
            !leased,
            409,
            "Webhook delivery in progress; retry secret activation",
          );
        }
        const next = await one(
          q,
          "UPDATE webhook_subscriptions SET" +
            (activate ? " secret_encrypted=pending_secret_encrypted," : "") +
            " pending_secret_encrypted=NULL,signing_revision=signing_revision+1" +
            " WHERE id=$1 RETURNING signing_revision",
          [subscriptionId],
        );
        await emit(
          q,
          a,
          activate
            ? "integration.secret_activated"
            : "integration.secret_discarded",
          subscriptionId,
        );
        return {
          ok: true,
          id: subscriptionId,
          signing_revision: next.signing_revision,
          rotation_pending: false,
        };
      },
    );
  }
  route(
    "POST",
    "/webhooks/deliveries/:id/replay",
    "Requeue a dead webhook delivery for the same subscription",
    async (q, a, r) => {
      // A deliberate administrator action: never send webhooks inline from
      // the request, and never reset a delivery that may already be in flight.
      admin(a);
      const deliveryId = id(r);
      const resumed = await q.query(
        "UPDATE webhook_deliveries AS d" +
          " SET status='pending',attempts=0,next_at=now(),last_error=NULL," +
            " lease_token=NULL,lease_expires_at=NULL" +
          " FROM webhook_subscriptions AS s" +
          " WHERE d.id=$1 AND d.tenant_id=$2" +
          " AND d.subscription_id=s.id AND s.tenant_id=$2" +
          " AND s.active=true AND d.status='dead'" +
          " RETURNING d.id",
        [deliveryId, a.tenant_id],
      );
      // Uniform 404 avoids leaking whether a delivery exists in another
      // tenant, is not dead, or belongs to an inactive subscription.
      assert(resumed.rowCount, 404, "Replayable delivery not found");
      await emit(q, a, "integration.delivery_replayed", null);
      return { ok: true, id: deliveryId, status: "pending" };
    },
  );
  route(
    "POST",
    "/imports/preview",
    "Validate and preview a bounded CSV without writes",
    async (q, a, r) => {
      const request = body(
        z
          .object({
            parent_id: uuid,
            content: z.string().max(2097152),
            target_database_id: uuid.optional(),
          })
          .strict(),
        r,
      );
      scope(a, "databases.write");
      const parent = await requireAccess(q, a, request.parent_id, 3);
      assert(
        ["space", "page"].includes(parent.kind),
        400,
        "Import destination must be a page or space",
      );
      const preview = previewCsvImport(request.content);
      if (!request.target_database_id) return preview;
      const target = await requireAccess(q, a, request.target_database_id, 3);
      assert(
        target.kind === "database" &&
          !target.deleted_at &&
          target.parent_id === parent.id,
        404,
        "Import target unavailable in selected destination",
      );
      const schema = await one(
        q,
        "SELECT properties FROM databases WHERE resource_id=$1",
        [target.id],
      );
      assert(schema, 404, "Import target unavailable");
      const allowed = new Set(["title", "text", "number", "date", "checkbox"]);
      const columns = schema.properties.filter((p: any) => allowed.has(p.type));
      const suggestions = preview.mapping.map((m) => {
        const targetProperty = columns.find(
          (p: any) => p.name.toLowerCase() === m.source.toLowerCase(),
        );
        return targetProperty
          ? {
              source: m.source,
              id: targetProperty.id,
              name: targetProperty.name,
              type: targetProperty.type,
            }
          : { ...m, skip: true };
      });
      return {
        ...preview,
        mapping: suggestions,
        target: {
          id: target.id,
          schema_digest: csvSchemaDigest(schema.properties),
          properties: columns.map((p: any) => ({
            id: p.id,
            name: p.name,
            type: p.type,
          })),
        },
      };
    },
    "databases.write",
  );
  route("POST", "/imports", "Queue Markdown or CSV import", async (q, a, r) => {
    const v = body(
      z
        .object({
          parent_id: uuid,
          format: z.enum(["markdown", "csv"]),
          name: title,
          content: z.string().max(2097152),
          mapping: csvMappingSchema.optional(),
          target_database_id: uuid.optional(),
          expected_schema_digest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          existing_mode: z.literal("append").optional(),
          idempotency_key: z
            .string()
            .regex(/^[A-Za-z0-9_-]{16,128}$/)
            .optional(),
        })
        .strict(),
      r,
    );
    scope(a, v.format === "csv" ? "databases.write" : "pages.write");
    assert(
      v.format === "csv" ||
        (v.mapping === undefined &&
          v.target_database_id === undefined &&
          v.idempotency_key === undefined),
      400,
      "CSV-specific options require CSV format",
    );
    const parent = await requireAccess(q, a, v.parent_id, 3);
    const { idempotency_key, ...payload } = v;
    // Bind the replay identity to *all* validated import parameters and the
    // signed-in principal. CSV bytes are hashed, never logged in a response.
    const digest = idempotency_key
      ? createHash("sha256")
          .update(
            JSON.stringify({
              operation: "workspace.csv.import.v1",
              tenant: a.tenant_id,
              principal: a.user_id,
              payload,
            }),
          )
          .digest("hex")
      : null;
    // A successful submit may have committed even when its HTTP response was
    // lost. Recheck current write access first, then return the original job
    // even if the target's schema changed *after* that original submission.
    if (v.target_database_id) {
      assert(
        v.format === "csv" &&
          v.mapping &&
          v.existing_mode === "append" &&
          v.expected_schema_digest,
        400,
        "Existing imports require explicit append mode, mapping and schema digest",
      );
      const target = await requireAccess(q, a, v.target_database_id, 3);
      assert(
        target.kind === "database" &&
          !target.deleted_at &&
          target.parent_id === parent.id,
        404,
        "Import target unavailable",
      );
    } else {
      assert(
        v.existing_mode === undefined && v.expected_schema_digest === undefined,
        400,
        "Existing import controls require a target database",
      );
    }
    if (idempotency_key) {
      const previous = await one(
        q,
        "SELECT id,status,resource_id,request_digest FROM jobs WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
        [a.tenant_id, a.user_id, idempotency_key],
      );
      if (previous) {
        assert(
          previous.request_digest === digest,
          409,
          "Import key already belongs to another request",
        );
        await requireAccess(q, a, previous.resource_id, 3);
        return { id: previous.id, status: previous.status };
      }
    }
    if (v.target_database_id) {
      const definition = await one(
        q,
        "SELECT properties FROM databases WHERE resource_id=$1",
        [v.target_database_id],
      );
      assert(
        definition &&
          csvSchemaDigest(definition.properties) === v.expected_schema_digest,
        409,
        "Target schema changed; preview again",
      );
    }
    const jid = randomUUID();
    if (!idempotency_key) {
      await q.query(
        "INSERT INTO jobs(id,tenant_id,user_id,resource_id,payload) VALUES($1,$2,$3,$4,$5)",
        [jid, a.tenant_id, a.user_id, v.parent_id, json(payload)],
      );
      return { id: jid, status: "pending" };
    }
    // Partial unique index serializes concurrent same-key submissions. The
    // loser sees precisely the first job, never creates a second job/append.
    const inserted = await one(
      q,
      `INSERT INTO jobs(id,tenant_id,user_id,resource_id,payload,idempotency_key,request_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,user_id,idempotency_key)
       WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id,status`,
      [
        jid,
        a.tenant_id,
        a.user_id,
        v.parent_id,
        json(payload),
        idempotency_key,
        digest,
      ],
    );
    if (inserted) return { id: inserted.id, status: inserted.status };
    const original = await one(
      q,
      "SELECT id,status,resource_id,request_digest FROM jobs WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
      [a.tenant_id, a.user_id, idempotency_key],
    );
    assert(
      original && original.request_digest === digest,
      409,
      "Import key already belongs to another request",
    );
    await requireAccess(q, a, original.resource_id, 3);
    return { id: original.id, status: original.status };
  });
  route(
    "POST",
    "/resources/:id/export/archive/jobs",
    "Queue a portable workspace archive export",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required for archive export");
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      const jid = randomUUID();
      await q.query(
        "INSERT INTO jobs(id,tenant_id,user_id,resource_id,payload)" +
          " VALUES($1,$2,$3,$4,$5)",
        [
          jid,
          a.tenant_id,
          a.user_id,
          n.id,
          json({ format: "workspace_archive_export", source_id: n.id }),
        ],
      );
      return { id: jid, status: "pending" };
    },
  );
  route(
    "POST",
    "/imports/archive",
    "Stage and queue a portable workspace archive import",
    async (q, a, r) => {
      assert(!a.scopes, 403, "Human session required for archive import");
      const parentId = uuid.parse(query(r).parent_id);
      await requireAccess(q, a, parentId, 3);
      assert(Buffer.isBuffer(r.body), 400, "Archive body required");
      const archive = Buffer.from(r.body as Buffer);
      const inspected = inspectPortableArchive(archive);
      const jid = randomUUID(),
        artifactId = randomUUID(),
        key = `${a.tenant_id}/${parentId}/${artifactId}`,
        digest = createHash("sha256").update(archive).digest("hex");
      try {
        await storage.put(key, archive, "application/zip");
        await q.query(
          "INSERT INTO jobs(id,tenant_id,user_id,resource_id,payload)" +
            " VALUES($1,$2,$3,$4,$5)",
          [
            jid,
            a.tenant_id,
            a.user_id,
            parentId,
            json({
              format: "workspace_archive_import",
              parent_id: parentId,
              archive_sha256: digest,
              archive_format: inspected.manifest.format,
              archive_version: inspected.manifest.version,
            }),
          ],
        );
        await q.query(
          "INSERT INTO job_artifacts(id,tenant_id,job_id,object_key,kind,name,mime,size,sha256,expires_at)" +
            " VALUES($1,$2,$3,$4,'input',$5,'application/zip',$6,$7,now()+interval '24 hours')",
          [
            artifactId,
            a.tenant_id,
            jid,
            key,
            "workspace-import.zip",
            archive.length,
            digest,
          ],
        );
      } catch (error) {
        await storage.delete(key).catch(() => {});
        throw error;
      }
      return { id: jid, status: "pending" };
    },
  );
  route(
    "GET",
    "/jobs/:id/archive",
    "Download a completed user-owned archive export",
    async (q, a, r, reply) => {
      const job = await one(
        q,
        "SELECT id,user_id,resource_id,status FROM jobs WHERE id=$1",
        [id(r)],
      );
      assert(job && job.user_id === a.user_id, 404, "Job not found");
      await requireAccess(q, a, job.resource_id);
      assert(job.status === "completed", 409, "Archive job is not complete");
      const artifact = await one(
        q,
        "SELECT object_key,name,mime,size FROM job_artifacts" +
          " WHERE job_id=$1 AND kind='output' AND expires_at>now()",
        [job.id],
      );
      assert(artifact, 404, "Archive artifact not found");
      const bytes = await storage.get(artifact.object_key);
      assert(bytes.length === Number(artifact.size), 409,
        "Archive artifact size mismatch");
      reply
        .type(artifact.mime)
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        );
      return reply.send(bytes);
    },
  );
  route(
    "POST",
    "/jobs/:id/cancel",
    "Cancel a queued user-owned job",
    async (q, a, r) => {
      const jobId = id(r);
      const j = await one(
        q,
        "SELECT id,user_id,resource_id,status FROM jobs WHERE id=$1 FOR UPDATE",
        [jobId],
      );
      assert(j && j.user_id === a.user_id, 404, "Job not found");
      await requireAccess(q, a, j.resource_id);
      assert(j.status === "pending", 409, "Only queued jobs can be cancelled");
      for (const artifact of (
        await q.query(
          "SELECT id,object_key FROM job_artifacts" +
            " WHERE job_id=$1 AND kind='input' FOR UPDATE",
          [jobId],
        )
      ).rows) {
        await q.query(
          "INSERT INTO object_deletions(id,tenant_id,object_key,reason)" +
            " VALUES($1,$2,$3,'job_cancelled')" +
            " ON CONFLICT(tenant_id,object_key) DO NOTHING",
          [randomUUID(), a.tenant_id, artifact.object_key],
        );
        await q.query("DELETE FROM job_artifacts WHERE id=$1", [artifact.id]);
      }
      await q.query(
        "UPDATE jobs SET status='cancelled',cancelled_at=now(),completed_at=now()," +
          " lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [jobId],
      );
      return { id: jobId, status: "cancelled" };
    },
  );

  route(
    "GET",
    "/jobs/:id",
    "Read user-owned job status",
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
          return {
            resource: n,
            schema: await presentedSchema(q, a, d.properties),
            records: rows,
          };
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
  route(
    "GET",
    "/resources/:id/export/archive",
    "Export a bounded portable workspace archive",
    async (q, a, r, reply) => {
      const n = await requireAccess(q, a, id(r));
      scope(a, pageScope(n.kind));
      const archive = await exportPortableTree(q, a, n.id, storage);
      await emit(q, a, "export.performed", n.id);
      reply
        .type("application/zip")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `attachment; filename="workspace-archive.zip"`,
        );
      return reply.send(archive);
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
