# W09c — retry-safe CSV submissions (implementation candidate)

**Status: Draft, not accepted.** Parent [issue #85](https://github.com/sjevans1/Workspace-Platform/issues/85); W09 parent [#73](https://github.com/sjevans1/Workspace-Platform/issues/73). This proposal is restricted to the standalone Workspace repository. No OpenJM Enterprise AI integration.

## API contract

Optional `idempotency_key` for `POST /api/v1/imports` with `format:"csv"`: URL-safe opaque token of 16–128 characters. With no key, historical behavior remains unchanged. Markdown refuses a key. A single principal may reuse the same key only for **exactly the same canonical validated request**, including destination, target schema digest, name, mapping, CSV content and mode. The server SHA-256 digest binds operation version, tenant and principal, and stores a per-principal unique key; no raw CSV or key is logged in diagnostics.

Original submission: returns `{id,status:"pending"}`. Same key and exact payload (pending/completed/failed): returns **same ID and real status**, after current tenant membership, scope, parent and target write access are checked. Changed payload under same key fails HTTP 409 with generic message, not an existence oracle. Cross-tenant/principal key collisions do not share results. A changed target schema after the original job was submitted does not prevent an authorized retry from retrieving the existing job; the worker still rejects a stale schema at execution.

The database unique index makes concurrent same-key submissions yield only one job. The original worker already uses `FOR UPDATE SKIP LOCKED`, database savepoint and one tenant-scoped PostgreSQL transaction for records plus terminal status; re-running the worker does not append completed jobs again. The current bounded 2 MiB/2,000-row process is **atomic**, not mid-file resumable. Cancellation, committed batches and keyed upsert are not delivered by this slice.

## Client limitations

The import dialog uses `crypto.randomUUID()` from a direct user action and retains the same request signature/key on same-form retries. Editing data/settings rotates the key. A full browser restart discards this dialog-local token: loss-resistant cross-restart recovery UI requires separately persisted, privacy-reviewed job history (future slice). The server-side key remains durable across worker/API process restarts when the client can resubmit it.

## Release gate

Native PostgreSQL: concurrent same-key submission, completed-job replay, changed-payload conflict, bad-row retry, schema drift, role revocation and cross-tenant reads, immutable migrations; deployed browser: no duplicate append on repeated authorized request. Whole exact-final-head CI (typecheck, native RLS tests, release-image SBOM/Trivy/ClamAV, browser/a11y, TLS/WSS) must pass before merge. Overall W09 remains unchecked.
