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
| `GET /api/v1/events/cursor?limit=100&cursor=<opaque>` | Resumable, signed keyset page of currently accessible event references; first page may use `since=<ISO>` |
| `GET /api/v1/events/reconcile?limit=50&cursor=<opaque>` | Encrypted, tenant/principal-bound keyset scan of currently readable resource references |

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

### Resumable event polling for OpenJM Intelligence

`GET /api/v1/events/cursor` complements (and does not change) the original array-returning `GET /api/v1/events`. The new endpoint requires `events.read` scope on service tokens and still applies **current resource permissions to each event**. It returns up to `limit` (1–200; default 100) scanned event references ordered by `(created_at, id)`, using PostgreSQL microsecond precision to prevent lost position on timestamp ties:

```json
{
  "events": [{ "id": "event-uuid", "tenant_id": "tenant-uuid", "type": "page.updated", "resource_id": "page-uuid", "version": 1, "created_at": "2026-10-01T12:00:00.000Z" }],
  "next_cursor": "event-v1.<signed-payload>.<signature>",
  "has_more": true
}
```

Begin with `?since=2026-10-01T00:00:00Z&limit=100` (or omit `since` for a full historical scan). Pass the returned `next_cursor` on subsequent calls. Even when `has_more=false`, **retain that cursor** and poll it later for new committed events. On some pages `events` may be empty while `has_more=true`: inaccessible references consume scan positions but are never returned. Keep following `next_cursor` until `has_more=false`. `cursor` and `since` cannot be combined.

Cursors are HMAC-authenticated and tenant/principal-bound. Treat them as opaque continuation values; do not parse or forge them. A cursor carried by another tenant or principal, or a tampered cursor, is rejected. Returned event IDs must still be deduplicated by the consumer, and content must always be fetched under the current permissions. A successful page is *not* proof of ongoing access.

**Consistency boundary:** this is a keyset read over already committed rows, **not** an exactly-once change-data-capture stream or a global commit-order log. A transaction that commits late with an older `created_at` can fall before a previously issued cursor. Continue using signed webhooks for prompt notification **plus a periodic overlapping `since` rescan (with event-ID deduplication) and a current-state reconciliation pass** for recovery. This also handles eventual permission changes. Avoid claiming complete ingestion solely from `has_more=false`.

### Current-state resource reconciliation (read-only)

`GET /api/v1/events/reconcile?limit=50` starts a **new full scan** of currently accessible resource references. Supply the returned `next_cursor` as `cursor` for subsequent pages, until `has_more=false`. Each result includes **only** `id`, `kind`, `parent_id` and `updated_at` (never resource content or permission grants):

```json
{
  "resources": [
    { "id": "d0000000-0000-4000-8000-000000000001", "kind": "page",
      "parent_id": "d0000000-0000-4000-8000-000000000002",
      "updated_at": "2026-10-01T12:00:00.000Z" }
  ],
  "next_cursor": "reconcile-v1.<encrypted-payload>",
  "has_more": true
}
```

`limit` is 1–100 (default 50), counting **scanned rows**, not visible references. A page may contain an empty `resources` array with `has_more=true`; continue following the cursor. The position includes potentially inaccessible IDs and is encrypted using a dedicated AES-256-GCM/HKDF key, rather than a merely signed/reversible payload. It is bound to the current tenant and authenticated principal, expires one hour after starting a pass, and rejects tampering or cross-principal reuse. Restart the full pass when it expires. Service tokens require `events.read` and the matching `workspace.read`, `pages.read` or `databases.read` scope for each resource kind; current ACLs and PostgreSQL tenant RLS are applied to every item. A token with `events.read` alone will enumerate no resource references.

**Consistency limits:** this is bounded, read-committed keyset pagination by immutable resource ID, **not** a transactionally consistent snapshot, authority to view data later, or a guarantee of full change-data-capture history. Changes to permissions, moves, deletion and new inserts during a pass may alter visibility; resources inserted or newly granted behind the cursor are found on a future **new** full pass. An expired, interrupted or partial pass must never trigger deletion of cached/indexed content solely because an ID was absent. A single completed pass is not a strong guarantee either when permissions mutate concurrently. Repeat full scans and use event overlap to distinguish transient absence before proposing conservative stale-record cleanup.

