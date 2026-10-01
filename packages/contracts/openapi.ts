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

export const integrationOpenApi: Record<string, JsonSchema> = {
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
  "POST /imports": {
    body: {
      type: "object",
      required: ["parent_id", "format", "name", "content"],
      properties: {
        parent_id: uuid,
        format: { enum: ["markdown", "csv"] },
        name: { type: "string", minLength: 1, maxLength: 500 },
        content: { type: "string", maxLength: 2097152 },
      },
      additionalProperties: false,
    },
    response: {
      200: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: uuid,
          status: { const: "pending" },
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
