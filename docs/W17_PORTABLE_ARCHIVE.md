# W17 Portable workspace archive

Status: acceptance in progress on [PR #158](https://github.com/sjevans1/Workspace-Platform/pull/158). Workspace stays standalone; no OpenJM Enterprise AI dependency.

## Implemented

- Bounded ZIP codec (`packages/portable-archive/index.ts`) using pinned `fflate 0.8.3`:
  - versioned `manifest.json`;
  - canonical relative-path validation and case-collision rejection;
  - per-entry SHA-256 + byte-length verification;
  - compressed/uncompressed/per-entry/entry-count limits;
  - per-entry and aggregate compression-ratio limits;
  - unsupported-version, truncation, undeclared-entry and checksum rejection.
- Tenant-safe subtree exporter (`apps/api/src/portable-export.ts`):
  - depth-32 / 5,000-resource bounded subtree;
  - fail-closed access recheck on every resource;
  - permission-presented database schemas so hidden relation/rollup target metadata never enters the archive;
  - portable page/record bodies, database schemas/views/records, and live attachment bytes;
  - Person values and computed formula/rollup values are not exported;
  - ACLs, tenant IDs, membership, credentials, Yjs state, comments, audit and notifications are never exported.
- Fresh-ID importer (`apps/api/src/portable-import.ts`):
  - validates archive and hierarchy before materialization;
  - collision-safe fresh resource, record and file IDs;
  - two-pass page-link, relation-database and related-record remapping;
  - source workspace roots import as a destination-inheriting space wrapper;
  - external/nonportable page, file, relation and Person references are dropped and reported rather than resolved by source UUID;
  - saved database views are sanitized against the imported schema;
  - imported documents rebuild Yjs state, search text and backlink indexes;
  - attachment MIME validation + malware scanning before writes;
  - compensating deletion for any imported storage objects if the transaction later fails.
- Async job/artifact lifecycle:
  - migration `019_job_artifacts.sql` adds tenant-RLS protected, expiring input/output artifacts;
  - `POST /resources/:id/export/archive/jobs` queues a read-only human archive export;
  - `POST /imports/archive?parent_id=...` validates and stages an encrypted archive input, then queues import;
  - worker rechecks active membership and operation-specific permissions at execution time;
  - `GET /jobs/:id/archive` authorizes and downloads completed output artifacts;
  - staged inputs are queued for durable deletion after successful consumption;
  - expired artifacts flow through the existing retryable `object_deletions` queue.
- UI:
  - Resource actions offer **Export workspace archive** and download the completed async artifact;
  - the existing Import dialog accepts Markdown, CSV, or Workspace ZIP archives;
  - archive imports preserve original titles and open the newly imported root when the job completes.
- Acceptance coverage:
  - hostile archive codec tests;
  - tenant-safe checked export with a real encrypted-storage attachment;
  - async semantic round trip covering fresh IDs, internal page links, related databases/records, Person-field omission, attachment bytes and ACL inheritance;
  - malware-rejected archive import rolls back the DB subtree and leaves no imported attachment blobs;
  - deployed-browser export/download/import workflow.

## Archive v1 layout

- `manifest.json`: format/version/root/counts and SHA-256 + byte length for every payload entry.
- `tree.json`: portable hierarchy metadata only.
- `documents/<resource-id>.json`: canonical blocks/plain text/revision.
- `databases/<database-id>.json`: permission-safe properties and saved views.
- `records/<database-id>/<record-id>.json`: portable stored values; no source user UUIDs or computed values.
- `files/index.json`: attachment metadata.
- `files/<file-id>.data`: attachment bytes.

All IDs in the archive are source-local references only. Import always allocates destination IDs and rewrites supported internal references after allocation.

## Explicit v1 exclusions

The archive does not migrate tenant IDs, memberships, ACL rows, sessions/service credentials, bookmarks/recent history, notifications, audit/outbox state, comments, or page-version history.

## Acceptance gate

W17 is ready for review only when the final exact head passes backend/typecheck/integration, hostile archive tests, deployed-browser archive workflow, accessibility, HTTPS/WSS, and no unresolved security/review findings.
