import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "../../../packages/auth/index.ts";
import {
  HttpError,
  assert,
  uuid,
} from "../../../packages/contracts/index.ts";
import {
  Database,
  one,
  type Query,
} from "../../../packages/database/index.ts";

const SCIM_JSON = "application/scim+json",
  USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User",
  LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error",
  PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  CONFIG_SCHEMA =
    "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  RESOURCE_TYPE_SCHEMA =
    "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

type Connector = {
  id: string;
  tenant_id: string;
  label: string;
  default_role: "member" | "guest";
};

class ScimError extends HttpError {
  constructor(
    status: number,
    message: string,
    public scimType?: string,
  ) {
    super(status, message);
  }
}

const email = z.email().transform((value) => value.trim().toLowerCase()),
  scimUserInput = z
    .object({
      schemas: z.array(z.string()).optional(),
      userName: z.string().trim().min(1).max(320),
      externalId: z.string().trim().max(500).nullable().optional(),
      displayName: z.string().trim().max(500).nullable().optional(),
      name: z
        .object({
          formatted: z.string().trim().max(500).optional(),
          givenName: z.string().trim().max(250).optional(),
          familyName: z.string().trim().max(250).optional(),
        })
        .passthrough()
        .optional(),
      emails: z
        .array(
          z
            .object({
              value: z.string().trim().max(320),
              primary: z.boolean().optional(),
              type: z.string().max(50).optional(),
            })
            .passthrough(),
        )
        .max(20)
        .optional(),
      active: z.boolean().optional(),
    })
    .passthrough(),
  patchInput = z
    .object({
      schemas: z.array(z.string()),
      Operations: z
        .array(
          z
            .object({
              op: z
                .string()
                .transform((value) => value.toLowerCase())
                .pipe(z.enum(["add", "replace", "remove"])),
              path: z.string().trim().max(500).optional(),
              value: z.unknown().optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(50),
    })
    .passthrough();

function scimError(error: any) {
  if (error instanceof ScimError) return error;
  if (error instanceof SyntaxError)
    return new ScimError(400, "Invalid JSON request body", "invalidSyntax");
  if (error instanceof z.ZodError)
    return new ScimError(
      400,
      error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      "invalidValue",
    );
  if (error?.code === "23505")
    return new ScimError(409, "Resource conflicts with an existing value", "uniqueness");
  if (error instanceof HttpError)
    return new ScimError(error.statusCode, error.message);
  return error;
}

function primaryEmail(input: z.infer<typeof scimUserInput>) {
  const candidate =
    input.emails?.find((item) => item.primary)?.value ||
    input.emails?.[0]?.value ||
    input.userName;
  const parsed = email.safeParse(candidate);
  if (!parsed.success)
    throw new ScimError(
      400,
      "Workspace SCIM provisioning requires an email address in emails or userName",
      "invalidValue",
    );
  return parsed.data;
}

function displayName(input: z.infer<typeof scimUserInput>) {
  return (
    input.displayName ||
    input.name?.formatted ||
    [input.name?.givenName, input.name?.familyName].filter(Boolean).join(" ") ||
    primaryEmail(input)
  );
}

function version(value: Date | string) {
  const timestamp = new Date(value).toISOString();
  return `W/"${Buffer.from(timestamp).toString("base64url")}"`;
}

function resource(row: any, base: string) {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    active: !!row.active,
    emails: [{ value: row.email, type: "work", primary: true }],
    meta: {
      resourceType: "User",
      created: new Date(row.created_at).toISOString(),
      lastModified: new Date(row.updated_at).toISOString(),
      location: `${base}/Users/${row.id}`,
      version: version(row.updated_at),
    },
  };
}

async function loadUser(q: Query, id: string) {
  return one(
    q,
    `SELECT s.*,u.email,m.active,m.role
     FROM scim_users s
     JOIN users u ON u.id=s.user_id
     JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
     WHERE s.id=$1 AND s.deleted_at IS NULL`,
    [id],
  );
}

async function audit(
  q: Query,
  tenantId: string,
  requestId: string,
  action: string,
) {
  await q.query(
    "INSERT INTO audit_events(id,tenant_id,actor_id,action,request_id) VALUES($1,$2,NULL,$3,$4)",
    [randomUUID(), tenantId, action, requestId],
  );
}

async function setActive(
  q: Query,
  tenantId: string,
  userId: string,
  active: boolean,
) {
  await q.query(
    "UPDATE memberships SET active=$3 WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, userId, active],
  );
  if (!active)
    await q.query("DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2", [
      tenantId,
      userId,
    ]);
}

function parseFilter(raw: unknown) {
  if (raw == null || raw === "") return null;
  const text = String(raw),
    match = text.match(/^\s*(userName|externalId)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i);
  if (!match)
    throw new ScimError(
      400,
      "Only userName eq and externalId eq filters are supported",
      "invalidFilter",
    );
  let value = "";
  try {
    value = JSON.parse(match[2]);
  } catch {
    throw new ScimError(400, "Invalid SCIM filter string", "invalidFilter");
  }
  return { field: match[1].toLowerCase(), value };
}

function assertSchema(input: { schemas?: string[] }) {
  if (
    input.schemas &&
    input.schemas.length &&
    !input.schemas.includes(USER_SCHEMA)
  )
    throw new ScimError(400, "User schema is required", "invalidValue");
}

function applyPatch(
  current: {
    userName: string;
    externalId: string | null;
    displayName: string | null;
    active: boolean;
  },
  body: z.infer<typeof patchInput>,
) {
  if (!body.schemas.includes(PATCH_SCHEMA))
    throw new ScimError(400, "PatchOp schema is required", "invalidSyntax");
  const next = { ...current };
  const assign = (key: string, value: unknown, remove = false) => {
    const normalized = key.toLowerCase();
    if (normalized === "active") {
      if (remove)
        throw new ScimError(400, "active cannot be removed", "mutability");
      if (typeof value !== "boolean")
        throw new ScimError(400, "active must be boolean", "invalidValue");
      next.active = value;
      return;
    }
    if (normalized === "displayname") {
      if (remove || value === null) next.displayName = null;
      else if (typeof value === "string" && value.length <= 500)
        next.displayName = value.trim() || null;
      else throw new ScimError(400, "displayName must be a string", "invalidValue");
      return;
    }
    if (normalized === "externalid") {
      if (remove || value === null) next.externalId = null;
      else if (typeof value === "string" && value.length <= 500)
        next.externalId = value.trim() || null;
      else throw new ScimError(400, "externalId must be a string", "invalidValue");
      return;
    }
    if (normalized === "username") {
      if (remove || typeof value !== "string")
        throw new ScimError(400, "userName is immutable", "mutability");
      if (value.toLowerCase() !== current.userName.toLowerCase())
        throw new ScimError(400, "userName is immutable after provisioning", "mutability");
      return;
    }
    throw new ScimError(
      400,
      `Unsupported SCIM attribute ${key}`,
      "invalidPath",
    );
  };

  for (const operation of body.Operations) {
    const remove = operation.op === "remove";
    if (operation.path) {
      assign(operation.path, operation.value, remove);
      continue;
    }
    if (
      !remove &&
      operation.value &&
      typeof operation.value === "object" &&
      !Array.isArray(operation.value)
    ) {
      for (const [key, value] of Object.entries(
        operation.value as Record<string, unknown>,
      ))
        assign(key, value);
      continue;
    }
    throw new ScimError(
      400,
      "PATCH operations without path require an object value",
      "invalidSyntax",
    );
  }
  return next;
}

export async function registerScim(app: FastifyInstance, db: Database) {
  const base = new URL(
    "/scim/v2",
    process.env.APP_URL || "http://localhost:3000",
  ).href.replace(/\/$/, "");

  await app.register(
    async (scim) => {
      scim.addContentTypeParser(
        SCIM_JSON,
        { parseAs: "string", bodyLimit: 1048576 },
        (_request, payload, done) => {
          try {
            done(null, JSON.parse(String(payload)));
          } catch (error) {
            done(error as Error);
          }
        },
      );

      scim.setErrorHandler((raw: any, request, reply) => {
        const error = scimError(raw),
          status =
            error instanceof ScimError
              ? error.statusCode
              : error?.statusCode || 500;
        if (status >= 500) request.log.error({ err: raw }, "SCIM request failed");
        if (status === 401)
          reply.header("WWW-Authenticate", 'Bearer realm="OpenJM Workspace SCIM"');
        reply
          .code(status)
          .type(SCIM_JSON)
          .send({
            schemas: [ERROR_SCHEMA],
            status: String(status),
            detail:
              status >= 500
                ? "Internal error"
                : error?.message || "SCIM request failed",
            ...(error instanceof ScimError && error.scimType
              ? { scimType: error.scimType }
              : {}),
          });
      });

      const connector = async (request: FastifyRequest) => {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer "))
          throw new ScimError(401, "SCIM bearer token required");
        const value = header.slice(7).trim();
        if (!value || value.length > 200)
          throw new ScimError(401, "Invalid SCIM bearer token");
        const context = await db.system((q) =>
          one(q, "SELECT * FROM scim_connector_context($1)", [hash(value)]),
        );
        if (!context) throw new ScimError(401, "Invalid SCIM bearer token");
        return context as Connector;
      };

      const tenant = async <T>(
        request: FastifyRequest,
        fn: (q: Query, context: Connector) => Promise<T>,
      ) => {
        const context = await connector(request);
        return db.tenant(context.tenant_id, async (q) => {
          await q.query(
            "UPDATE scim_connectors SET last_used_at=now() WHERE id=$1",
            [context.id],
          );
          return fn(q, context);
        });
      };

      const send = (reply: FastifyReply, value: unknown, status = 200) =>
        reply.code(status).type(SCIM_JSON).send(value);

      scim.get("/ServiceProviderConfig", async (request, reply) =>
        tenant(request, async () =>
          send(reply, {
            schemas: [CONFIG_SCHEMA],
            patch: { supported: true },
            bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
            filter: { supported: true, maxResults: 100 },
            changePassword: { supported: false },
            sort: { supported: false },
            etag: { supported: false },
            authenticationSchemes: [
              {
                type: "oauthbearertoken",
                name: "HTTP Bearer",
                description:
                  "Tenant-scoped static bearer token generated by a Workspace administrator",
                specUri: "https://www.rfc-editor.org/rfc/rfc6750",
                primary: true,
              },
            ],
            meta: {
              resourceType: "ServiceProviderConfig",
              location: `${base}/ServiceProviderConfig`,
            },
          }),
        ),
      );

      const resourceType = {
        schemas: [RESOURCE_TYPE_SCHEMA],
        id: "User",
        name: "User",
        endpoint: "/Users",
        description: "Workspace tenant membership managed through SCIM",
        schema: USER_SCHEMA,
        meta: {
          resourceType: "ResourceType",
          location: `${base}/ResourceTypes/User`,
        },
      };
      scim.get("/ResourceTypes", async (request, reply) =>
        tenant(request, async () =>
          send(reply, {
            schemas: [LIST_SCHEMA],
            totalResults: 1,
            startIndex: 1,
            itemsPerPage: 1,
            Resources: [resourceType],
          }),
        ),
      );
      scim.get("/ResourceTypes/User", async (request, reply) =>
        tenant(request, async () => send(reply, resourceType)),
      );

      const userSchema = {
        schemas: [SCHEMA_SCHEMA],
        id: USER_SCHEMA,
        name: "User",
        description: "OpenJM Workspace SCIM User",
        attributes: [
          {
            name: "userName",
            type: "string",
            multiValued: false,
            required: true,
            caseExact: false,
            mutability: "immutable",
            returned: "default",
            uniqueness: "server",
          },
          {
            name: "externalId",
            type: "string",
            multiValued: false,
            required: false,
            caseExact: true,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "displayName",
            type: "string",
            multiValued: false,
            required: false,
            caseExact: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "active",
            type: "boolean",
            multiValued: false,
            required: false,
            mutability: "readWrite",
            returned: "default",
            uniqueness: "none",
          },
          {
            name: "emails",
            type: "complex",
            multiValued: true,
            required: false,
            mutability: "immutable",
            returned: "default",
            subAttributes: [
              {
                name: "value",
                type: "string",
                multiValued: false,
                required: true,
                mutability: "immutable",
                returned: "default",
              },
              {
                name: "primary",
                type: "boolean",
                multiValued: false,
                required: false,
                mutability: "immutable",
                returned: "default",
              },
            ],
          },
        ],
        meta: {
          resourceType: "Schema",
          location: `${base}/Schemas/${encodeURIComponent(USER_SCHEMA)}`,
        },
      };
      scim.get("/Schemas", async (request, reply) =>
        tenant(request, async () =>
          send(reply, {
            schemas: [LIST_SCHEMA],
            totalResults: 1,
            startIndex: 1,
            itemsPerPage: 1,
            Resources: [userSchema],
          }),
        ),
      );
      scim.get("/Schemas/:id", async (request, reply) =>
        tenant(request, async () => {
          const id = String((request.params as any).id || "");
          if (id !== USER_SCHEMA)
            throw new ScimError(404, "Schema not found");
          return send(reply, userSchema);
        }),
      );

      scim.get("/Users", async (request, reply) =>
        tenant(request, async (q) => {
          const params = request.query as Record<string, unknown>,
            filter = parseFilter(params.filter),
            startIndex = Math.max(1, Number(params.startIndex) || 1),
            count = Math.min(100, Math.max(0, Number(params.count) || 100)),
            where: string[] = ["s.deleted_at IS NULL"],
            values: unknown[] = [];

          if (filter?.field === "username") {
            values.push(filter.value);
            where.push(`lower(s.user_name)=lower($${values.length})`);
          } else if (filter?.field === "externalid") {
            values.push(filter.value);
            where.push(`s.external_id=$${values.length}`);
          }

          const total = Number(
              (
                await one(
                  q,
                  `SELECT count(*) n
                   FROM scim_users s
                   JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
                   WHERE ${where.join(" AND ")}`,
                  values,
                )
              ).n,
            ),
            queryValues = [...values, count, startIndex - 1],
            rows = (
              await q.query(
                `SELECT s.*,u.email,m.active,m.role
                 FROM scim_users s
                 JOIN users u ON u.id=s.user_id
                 JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
                 WHERE ${where.join(" AND ")}
                 ORDER BY lower(s.user_name),s.id
                 LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
                queryValues,
              )
            ).rows;
          return send(reply, {
            schemas: [LIST_SCHEMA],
            totalResults: total,
            startIndex,
            itemsPerPage: rows.length,
            Resources: rows.map((row) => resource(row, base)),
          });
        }),
      );

      scim.get("/Users/:id", async (request, reply) =>
        tenant(request, async (q) => {
          const id = uuid.parse((request.params as any).id),
            row = await loadUser(q, id);
          if (!row) throw new ScimError(404, "User not found");
          return send(reply, resource(row, base));
        }),
      );

      scim.post("/Users", async (request, reply) =>
        tenant(request, async (q, context) => {
          const input = scimUserInput.parse(request.body);
          assertSchema(input);
          const userName = input.userName.trim(),
            provisionedEmail = primaryEmail(input),
            name = displayName(input),
            active = input.active ?? false,
            existingResource = await one(
              q,
              `SELECT id FROM scim_users
               WHERE deleted_at IS NULL
                 AND (lower(user_name)=lower($1)
                   OR ($2::text IS NOT NULL AND external_id=$2))`,
              [userName, input.externalId || null],
            );
          if (existingResource)
            throw new ScimError(
              409,
              "SCIM userName or externalId already exists",
              "uniqueness",
            );

          let user = await one(
            q,
            "SELECT id,email,name FROM users WHERE lower(email)=lower($1)",
            [provisionedEmail],
          );
          if (!user) {
            user = {
              id: randomUUID(),
              email: provisionedEmail,
              name,
            };
            await q.query(
              "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,NULL)",
              [user.id, user.email, user.name],
            );
          }

          const membership = await one(
              q,
              "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
              [context.tenant_id, user.id],
            ),
            priorManaged = await one(
              q,
              `SELECT 1 FROM scim_users
               WHERE tenant_id=$1 AND user_id=$2 AND deleted_at IS NOT NULL
               LIMIT 1`,
              [context.tenant_id, user.id],
            );
          if (membership && !priorManaged)
            throw new ScimError(
              409,
              "Existing Workspace membership is not SCIM-managed",
              "uniqueness",
            );
          if (membership && ["owner", "admin"].includes(membership.role))
            throw new ScimError(
              403,
              "SCIM cannot manage owner or administrator memberships",
              "mutability",
            );

          if (membership)
            await q.query(
              "UPDATE memberships SET active=$3 WHERE tenant_id=$1 AND user_id=$2",
              [context.tenant_id, user.id, active],
            );
          else
            await q.query(
              "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,$3,$4)",
              [context.tenant_id, user.id, context.default_role, active],
            );

          const scimId = randomUUID();
          await q.query(
            `INSERT INTO scim_users(
              id,tenant_id,user_id,external_id,user_name,display_name
            ) VALUES($1,$2,$3,$4,$5,$6)`,
            [
              scimId,
              context.tenant_id,
              user.id,
              input.externalId || null,
              userName,
              input.displayName || name || null,
            ],
          );
          await audit(q, context.tenant_id, request.id, "scim.user.provisioned");
          const row = await loadUser(q, scimId);
          reply.header("Location", `${base}/Users/${scimId}`);
          return send(reply, resource(row, base), 201);
        }),
      );

      scim.patch("/Users/:id", async (request, reply) =>
        tenant(request, async (q, context) => {
          const id = uuid.parse((request.params as any).id),
            row = await loadUser(q, id);
          if (!row) throw new ScimError(404, "User not found");
          const patch = patchInput.parse(request.body),
            next = applyPatch(
              {
                userName: row.user_name,
                externalId: row.external_id,
                displayName: row.display_name,
                active: !!row.active,
              },
              patch,
            );

          await q.query(
            `UPDATE scim_users
             SET external_id=$2,display_name=$3,updated_at=now()
             WHERE id=$1`,
            [id, next.externalId, next.displayName],
          );
          if (next.active !== !!row.active)
            await setActive(q, context.tenant_id, row.user_id, next.active);
          await audit(
            q,
            context.tenant_id,
            request.id,
            next.active !== !!row.active
              ? next.active
                ? "scim.user.activated"
                : "scim.user.deactivated"
              : "scim.user.updated",
          );
          return send(reply, resource(await loadUser(q, id), base));
        }),
      );

      scim.put("/Users/:id", async (request, reply) =>
        tenant(request, async (q, context) => {
          const id = uuid.parse((request.params as any).id),
            row = await loadUser(q, id);
          if (!row) throw new ScimError(404, "User not found");
          const input = scimUserInput.parse(request.body);
          assertSchema(input);
          if (input.userName.toLowerCase() !== row.user_name.toLowerCase())
            throw new ScimError(
              400,
              "userName is immutable after provisioning",
              "mutability",
            );
          const requestedEmail = primaryEmail(input);
          if (requestedEmail !== String(row.email).toLowerCase())
            throw new ScimError(
              400,
              "Primary email is immutable after provisioning",
              "mutability",
            );
          const active = input.active ?? false;
          await q.query(
            `UPDATE scim_users
             SET external_id=$2,display_name=$3,updated_at=now()
             WHERE id=$1`,
            [id, input.externalId || null, input.displayName || displayName(input)],
          );
          if (active !== !!row.active)
            await setActive(q, context.tenant_id, row.user_id, active);
          await audit(
            q,
            context.tenant_id,
            request.id,
            active !== !!row.active
              ? active
                ? "scim.user.activated"
                : "scim.user.deactivated"
              : "scim.user.updated",
          );
          return send(reply, resource(await loadUser(q, id), base));
        }),
      );

      scim.delete("/Users/:id", async (request, reply) =>
        tenant(request, async (q, context) => {
          const id = uuid.parse((request.params as any).id),
            row = await loadUser(q, id);
          if (!row) throw new ScimError(404, "User not found");
          await setActive(q, context.tenant_id, row.user_id, false);
          await q.query(
            "UPDATE scim_users SET deleted_at=now(),updated_at=now() WHERE id=$1",
            [id],
          );
          await audit(q, context.tenant_id, request.id, "scim.user.deleted");
          return reply.code(204).send();
        }),
      );
    },
    { prefix: "/scim/v2" },
  );
}
