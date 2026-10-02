# W07 — ACL-safe Relation Rollups

**Status:** Accepted in [PR #69](https://github.com/sjevans1/Workspace-Platform/pull/69), merged at `9070518b493a3224c56041e5da190ab5bbc2d48f` after successful exact-head native backend (78/78) and full deployed/security CI [run 36942830305](https://github.com/sjevans1/Workspace-Platform/actions/runs/36942830305). W08 query-scale/pagination limits remain unresolved; track [#68](https://github.com/sjevans1/Workspace-Platform/issues/68) and [#62](https://github.com/sjevans1/Workspace-Platform/issues/62).

## Product behavior

A Rollup is a read-only computed property on the source database. It names exactly one existing Relation property. For `sum`, `avg`, `min`, or `max`, it additionally names a Number property on the related database. `count` counts readable related records and does not use a numeric field.

Suggested example: create Projects→Clients via Relation, then add “Total active revenue” Rollup with source Relation `Clients`, operation `sum`, related numeric property `Revenue`. The computed value appears in record views, table/board cells and JSON/CSV exports; changes to permitted related Number records recompute on the next read.

## Security / visibility

1. First apply W05's `redactRelationValues(q,actor,...)` to remove any target IDs not currently readable by the caller.
2. In the same tenant-scoped transaction, inspect selected IDs again; a contributing row must remain in the exact source relation's target database, have `kind=record`, be active and satisfy `access(q,actor,row.id)`.
3. Aggregate **only those second-pass authorized records**. The caller may have fewer accessible links than the owner, and must not infer hidden records' counts or amounts from sum, average, exports, error strings or schema metadata.
4. Do not write Rollup output to the underlying JSON values or include it in search text. Reject client-supplied `rollup` values; avoid user-independent caches.
5. Reject unvalidated references to a missing Relation property, inaccessible target database or absent/non-Number target property. Raw filter/sort of virtual rollups is not supported until W08's permission-aware query work.

Numeric semantics: `count` returns the number of **currently visible linked records**; `sum` returns zero for no numeric values; `avg`, `min`, and `max` return null for empty numeric sets. Null/missing fields are ignored (but readable records still count in `count`). Reject nonfinite values and results beyond 1e12 magnitude as null. At most W05's 20 unique related IDs contribute, giving a bounded first implementation.

## Acceptance gates

- Native restricted PostgreSQL/RLS: two tenants; same-tenant member sees a source record but cannot see a selected target; link revoked after save; target moved/trash; related numeric value changed; sum/count/avg; malformed property config; read-only validation; JSON and CSV exports; forbidden derived sort/filter.
- Deployed browser: configure Rollup from an existing Relation and target Number field, link a record, render and recompute when amount changes.
- Full unchanged TypeScript/build, native PostgreSQL, encrypted local/S3 recovery, hardened container/SBOM/Trivy/ClamAV, Chromium/Firefox accessibility, and trusted TLS/WSS final-head checks.
- Current implementation performs permission checks per selected linked row; W08 must measure and optimize high-volume cases before claiming large-scale performance.

Workspace remains independently deployable. No mandatory OpenJM Enterprise AI, LLM or cloud provider dependency.