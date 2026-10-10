# X4a — security closure: W10c5e, W11, W12

Wave X X4a. Acceptance record. Mapped to the test or artefact that actually proves each clause; a clause is never marked complete because it is old.

Branch: `feature/wave-x-x4a-security-closure` from `main@88e29a1`.

## W10c5e — private attachment revocation

### How private attachment URLs are authorized (Phase 0 finding)

- The URL is an **application route**: `GET /api/v1/files/:id/content`. The upload response returns exactly `/api/v1/files/<file id>/content`.
- It carries **no capability**: no signature, no token, no query parameter, and never the storage `object_key`.
- The route loads the tenant-scoped file row, then calls `requireAccess(q, a, f.resource_id)` on **every** request. `requireAccess` computes `ancestry()` and `evaluate()` against live database permission state, so there is no cached allowance.
- Denial is already **non-enumerating**: `404` when the resource is not readable at all, `403` only when it is readable but below the required level.
- **Tenant isolation** comes from the tenant-scoped query plus RLS and the `files → resources` foreign key.
- A global `onRequest` hook sets `Cache-Control: no-store` on every response, so no client or proxy cache can replay bytes after revocation.

### Implementation

**No implementation change is required, and no second authorization model is introduced.** The behaviour W10c5e asks for is already the behaviour of the route: authorization is re-evaluated at access time against live state, fails closed, and does not disclose hidden resources. The genuine gap was proof, and the acceptance below closes it. `docs/WAVE_X_IMPLEMENTATION_PLAN.md` classified W10c5e as "implementation missing"; that classification is superseded by this inspection, and no rebuild was performed.

### Acceptance: a URL that demonstrably worked before revocation must stop working

| Requirement | Evidence |
| --- | --- |
| Authorized principal can access the attachment before revocation | `W10c5e a previously working private attachment URL is denied after revocation` (native) — same URL returns 200 with the exact bytes; `e2e/w10c5e-revocation.spec.ts` (browser) — the member's browser session returns 200 with the exact bytes |
| The same URL is captured/reused (not a newly generated one) | Both tests reuse one immutable URL string either side of revocation. The URL is a file id route, so the string is identical by construction; the native test also asserts the URL carries no token or query parameter |
| Access revoked, then the same URL is denied | Native: direct grant revoked → same URL 404. Browser: grant removed → same URL 404 in the member's own session, payload absent from the body and from the UI |
| Unrelated authorized principal still retains access | Native and browser: the owner still receives 200 with the exact bytes from the same URL |
| Tenant B cannot access tenant A attachment | Native: a separate tenant gets 404 for the same URL |
| Hidden/non-readable resource returns a non-enumerating denial | Native: 404, and the body does not mention the attachment name or the resource |
| Restore/restart does not resurrect revoked access | Native: a fresh session for the same principal is still denied and the stored policy shows the revocation; authorization is live database state, so nothing is cached that a restart could restore |
| Direct-child/inherited semantics stay consistent with W05/W10 rules | Native: an inherited grant through the parent space is used, then removed, denying the same URL, while the child stays readable to an authorized principal |
| Encrypted-at-rest, malware lifecycle, streaming/bounds behaviour preserved | Unchanged: no storage, scanning or streaming code was modified (the only product change in X4a is the W12 ordering tiebreaker) |
| No bypass through cached URLs or storage identifiers | `Cache-Control: no-store` on the download response is asserted in the native test; the URL is asserted not to contain the storage object key |

Principal classes: owner and member are covered directly. Guests and service principals are not granted attachment access by this contract, so no new support was invented for them.

## W11 — comments and mentions closure

Classification of the remaining clauses. All are acceptance-only; no missing implementation was found, and comments/mentions were not rebuilt.

| Clause | Status | Evidence |
| --- | --- | --- |
| Comment/reply state survives collaboration reconnect | **New coverage added** | `W11 reconnect: comment and reply state survive a collaboration reconnect` (native; provider destroyed and recreated) |
| Simultaneous users converge correctly | Already accepted | `W11d browser: two principals reply, resolve and revoke thread access`; document convergence is owned by the Wave R harness (`e2e/wave-r-harness.spec.ts`) |
| Permission revocation removes access to comments with the parent resource | Already accepted | `W11d` (browser, 404 for the revoked principal); `live permission changes update editability, and ancestor revocation removes API, search, file and live access` (native) |
| Revoked users cannot continue reading/posting via stale browser/session state | Already accepted | `W11d` (browser: the revoked principal's comments API returns 404 and a resolved-thread post returns 409) |
| Mentions do not disclose users/resources outside the permitted scope | Already accepted | `W11c native replies stay on the same resource and revoked mentions vanish` |
| Resolve/reply atomicity across reconnect/retry | Already accepted, extendable | `W11c concurrent resolve and reply serialize on the parent row lock` (native); the new reconnect test additionally proves a reply still lands and root-only threading is still refused after reconnect |
| Comment anchors valid or fail safely after editor changes | Already accepted | `W11a comment anchors require canonical same-page Yjs ID and current revision`; `W11b browser: anchored comment, orphan badge and preserved stale draft` |

## W12 — notifications closure

Internal/inbox notifications only. No SMTP and no external delivery provider, per the settled 1.0 decision.

| Clause | Status | Evidence |
| --- | --- | --- |
| Recipient-owned read/unread state persists | Already accepted | `W12b notification receipts require current recipient and page access`; `W12b browser: read/unread persisted across reload and unread filter` |
| Notification pagination is bounded and stable | **Implementation fix + new coverage** | `ORDER BY created_at DESC, id DESC` (was `created_at DESC`); `W12 notification pagination is bounded and stable, and retention is deterministic` proves the bound, stable repeated reads, and id-descending order within equal timestamps |
| Retention behaviour is deterministic/documented | **Documented + proved** | The accepted 1.0 scope promises no purge horizon, so retention is "until the resource or membership is removed". Proved: every returned row belongs to the requesting recipient and no notification outlives its resource (`notifications → resources` FK, `ON DELETE CASCADE` via the schema) |
| Permission revocation prevents using notification metadata to access revoked content | Already accepted | `W12b notification receipts require current recipient and page access` (recipient re-authorized on read and on every mutation); `W11d` proves a revoked resource disappears from `/notifications` |
| Stale notification links fail closed | Already accepted | `W12b` — an old notification identifier conveys no lasting capability: read-state mutation re-runs `requireAccess` on the resource |
| Tenant/user isolation enforced | Already accepted | `W12d alert preferences enforce recipient delivery modes under tenant RLS`; the list endpoint filters through `visible()` per recipient |
| Mention/reply dedupe survives retry/reconnect | Already accepted | `W12c reply notifications respect recipient ACL and mention deduplication` |
| Preferences are recipient-scoped | Already accepted | `W12d` (native) and `W12d browser: user controls mention and reply alerts with persisted preferences` |
| Hidden resource titles/metadata not leaked after revocation | Already accepted | `W11d` asserts the revoked resource is absent from `/notifications`; the list is filtered by `visible()` so a non-readable resource contributes nothing |

## Residual and manual items

- Manual assistive-technology sign-off (NVDA on Windows, Chromium and Firefox) remains human-only; no CI result here claims it.
- Penetration testing, threat-model review and red-team tenancy/file attack cases belong to W27, not X4a.
- W02/W03/W04 identity work and all of X4b are explicitly out of scope for X4a.
