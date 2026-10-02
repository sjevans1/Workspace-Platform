# W08c — typed saved-view cursor sorts

**Status: ACCEPTED** in [PR #78](https://github.com/sjevans1/Workspace-Platform/pull/78), merged `b61061d3327950ef9738444d58191a8879e5fd3b` after [full run 36959041575](https://github.com/sjevans1/Workspace-Platform/actions/runs/36959041575) passed 85/85 native backend tests and complete deployment/browser/accessibility/HTTPS. W08 remains unchecked pending [live reordering and multiuser capacity #80](https://github.com/sjevans1/Workspace-Platform/issues/80).

## Additive behavior

The accepted encrypted `GET /api/v1/databases/:id/records/page` endpoint now supports saved table, board and calendar views sorting by **up to five scalar properties** with independent ASC or DESC direction. Supported scalar types: Title, Text, Number, Select, Status, Date, Checkbox, URL and Email. Multiselect/list, Person (complex), Relation, Formula and Rollup sorting remains excluded from the cursor API; the existing bounded legacy offset path is retained for legacy non-scalar saved views.

Each sort expression and the final `(position, UUID)` tie breaker are applied inside the same permission-filtered PostgreSQL statement. The cursor stores a bounded, encrypted array of the last visible row's sort values (string, finite number or null), its position+UUID, and the existing tenant, principal, role, database, view, configuration/field-type fingerprint, page size and expiry. All `sort_values` are generated from authenticated server records, **not request-controlled SQL or client-provided keys**. Every continuation rechecks tenant row-level security, effective direct-child ACL, and caller permissions before returning results.

- For every ascending or descending key, **NULLS LAST**; numeric JSON must genuinely be a JSON number before a numeric cast. Other accepted scalar fields follow existing PostgreSQL text ordering (not locale-independent JavaScript collation).
- Each sort comparison is lexicographically evaluated; equality falls through to subsequent keys, then to increasing `position, UUID`. Null cursor keys advance only among equally null entries in that sort position, allowing correct traversal of missing-value tails.
- Changing a saved sort, filter, property type, calendar month, principal, role, database, page size or token breaks cursor validation. Copying to another user or tenant never authorizes records. Token tampering/expiry is rejected.
- Per-field text sort cursor values are capped at 512 characters, total JSON sort keys at 900 characters and encoded token length at 2048. An over-limit pathological sort fails explicitly; clients can choose a shorter indexed/scalar property or use the bounded legacy page. Do not silently truncate a sort key.

## Concurrency boundary and next gate

Pagination is *not* a single MVCC snapshot across requests. If records are re-positioned while a user navigates, new ordering can move a row across the cursor boundary; revoked/trashed data is always excluded and authorization is reevaluated. True snapshot-style traversal or documented operational policy, plus multi-user 1k/10k+ latency, CPU/memory and long-lived browser runs remain required under W08; do not close #68 based only on this PR.

## Acceptance matrix

- Native PostgreSQL/RLS: numeric+text multi-field ascending/descending, equal sort values, missing/null tails, custom Board group, hidden target records, cross-user cursor, saved view edit invalidation, hostile mixed type/schema, tampering/expiry.
- Deployed Chromium: 102-record descending title view, Next/Previous across final page, old and new routes remain separate. Firefox/Chromium keyboard/accessibility, real browser workflow, encrypted recovery, Trivy/SBOM/ClamAV and trusted HTTPS/WSS remain mandatory unchanged release gates.
- No OpenJM Enterprise AI package, backend, model, credentials, database or storage dependencies; Workspace remains independent and installable without the AI system.
