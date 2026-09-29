# REST and Intelligence integration

The Workspace is independently usable. Intelligence reads through the versioned API, not directly from PostgreSQL or object storage. Interactive route documentation is at `/api/docs`; a generated OpenAPI inventory is at `/api/docs/json`. The first-pass OpenAPI document lists routes and authentication but does not yet provide complete request/response schemas.

## Service credential

Create a credential in Settings → Integrations. The plaintext token is shown once. It belongs to a separate guest principal and expires after 90 days. Grant that principal View access at the workspace root and on the permitted restricted ancestors, then narrow individual branches as needed. A token with read scopes cannot write even if a resource ACL is more permissive. A token sent as a browser cookie is rejected; service credentials use the Authorization header.

```bash
curl -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  "$WORKSPACE_URL/api/v1/resources"

curl -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  "$WORKSPACE_URL/api/v1/pages/$PAGE_ID/content"

curl -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  "$WORKSPACE_URL/api/v1/resources/$PAGE_ID/permissions"
```

The page content response includes tenant, workspace, space, page and parent IDs, title, timestamps, canonical blocks, plain text, revision and epoch. Store those identifiers, the source URL `/?page=<id>`, revision and ACL chain with each ingested chunk. Delete or invalidate indexed content on delete, move, membership and permission changes. Re-fetch the current source for evidence where practical.

Before showing an answer to an end user, recheck the current user's permission:

```bash
curl -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  "$WORKSPACE_URL/api/v1/resources/$PAGE_ID/permissions/check?user_id=$END_USER_ID"
```

The API verifies that both the service and the active end-user membership can access the source. Treat missing, denied or failed checks as unavailable evidence. The endpoint expects a Workspace user ID; identity mapping between Intelligence and Workspace is an explicit integration responsibility. There is no impersonation token or OIDC identity bridge in this first pass.

## Route families

| Route | Purpose |
|---|---|
| `GET /api/v1/resources?parent_id=<id>&limit=100&offset=0` | Accessible children |
| `GET /api/v1/search?q=<text>` | Permission-filtered title/body/file search |
| `GET /api/v1/pages/:id/content` | Canonical blocks, text and source metadata |
| `PATCH /api/v1/pages/:id/content` | Replace content with `blocks` and `expected_revision` |
| `GET /api/v1/pages/:id/versions` | Checkpoints |
| `POST /api/v1/pages/:id/versions/:version/restore` | Restore with revision precondition |
| `GET /api/v1/databases/:id` | Schema and saved views |
| `GET /api/v1/databases/:id/records?view=<view_id>` | Filtered/sorted accessible records |
| `POST /api/v1/databases/:id/records` | Create `values` and full record page |
| `PATCH /api/v1/records/:id` | Merge `values` with `expected_revision` |
| `GET /api/v1/resources/:id/export?format=markdown` | Page Markdown; database supports CSV; both support JSON |
| `POST /api/v1/imports` | Queue Markdown/CSV with `parent_id`, `name`, `format`, `content` |
| `GET /api/v1/jobs/:id` | Caller-owned job status |
| `POST /api/v1/resources/:id/files` | Multipart private attachment |
| `GET /api/v1/files/:id/content` | Current-authorized bytes |
| `GET /api/v1/resources/:id/permissions` | Effective level and source ACL chain |
| `GET /api/v1/events?since=<ISO timestamp>` | Accessible event references |

Available scopes: workspace.read/write, pages.read/write, databases.read/write, files.read/write, users.read, permissions.read and events.read. Administrative settings require a human administrator session even if an integration has write scopes. Service credentials cannot open collaboration sockets.

Human cookie writes require the `csrf` value from `/api/v1/me` as `X-CSRF-Token`. Do not expose service tokens to browser JavaScript. JSON errors contain `error` and `request_id`; common statuses are 400 validation, 401 session invalid, 403 insufficient access/scope, 404 inaccessible or missing resource, 409 stale revision/conflict, 413 oversized payload and 429 rate limit.

## Signed events

The receiver gets minimal references, not page text or attachment contents:

```json
{
  "id": "event-uuid",
  "type": "page.updated",
  "tenant_id": "organisation-uuid",
  "resource_id": "page-uuid",
  "version": 4,
  "timestamp": "2026-09-29T00:00:00.000Z"
}
```

Headers are `X-Workspace-Event`, `X-Workspace-Timestamp` (Unix seconds) and `X-Workspace-Signature: sha256=<hex>`. Compute HMAC-SHA256 with the subscription signing secret over `<timestamp>.<exact raw request body>`. Compare using a timing-safe function and reject timestamps outside your replay window (for example five minutes). Persist event IDs for deduplication before processing. A retry has the same event ID but a fresh signed delivery timestamp.

Expect at-least-once delivery and tolerate duplicate/out-of-order references. Fetch current state through a scoped credential after verifying the event. Deletion and permission events must remove or reauthorize evidence. Never infer a user's access from the fact that an administrator configured a webhook.

The current event polling endpoint is a bounded timestamp-based feed without a durable cursor. Production ingestion should use webhooks plus a scheduled reconciliation scan; durable cursor pagination, dead-letter replay UI and bulk reconciliation endpoints are remaining work. State-changing events are written atomically with domain updates. All external writes by a future Intelligence agent should be explicit, scoped and independently audited; the default integration created here is read-only.
