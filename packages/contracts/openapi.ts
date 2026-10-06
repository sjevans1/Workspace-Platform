export type JsonSchema = Record<string, any>;

const uuid = { type: "string", format: "uuid" };
const dateTime = { type: "string", format: "date-time" };
const error = {
  type: "object",
  required: ["error", "request_id"],
  properties: {
    error: { type: "string" },
    request_id: { type: "string" },
  },
  additionalProperties: false,
};
const errors = {
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  413: error,
  429: error,
};
const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: uuid },
  additionalProperties: false,
};
const resource = {
  type: "object",
  required: ["id", "kind", "title"],
  properties: {
    id: uuid,
    tenant_id: uuid,
    parent_id: { anyOf: [uuid, { type: "null" }] },
    kind: { enum: ["workspace", "space", "page", "database", "record"] },
    title: { type: "string" },
    icon: { anyOf: [{ type: "string" }, { type: "null" }] },
    position: { type: "number" },
    created_at: dateTime,
    updated_at: dateTime,
    deleted_at: { anyOf: [dateTime, { type: "null" }] },
    effective_permission: { type: "integer", minimum: 0, maximum: 4 },
  },
  additionalProperties: true,
};
const blocks = { type: "array", items: {} };
const pageContent = {
  type: "object",
  required: ["id", "tenant_id", "title", "blocks", "plain_text", "revision", "epoch"],
  properties: {
    id: uuid,
    tenant_id: uuid,
    workspace_id: uuid,
    space_id: uuid,
    parent_id: { anyOf: [uuid, { type: "null" }] },
    title: { type: "string" },
    created_at: dateTime,
    updated_at: dateTime,
    blocks,
    plain_text: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    epoch: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};
const event = {
  type: "object",
  required: ["id", "type", "tenant_id", "created_at"],
  properties: {
    id: uuid,
    tenant_id: uuid,
    type: { type: "string" },
    resource_id: { anyOf: [uuid, { type: "null" }] },
    version: { type: "integer" },
    created_at: dateTime,
  },
  additionalProperties: true,
};

const rotation = (prepared: boolean): JsonSchema => ({
  params: idParams,
  body: {
    type: "object",
    required: ["expected_revision"],
    properties: { expected_revision: { type: "integer", minimum: 1 } },
    additionalProperties: false,
  },
  response: {
    200: {
      type: "object",
      required: [
        "id",
        "signing_revision",
        "rotation_pending",
        prepared ? "secret" : "ok",
      ],
      properties: {
        id: uuid,
        signing_revision: { type: "integer", minimum: 1 },
        rotation_pending: { const: prepared },
        ...(prepared
          ? { secret: { type: "string" } }
          : { ok: { const: true } }),
      },
      additionalProperties: false,
    },
    ...errors,
  },
});

export const integrationOpenApi: Record<string, JsonSchema> = {
  "POST /webhooks/:id/secret-rotation": rotation(true),
  "POST /webhooks/:id/secret-rotation/activate": rotation(false),
  "DELETE /webhooks/:id/secret-rotation": rotation(false),
  "GET /resources": {
    querystring: {
      type: "object",
      properties: {
        parent_id: uuid,
        recent: { type: "string", enum: ["true", "false"] },
        favourites: { type: "string", enum: ["true", "false"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    response: { 200: { type: "array", items: resource }, ...errors },
  },
  "GET /resources/:id/backlinks": {
    params: idParams,
    querystring: {
      type: "object",
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 2048 },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["items", "next_cursor", "has_more"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            maxItems: 40,
            items: {
              type: "object",
              required: ["id", "title", "kind", "updated_at"],
              additionalProperties: false,
              properties: {
                id: uuid,
                title: { type: "string" },
                kind: { enum: ["page", "record"] },
                updated_at: dateTime,
              },
            },
          },
          next_cursor: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 2048 },
              { type: "null" },
            ],
          },
          has_more: { type: "boolean" },
        },
      },
      ...errors,
    },
  },
  "POST /resource-links/reconcile": {
    body: {
      type: "object",
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 2048 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["processed", "next_cursor", "has_more"],
        additionalProperties: false,
        properties: {
          processed: { type: "integer", minimum: 0, maximum: 100 },
          next_cursor: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 2048 },
              { type: "null" },
            ],
          },
          has_more: { type: "boolean" },
        },
      },
      ...errors,
    },
  },
  "GET /pages/:id/content": {
    params: idParams,
    response: { 200: pageContent, ...errors },
  },
  "PATCH /pages/:id/content": {
    params: idParams,
    body: {
      type: "object",
      required: ["blocks", "expected_revision"],
      properties: {
        blocks,
        expected_revision: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        properties: {
          revision: { type: "integer", minimum: 1 },
          epoch: { type: "integer", minimum: 1 },
        },
        additionalProperties: true,
      },
      ...errors,
    },
  },
  "GET /resources/:id/permissions": {
    params: idParams,
    response: {
      200: {
        type: "object",
        required: ["tenant_id", "resource_id", "effective_permission", "revision", "policy", "semantics"],
        properties: {
          tenant_id: uuid,
          resource_id: uuid,
          effective_permission: { type: "integer", minimum: 0, maximum: 4 },
          revision: { type: "integer", minimum: 1 },
          policy: { type: "array", items: { type: "object", additionalProperties: true } },
          semantics: { type: "string" },
        },
        additionalProperties: false,
      },
      ...errors,
    },
  },
  "GET /resources/:id/permissions/check": {
    params: idParams,
    querystring: {
      type: "object",
      required: ["user_id"],
      properties: { user_id: uuid },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["allowed"],
        properties: { allowed: { type: "boolean" } },
        additionalProperties: false,
      },
      ...errors,
    },
  },
  "GET /events": {
    querystring: {
      type: "object",
      properties: { since: dateTime },
      additionalProperties: false,
    },
    response: { 200: { type: "array", items: event }, ...errors },
  },
  "GET /events/cursor": {
    querystring: {
      type: "object",
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 2048 },
        since: dateTime,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["events", "next_cursor", "has_more"],
        properties: {
          events: { type: "array", items: event },
          next_cursor: { type: "string" },
          has_more: { type: "boolean" },
        },
        additionalProperties: false,
      },
      ...errors,
    },
  },
  "GET /events/reconcile": {
    querystring: {
      type: "object",
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 2048 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["resources", "next_cursor", "has_more"],
        properties: {
          resources: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "kind", "parent_id", "updated_at"],
              properties: {
                id: uuid,
                kind: { enum: ["workspace", "space", "page", "database", "record"] },
                parent_id: { anyOf: [uuid, { type: "null" }] },
                updated_at: dateTime,
              },
              additionalProperties: false,
            },
          },
          next_cursor: { type: "string" },
          has_more: { type: "boolean" },
        },
        additionalProperties: false,
      },
      ...errors,
    },
  },
  "POST /imports/preview": {
    body: {
      type: "object",
      required: ["parent_id", "content"],
      properties: {
        parent_id: uuid,
        content: { type: "string", maxLength: 2097152 },
        target_database_id: uuid,
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["columns", "row_count", "mapping", "sample", "warnings"],
        properties: {
          columns: { type: "array", maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 120 } },
          row_count: { type: "integer", minimum: 1, maximum: 2000 },
          mapping: { type: "array", minItems: 1, maxItems: 100,
            items: {
              type: "object",
              required: ["source", "id", "name", "type"],
              properties: {
                source: { type: "string", minLength: 1, maxLength: 120 },
                id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" },
                name: { type: "string", minLength: 1, maxLength: 120 },
                type: { enum: ["title","text","number","date","checkbox"] },
                skip: { type: "boolean" },
              },
              additionalProperties: false,
            } },
          sample: { type: "array", maxItems: 5,
            items: { type: "array", maxItems: 100,
              items: { type: "string" } } },
          warnings: { type: "array", items: { type: "string" } },
          target: {
            type: "object",
            required: ["id","schema_digest","properties"],
            properties: {
              id: uuid,
              schema_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              properties: { type: "array", maxItems: 100,
                items: {
                  type: "object", required: ["id","name","type"],
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    type: { enum: ["title","text","number","date","checkbox"] },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      ...errors,
    },
  },
  "POST /imports": {
    body: {
      type: "object",
      required: ["parent_id", "format", "name", "content"],
      properties: {
        parent_id: uuid,
        format: { enum: ["markdown", "csv"] },
        name: { type: "string", minLength: 1, maxLength: 500 },
        content: { type: "string", maxLength: 2097152 },
        target_database_id: uuid,
        expected_schema_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        existing_mode: { enum: ["append"] },
        idempotency_key: { type: "string",
          pattern: "^[A-Za-z0-9_-]{16,128}$", minLength: 16, maxLength: 128 },
        mapping: { type: "array", minItems: 1, maxItems: 100,
          items: {
            type: "object",
            required: ["source", "id", "name", "type"],
            properties: {
              source: { type: "string", minLength: 1, maxLength: 120 },
              id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" },
              name: { type: "string", minLength: 1, maxLength: 120 },
              type: { enum: ["title","text","number","date","checkbox"] },
              skip: { type: "boolean" },
            },
            additionalProperties: false,
          } },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: uuid,
          status: { enum: ["pending","completed","failed"] },
        },
        additionalProperties: false,
      },
      ...errors,
    },
  },
  "GET /jobs/:id": {
    params: idParams,
    response: {
      200: {
        type: "object",
        required: ["id", "user_id", "resource_id", "status"],
        properties: {
          id: uuid,
          user_id: uuid,
          resource_id: uuid,
          status: { enum: ["pending", "completed", "failed"] },
          result: {},
        },
        additionalProperties: false,
      },
      ...errors,
    },
  },
};
