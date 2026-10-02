# W08b — encrypted, permission-safe database keyset pagination

**Status:** Candidate under review, not released. Follow-on to W08a, which was accepted in [PR #70](https://github.com/sjevans1/Workspace-Platform/pull/70) with exact-head 81/81 native tests and full deployment success. W08's release checkbox remains **open** until full cursor/view/performance acceptance is satisfied. Tracking: [Issue #75](https://github.com/sjevans1/Workspace-Platform/issues/75), [Issue #68](https://github.com/sjevans1/Workspace-Platform/issues/68) and [roadmap #62](https://github.com/sjevans1/Workspace-Platform/issues/62).

## Additive API

`GET /api/v1/databases/:id/records/page?limit=100[&view=UUID][&month=YYYY-MM][&cursor=opaque]`

Returns `{ "items": [...], "has_more": true|false, "next_cursor": "db-page-v1.<encrypted>"|null }`. Maximum page size 200. First page omits `cursor`; each next page must use the returned token and **identical** database, authenticated user/tenant, saved-view config, month and limit. The old `/records?offset=` array API remains available unchanged for compatibility.

- Applies the W08a SQL permission predicate **before** the indexed `(position,id)` keyset comparator and `LIMIT limit+1`, followed by current tenant RLS and independent bounded-ACL revalidation.
- Uses AES-256-GCM over a strict cursor envelope, HKDF-derived purpose-separated key from `ENCRYPTION_KEY`, 12-byte random nonce, 16-byte auth tag and authenticated associated data. Encoded token contains no plaintext record identifiers or sort positions. Maximum length 2048; TTL 30 minutes.
- Cursor binds version, tenant, principal, database, saved-view identity (or null), SHA-256 of the **validated effective view config and month**, page size, last position+UUID and timestamps. Any tampering, expiry, mismatch or malformed token fails with HTTP 400.
- Read permissions never derive from the cursor. Each new page independently checks the current DB ACL and surviving active records; a removed or hidden record may not reappear solely because it was formerly in a page.
- Default table, board and calendar view order is the indexed `position,id` ordering. **Saved views with custom sort** intentionally continue using bounded OFFSET until a typed null-aware/direction-aware keyset comparator is accepted; cursor API rejects them explicitly rather than silently mis-sorting. Formula/Relation/Rollup raw derived sorting/filtering remains disallowed.

## UI

The Workspace database table, board and monthly calendar use encrypted Next/Previous continuation tokens for default sorting, with a previous-cursor history held in client memory. Switching view, month or newly created view resets navigation state. Custom-sorted views retain existing bounded pagination and results presentation. Cursor validity and view changes are handled by fresh backend validation, not front-end authorization shortcuts.

## Concurrency and support boundaries

The cursor describes a stable **position+UUID ordering**, not a database snapshot. If a record moves position between requests it can legitimately cross the pagination boundary; deterministic **unchanged** rows do not duplicate. Trashing or ACL revocation always fails closed. Expired cursors require restarting the view; a deployment encryption-key rotation invalidates previously issued tokens. This does not claim unlimited pagination, cross-transaction snapshot consistency, or production throughput SLOs.

## Release gates

Native PostgreSQL under `workspace_runtime`: 1k/10k mixed-ACL page continuation, hidden/trashed records, cursor tampering/cross-actor/view/month/limit/revision mismatch, bounded positions, saved-view invalidation, admin/member parity and no denied record IDs or counts in responses.

Deployed Chromium: configure and traverse a multi-page database through Next/Previous, verify reset on view/month and that the last page disables Next. Run full inherited project checks including TypeScript, native restricted-RLS tests, S3 encrypted recovery, SBOM/Trivy/ClamAV/EICAR, Chromium/Firefox accessibility and trusted HTTPS/WSS. Publish actual numbers, limitations and exact accepted commit/run only after green CI.

Workspace remains a standalone self-hosted product. No dependency on OpenJM Enterprise AI, LLM services, hosted databases or SaaS.
