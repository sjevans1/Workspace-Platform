// GENERATED FILE. DO NOT EDIT.
// Source: packages/contracts/openapi.ts

export type IntegrationRoutes = {
  "POST /webhooks/:id/secret-rotation": {
    method: "POST";
    path: "/api/v1/webhooks/:id/secret-rotation";
    params: { "id": string; };
    query: {  };
    body: { "expected_revision": number; };
    response: { "id": string; "signing_revision": number; "rotation_pending": true; "secret": string; };
  };
  "POST /webhooks/:id/secret-rotation/activate": {
    method: "POST";
    path: "/api/v1/webhooks/:id/secret-rotation/activate";
    params: { "id": string; };
    query: {  };
    body: { "expected_revision": number; };
    response: { "id": string; "signing_revision": number; "rotation_pending": false; "ok": true; };
  };
  "DELETE /webhooks/:id/secret-rotation": {
    method: "DELETE";
    path: "/api/v1/webhooks/:id/secret-rotation";
    params: { "id": string; };
    query: {  };
    body: { "expected_revision": number; };
    response: { "id": string; "signing_revision": number; "rotation_pending": false; "ok": true; };
  };
  "GET /resources": {
    method: "GET";
    path: "/api/v1/resources";
    params: {  };
    query: { "parent_id"?: string; "recent"?: "true" | "false"; "favourites"?: "true" | "false"; "limit"?: number; "offset"?: number; };
    body: null;
    response: Array<{ "id": string; "tenant_id"?: string; "parent_id"?: string | null; "kind": "workspace" | "space" | "page" | "database" | "record"; "title": string; "icon"?: string | null; "position"?: number; "created_at"?: string; "updated_at"?: string; "deleted_at"?: string | null; "effective_permission"?: number; } & Record<string, unknown>>;
  };
  "GET /resources/:id/backlinks": {
    method: "GET";
    path: "/api/v1/resources/:id/backlinks";
    params: { "id": string; };
    query: { "cursor"?: string; "limit"?: number; };
    body: null;
    response: { "items": Array<{ "id": string; "title": string; "kind": "page" | "record"; "updated_at": string; }>; "next_cursor": string | null; "has_more": boolean; };
  };
  "POST /resource-links/reconcile": {
    method: "POST";
    path: "/api/v1/resource-links/reconcile";
    params: {  };
    query: {  };
    body: { "cursor"?: string; "limit"?: number; };
    response: { "processed": number; "next_cursor": string | null; "has_more": boolean; };
  };
  "GET /pages/:id/content": {
    method: "GET";
    path: "/api/v1/pages/:id/content";
    params: { "id": string; };
    query: {  };
    body: null;
    response: { "id": string; "tenant_id": string; "workspace_id"?: string; "space_id"?: string; "parent_id"?: string | null; "title": string; "created_at"?: string; "updated_at"?: string; "blocks": Array<unknown>; "plain_text": string; "revision": number; "epoch": number; };
  };
  "PATCH /pages/:id/content": {
    method: "PATCH";
    path: "/api/v1/pages/:id/content";
    params: { "id": string; };
    query: {  };
    body: { "blocks": Array<unknown>; "expected_revision": number; };
    response: { "revision"?: number; "epoch"?: number; } & Record<string, unknown>;
  };
  "GET /resources/:id/permissions": {
    method: "GET";
    path: "/api/v1/resources/:id/permissions";
    params: { "id": string; };
    query: {  };
    body: null;
    response: { "tenant_id": string; "resource_id": string; "effective_permission": number; "revision": number; "policy": Array<{  } & Record<string, unknown>>; "semantics": string; };
  };
  "GET /resources/:id/permissions/check": {
    method: "GET";
    path: "/api/v1/resources/:id/permissions/check";
    params: { "id": string; };
    query: { "user_id": string; };
    body: null;
    response: { "allowed": boolean; };
  };
  "GET /events": {
    method: "GET";
    path: "/api/v1/events";
    params: {  };
    query: { "since"?: string; };
    body: null;
    response: Array<{ "id": string; "tenant_id": string; "type": string; "resource_id"?: string | null; "version"?: number; "created_at": string; } & Record<string, unknown>>;
  };
  "GET /events/cursor": {
    method: "GET";
    path: "/api/v1/events/cursor";
    params: {  };
    query: { "cursor"?: string; "since"?: string; "limit"?: number; };
    body: null;
    response: { "events": Array<{ "id": string; "tenant_id": string; "type": string; "resource_id"?: string | null; "version"?: number; "created_at": string; } & Record<string, unknown>>; "next_cursor": string; "has_more": boolean; };
  };
  "GET /events/reconcile": {
    method: "GET";
    path: "/api/v1/events/reconcile";
    params: {  };
    query: { "cursor"?: string; "limit"?: number; };
    body: null;
    response: { "resources": Array<{ "id": string; "kind": "workspace" | "space" | "page" | "database" | "record"; "parent_id": string | null; "updated_at": string; }>; "next_cursor": string; "has_more": boolean; };
  };
  "POST /imports/preview": {
    method: "POST";
    path: "/api/v1/imports/preview";
    params: {  };
    query: {  };
    body: { "parent_id": string; "content": string; "target_database_id"?: string; };
    response: { "columns": Array<string>; "row_count": number; "mapping": Array<{ "source": string; "id": string; "name": string; "type": "title" | "text" | "number" | "date" | "checkbox"; "skip"?: boolean; }>; "sample": Array<Array<string>>; "warnings": Array<string>; "target"?: { "id": string; "schema_digest": string; "properties": Array<{ "id": string; "name": string; "type": "title" | "text" | "number" | "date" | "checkbox"; }>; }; };
  };
  "POST /imports": {
    method: "POST";
    path: "/api/v1/imports";
    params: {  };
    query: {  };
    body: { "parent_id": string; "format": "markdown" | "csv"; "name": string; "content": string; "target_database_id"?: string; "expected_schema_digest"?: string; "existing_mode"?: "append"; "idempotency_key"?: string; "mapping"?: Array<{ "source": string; "id": string; "name": string; "type": "title" | "text" | "number" | "date" | "checkbox"; "skip"?: boolean; }>; };
    response: { "id": string; "status": "pending" | "running" | "completed" | "failed" | "cancelled"; };
  };
  "GET /jobs/:id": {
    method: "GET";
    path: "/api/v1/jobs/:id";
    params: { "id": string; };
    query: {  };
    body: null;
    response: { "id": string; "user_id": string; "resource_id": string; "status": "pending" | "running" | "completed" | "failed" | "cancelled"; "result"?: unknown; };
  };
};

export type IntegrationRoute = keyof IntegrationRoutes;
