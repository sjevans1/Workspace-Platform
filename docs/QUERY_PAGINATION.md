# W08 — permission-correct database pagination and query scaling

**Status:** Implementation candidate on an isolated branch, **not accepted**, not merged and not yet performance-qualified. Tracker [#68](https://github.com/sjevans1/Workspace-Platform/issues/68) and [#62](https://github.com/sjevans1/Workspace-Platform/issues/62).

## Problem eliminated by this candidate

Previously the API applied SQL LIMIT/OFFSET to raw tenant-visible rows and then discarded those the requesting user could not read. A person with access to record 5 but not records 1–4 could receive an empty first page even though accessible rows were available. The number of rows returned and offsets could reveal hidden-record distribution.

## Candidate solution

A new checksum-pinned SQL migration `012_accessible_resource_predicate.sql` defines `workspace_can_read_resource(resource, actor, role)`, a `STABLE SECURITY INVOKER` PostgreSQL function. It walks the same root-to-resource hierarchy as `packages/permissions/index.ts::evaluate()`: respects trashed ancestors, 64-depth/cycle limit, inherited ACL reset, person-specific grant over wildcard grant, and the early zero-permission return. Owners/admins get level 4 only after live ancestry validation; tenant/member role is sourced from the authenticated API actor, never a request query parameter.

**Important:** The function is not `SECURITY DEFINER`; it executes under the `workspace_app` role, with `FORCE ROW LEVEL SECURITY` enabled on resources and ACL. Function execution is revoked from PUBLIC. The API evaluates the predicate **inside SQL WHERE before LIMIT/OFFSET**, then performs the existing JS access check again for each returned row. No hidden count, title or raw source offset is returned.

The existing table, board, month-calendar and saved-view routes continue using the same typed value filters and deterministic order. Formula, Relation and Rollup raw filtering/sorting remains rejected pending a separately proven ACL-aware derived-value query design. API offset is now validated as an integer from 0 through 50,000; limit remains capped at 200. This bounded legacy offset is transitional; a stable, principal-bound opaque keyset cursor is still a target of W08.

## Current acceptance evidence needed

- Native PostgreSQL with restricted `workspace_runtime` / `workspace_app`, two tenants, mixed ACL, guest with and without explicit ancestry grants, deleted/trashed ancestors, inherit reset, user-vs-wildcard priority, permission revocation/regrant, same-tenant changes, offset pages and wrong-tenant probes.
- Browser table/board/calendar pagination after ACL revocations, stable sort/filter and export preservation.
- A declared benchmark with at least 1k and 10k records; compare query plans/latency and total SQL function calls against a defined environment. Large-data latency might be unacceptable despite correctness and is **not** approved solely because a small regression passes.
- Native/build, encrypted S3 recovery, image/SBOM/Trivy, live ClamAV, Chromium+Firefox accessibility and HTTPS/WSS exact-final-head CI before a merge.

No AI integration required. No modifications to OpenJM Enterprise AI.