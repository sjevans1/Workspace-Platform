# W09a — CSV preview and new-database typed column mapping

**Implementation candidate (not accepted):** W09a covers safe preview and column mapping for **new database imports only**. Parent [W09 Issue #73](https://github.com/sjevans1/Workspace-Platform/issues/73) and [Roadmap Issue #62](https://github.com/sjevans1/Workspace-Platform/issues/62) remain open. Do not declare full W09 finished: existing-target keyed updates, resumable jobs, streaming export, cancellation and large file support are subsequent slices.

## Existing behavior preserved

- `POST /api/v1/imports` still accepts Markdown and CSV with required `parent_id`, `format`, `name`, and `content`. Queued Markdown behavior does not change.
- CSV imports without explicit mapping keep their previous all-text (other than first title) semantics, with blank legacy titles represented as `Untitled`. All CSV imports keep the existing **2 MiB content**, **2,000 data-row**, **100 column**, **100,000-character record** limits, worker queue and savepoint.
- Worker rechecks **current membership and destination write permission at execution time**. Every mapped data value is converted and checked **before creating resources**, with the job's database savepoint providing atomic rollback on errors. A failed import leaves no partially imported new database.

## New bounded read-only API

`POST /api/v1/imports/preview` with `{ "parent_id": "<authorized-space-or-page>", "content": "<csv>" }`.

Uses the same strict parser as the worker, with BOM support, RFC-style quote handling, exactly matched row widths, no blank or case-insensitive duplicate headers, strict size/row/column bounds. Requires authenticated `databases.write` scope and an existing destination with current write permission. **This endpoint commits nothing and creates no jobs.**

Returns `{ columns: string[], row_count: number, mapping: {source,id,name,type}[], sample: string[][], warnings: string[] }`. Only the first five data rows are returned as sample. Suggests `title` for the first column and conservatively proposes numeric/ISO date/boolean when all non-empty values in the first 100 rows match; everything else defaults to text. Type inference is advisory, **not a guarantee**. Sample values may contain spreadsheet formulas and arbitrary text: the UI must render them as ordinary escaped text, never HTML.

## Explicit mapping

An optional `mapping` array is permitted on CSV `POST /imports`, ordered exactly as source headings. Every source header must occur once; skipped columns may set `skip: true`. Included columns need distinct, validated identifiers and precisely one Title column. Supported W09a types are Title, Text, Number, ISO Date (YYYY-MM-DD), Checkbox (literal true/false). Conversions reject malformed/overflow numeric values, invalid calendar dates, ambiguous booleans, empty **explicitly mapped** titles and unknown mappings. An invalid value late in the file fails the entire import atomically and gives a bounded row index, not full sensitive cell contents.

Current Workspace **Import your work** dialog requires a user click to preview a CSV, displays source sample values as escaped text, permits type edits, display-name edits and excluded fields, and requires approval before queuing. Markdown continues its existing import workflow.

## Security and acceptance

- No existing-record updates or matching are attempted; this prevents duplicate-key/hidden-record inference in W09a.
- No external AI/cloud inference, no customer file upload to third parties. Data resides in the existing customer-selected local/S3-compatible Workspace deployment.
- Native tests: strict CSV parser, BOM/quotes, malformed headers, conflicting mappings, conversion failure on last row, current tenant parent write permission and job ownership, worker rollback; deployed browser preview interaction. Full final-head TypeScript, restricted PostgreSQL/RLS, release build, ClamAV/EICAR, SBOM/Trivy, Chromium/Firefox accessibility, HTTPS/WSS and encrypted-storage recovery must pass before merge.
