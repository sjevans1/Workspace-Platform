# W09b — explicit append-only CSV import into an existing database

**Status: implementation candidate, not accepted.** Follows W09a [PR #83](https://github.com/sjevans1/Workspace-Platform/pull/83), accepted with full CI (91/91). Master tracker [#62](https://github.com/sjevans1/Workspace-Platform/issues/62), parent W09 [#73](https://github.com/sjevans1/Workspace-Platform/issues/73).

## User workflow

In **Import your work**, choose a destination page/space, upload a CSV, choose **Append to an existing database** from the target list, then click **Preview CSV columns**. Workspace requires write access to both the chosen destination and target database and requires the target to be an immediate database child of the selected destination. The preview lists permitted importable scalar properties, proposes case-insensitive source-heading matches, and returns a **schema digest**. Unmatched headings default to skip until explicitly mapped; there must be exactly one mapped Title. CSV types: Title, Text, Number, ISO Date, Checkbox, identical to W09a.

Review the source-to-target mapping, then explicitly select **Confirm append-only import** before clicking Import. Appending always **creates new records**. It never searches by name, checks customer-defined business keys, updates, overwrites, deduplicates, soft-deletes, or guesses matches. Re-submitting an accepted import can create duplicates. Idempotent import keys and upsert mode require a separate governed W09 slice with visibility-safe key indexes. The user cannot use the worker to bypass relation/formula/rollup ACL boundaries.

## API and safety contract

- `POST /api/v1/imports/preview` has optional `target_database_id` and returns optional `target: {id,schema_digest,properties}` when it is authorized. It is **read-only**. Existing W09a previews without target remain unchanged.
- `POST /api/v1/imports` accepts optional `target_database_id`, `expected_schema_digest` (SHA-256 over authoritative target properties), and `existing_mode:"append"`. If a target is given, **all three**, plus explicit ordered CSV `mapping`, are required. The mapping must resolve to exact target property IDs and types. The API Fastify/OpenAPI schema must preserve these properties instead of silently stripping them.
- The queue validates current tenant membership, scope, destination and target write ACL, parent association and schema digest. The worker *revalidates every gate* after dequeuing and obtains a PostgreSQL `FOR UPDATE` lock on target database schema; a changed schema fails closed with the whole job marked failed.
- Shared CSV parser and converters preflight **all mapped cells** before the first record insert. Worker savepoint rolls back **all newly appended records** on any failure, including a malformed later row. No existing records are edited. Job status is visible only to the authorized job owner.
- W09a guardrails remain: 2 MiB content, 2,000 rows, 100 columns, 100,000-character cell, safe handling of BOM/quotes/duplicate headers, no raw invalid source cell contents in validation error messages. No cross-tenant target discovery or hidden duplicate-key probes.
- User credentials, databases, storage, workers and inference are fully standalone. No required OpenJM Enterprise AI integration, LLM, external object store or cloud provider.

## Remaining W09 scope

**Not completed by W09b:** idempotent duplicate detection, existing-row updates, conflict/optimistic revision strategy, resumable jobs with cancellation/partial progress, and large backpressured export. W09 must remain unchecked until these are explicitly accepted or re-scoped with user agreement.

## Final acceptance

Native restricted PostgreSQL tests: target and parent ACL, second tenant, title/types, worker execution-time permission revoke, late bad-row rollback, schema change between queue/worker, no overwrites, job isolation, legacy W09a and Markdown parity. Deployed browser: target selection, preview, exact property mapping, explicit append consent and safe cancel. Full exact-final-head TypeScript, native RLS, Next/build, backup/restore, image/SBOM/Trivy/ClamAV, Chromium/Firefox accessibility, trusted HTTPS/WSS. No bypass or lowered gates to pass CI.