**OpenJM Intelligence recovery algorithm:** process verified signed webhooks and deduplicate event IDs; periodically rescan a bounded overlapping `since` window of `/events/cursor` because commit-time ordering is not guaranteed; complete regular full `/events/reconcile` passes from a blank cursor with the **same** tenant/principal/scopes; compare only successfully completed passes and mark apparently absent references as candidates for removal, repeating the scan before cleanup. Independently reauthorize every content fetch and every retrieval/inference exposure against current Workspace permissions. On denial, fail closed and quarantine or remove stale cached evidence immediately rather than continuing to serve it. Never treat these lists as permission grants, and do not publish an Intelligence-only index to principals whose current authorization has not been checked. No writes, external calls or automatic customer-facing actions are performed by this endpoint.

### Administrator dead-delivery replay

Workspace administrators may requeue an individual **dead** webhook delivery:

```bash
curl -X POST -H "Cookie: workspace_session=$SESSION" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  "$WORKSPACE_URL/api/v1/webhooks/deliveries/$DELIVERY_ID/replay"
```

This action is available only to the owning tenant's active **owner or admin** session. It requires an existing dead delivery on an **active** subscription. Requests for in-flight, delivered, missing, foreign-tenant or inactive-subscription deliveries return the same 404; other roles receive 403. A successful response requeues the **same event ID and original subscription** as `pending` with cleared retry counters/error. The normal worker performs the outbound HTTP call; the administrator request never sends one directly. The operation emits an audit event `integration.delivery_replayed`. It intentionally does not replay completed deliveries or resurrect disabled subscriptions. Replay is *at-least-once* and receivers must deduplicate event IDs and perform current-permission checks before reading source content.

The administrator API and a per-delivery **Replay** button in Settings → Webhooks → Recent deliveries are implemented. The button is shown only for dead deliveries on active subscriptions; requests remain subject to the same server-side authorization and state checks. Bulk replay and bulk reconciliation remain future work. The original timestamp-based feed is unchanged. State-changing events are written atomically with domain updates. All external writes by a future Intelligence agent should be explicit, scoped and independently audited; the default integration created here is read-only.

### Staged signing-secret rotation

Settings → Webhooks provides **Prepare rotation**, **Activate secret**, and **Discard** controls. Prepare returns a new secret once, stores it encrypted, and keeps the current secret signing deliveries. Configure the receiver to accept both secrets, then activate. Activation replaces the current encrypted secret; later deliveries and dead-delivery replays use the new secret. Discard removes only a prepared secret. If the one-time prepared secret is lost, discard it and prepare another.

| Action | Administrator API | Body |
|---|---|---|
| Prepare | `POST /api/v1/webhooks/:id/secret-rotation` | `{"expected_revision":1}` |
| Activate | `POST /api/v1/webhooks/:id/secret-rotation/activate` | `{"expected_revision":2}` |
| Discard prepared secret | `DELETE /api/v1/webhooks/:id/secret-rotation` | `{"expected_revision":2}` |

Read `signing_revision` and `rotation_pending` from `GET /api/v1/webhooks` before each action. Every successful transition increments the revision; stale requests or an incompatible state return 409. Owner/admin sessions with CSRF are required; service tokens and other roles cannot rotate, and foreign-tenant IDs return 404. Neither subscription listings nor activation/discard responses return secrets. Each transition creates an `integration.secret_prepared`, `integration.secret_activated`, or `integration.secret_discarded` audit event. Backup/recovery retains the encrypted current/prepared secrets and revision, under the same deployment key and schema-version rules as other backups.

The worker retains a subscription read lock through its HTTP send and transaction commit, so activation waits for delivery transactions already signing with the current secret. This does not control a receiver's internal processing delay or requests already in transit. Keep the receiver accepting the previous secret for a short overlap period before retiring it. Rotation does not pause or revive subscriptions, change delivery IDs, or reset retry counters.
