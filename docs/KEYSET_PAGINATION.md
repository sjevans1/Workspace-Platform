# W08b — Encrypted keyset pagination foundation

**Status:** development candidate; not accepted or merged until exact-final-head full Workspace CI passes. [Roadmap #62](https://github.com/sjevans1/Workspace-Platform/issues/62), [W08 #68](https://github.com/sjevans1/Workspace-Platform/issues/68).

W08a PR #70 already merged with tested permission-first offset listing and bounded ACL rechecks. This slice adds a separate, opt-in `GET /api/v1/databases/:id/records-page?limit=100` endpoint, whose response has `items`, `has_more` and `next_cursor`. Pass a returned token as `?cursor=...` for the next page. It defaults to 100 records and enforces a range of 1–200. A continuation keeps the original page size.

## Security contract

- The AES-256-GCM token is opaque to callers. It encrypts the position and UUID of the last visible item, tenant, principal, role, source database, the fixed `default-position` scope, page size, version, issuance time and 15-minute expiry. Its HKDF key namespace differs from existing event and reconciliation cursors.
- A tampered, expired, cross-user, cross-database or role-changed token returns a generic 400 error. It cannot choose a role, a target tenant or a SQL predicate.
- SQL filters the direct-child resources using verified parent permission and indexed personal/wildcard ACL **before** applying `(position,id)` keyset and `LIMIT limit+1`. Each returned record receives a fresh batched ACL/tenant/parent recheck under forced tenant RLS.
- Limit+1 drives `has_more`, which reflects **accessible records**, not hidden-record positions or counts. Tokens never expose hidden UUIDs in base64-readable form. Revocations are evaluated anew per request.
- The original `GET /databases/:id/records` array and legacy-offset clients remain operational and unchanged.

## Deliberate limitations

This first keyset endpoint supports the default position-ordered table only: `(r.position ASC,r.id ASC)`. `view`, `month`, `offset`, arbitrary sort/filter and other unrecognized query arguments fail closed. A cursor is not a durable snapshot; insertions or position reorders during browsing follow current-order semantics and may change which rows appear. Subsequent W08 slices must extend encrypted query fingerprints to saved views, filters, board/calendar ordering and snapshot-safe concurrency before declaring W08 complete. The existing full CI, mobile/keyboard browser acceptance and larger-scale tests must still qualify.

Workspace is a self-contained product with no mandatory link to OpenJM Enterprise AI, any AI/LLM, or external cloud storage.
