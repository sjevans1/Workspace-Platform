# W09e — durable, bounded database export

**Status:** implementation candidate on `feature/wave-o-w09e-durable-export`, awaiting exact-head acceptance.

Part of the W09 package ([#73](https://github.com/sjevans1/Workspace-Platform/issues/73)) and Wave O ([#167](https://github.com/sjevans1/Workspace-Platform/issues/167)). Standalone Workspace Platform scope only; no OpenJM Enterprise AI runtime dependency.

## What this adds

A user-owned, durable export job for databases. The job reuses the accepted W09 process-reliability machinery rather than introducing new architecture:

- the `jobs` table lease/claim/reclaim columns and `job_artifacts` (migrations 019 and 021);
- the encrypted object store (`packages/storage`) already used for archive input/output artifacts;
- the worker claim/reclaim/savepoint/expiry sweep in `apps/worker/src/worker.ts`;
- keyset pagination (`records(after)`) already accepted for W08 database listings.

The existing synchronous `GET /resources/:id/export` route is unchanged, including page Markdown/JSON behaviour.

## API

- `POST /api/v1/resources/:id/export/jobs` with `{ "format": "csv" | "json" }`. Requires a human session and live read access to the database. Queues a job whose payload is `{ format: "database_export", export_format, source_id }` and returns `{ id, status }`.
- `GET /api/v1/jobs/:id` — user-owned job status (unchanged route).
- `GET /api/v1/jobs/:id/export` — downloads the completed artifact. Rechecks job ownership, live resource permission and artifact expiry on every request.
- `POST /api/v1/jobs/:id/cancel` — unchanged for queued jobs. For a **running** durable export it records a cooperative cancellation request and returns `{ id, status: "cancelling" }`; the worker observes it between batches.

## Bounded processing

Rows are read with `records(q, a, database, tableView, 0, BATCH, after)` using a `position,id` keyset cursor and a fixed batch size of 500. There is no OFFSET scan and no all-rows-in-RAM materialisation: each batch is serialised to its output chunk and released before the next batch is read. Peak memory is bounded by the serialised artifact plus one batch, not by the full record set.

## Consistency model under concurrent edits

The export is a keyset scan, not a database snapshot. This matches the accepted W08 database pagination contract and is deliberate:

- Rows are ordered by the stable `position,id` keyset. Each batch is read in its own statement under `READ COMMITTED`.
- A row is emitted at most once, because the keyset advances strictly forward.
- Edits committed **before** a row is read are reflected; edits committed **after** a row has been read are not re-read.
- A row whose `position` changes across the batch boundary may be emitted on the other side of that boundary. This is the same bounded behaviour documented for W08 pagination and is not claimed to be snapshot consistency.
- Records trashed before their batch is scanned are omitted (`deleted_at IS NULL`); records trashed after being scanned remain in the artifact.
- The worker re-validates live membership and database access before producing anything. Access revoked before the job runs fails the job.

## Permission and download safety

- The worker rechecks current membership and database access with `requireAccess` at execution time, so a revoked membership fails the job.
- `GET /jobs/:id/export` rechecks job ownership and *current* resource permission on every request. Access revoked after generation blocks the download even though the encrypted artifact still exists.
- Artifacts are encrypted at rest by the storage layer and expire after 24 hours. An expired artifact returns 404.
- The download sets `X-Content-Type-Options: nosniff` and a UTF-8 encoded attachment filename.

## Formula-injection mitigation

CSV cells whose first character is `=`, `+`, `-`, `@`, tab or carriage return are prefixed with a single quote, matching the existing synchronous export mitigation. JSON output carries values verbatim.

## Cancellation and partial cleanup

A running export holds its `jobs` row `FOR UPDATE`, so a cancellation cannot be written to that row without blocking. The request is recorded in `job_cancellations` (tenant-RLS protected, no foreign key to avoid the same lock) and the worker checks it at every batch boundary. On observation the worker unwinds without killing the process, publishes no artifact, removes any pending object under the job's key, clears the signal and marks the job `cancelled`.

## Restart, reclaim and idempotent identity

The object key and artifact id are derived from the job id (`{tenant}/{database}/{jobId}`). Before writing, the worker deletes any object left under that key by a crashed attempt, and the `job_artifacts_one_kind_per_job` unique index guarantees a single output row. A worker that crashes mid-export rolls its transaction back (so no artifact row is committed) and its lease expires, after which another worker reclaims and completes the job.

## Client disconnect

The export runs in the worker, independently of the requesting client. A client that disconnects after queuing the job does not affect it; the completed artifact remains downloadable.

## Acceptance

See `docs/CAPACITY_1_0.md` for the measured 10k-row qualification, and `tests/integration.test.ts` (test `W09e durable database export is bounded, permission-safe and cancellable`) and `e2e/workspace.spec.ts` (test `W09e browser downloads a durable database export`) for the native and deployed-browser evidence.
