# W18: Interrupted-edit draft recovery

Status: first slice open (device-local recovery for the page editor).

## Scope from the roadmap

Bounded recoverable device-local drafts and explicit reconnection/conflict UX
for unsent edits. This is NOT full offline-first sync. Acceptance covers
process/network interruption, session expiry, ACL revocation, tenant switch
and shared-device privacy; no claim of server durability before ack;
documented local retention/security.

## What this slice implements

- `apps/web/lib/drafts.ts`: device-local draft store on `localStorage`.
  Drafts are keyed by page id, bound to the user id that produced them,
  capped at `MAX_DRAFTS` (oldest evicted) and `MAX_DRAFT_BYTES` per draft,
  and removed as soon as the server acknowledges persistence or the user
  discards them. Drafts are never sent to any server.
- `apps/web/components/Editor.tsx` wiring:
  - Local edits that the collaboration server has not acknowledged yet are
    accumulated and mirrored to the device draft on disconnect, pagehide,
    access change (authentication failure / permission reset) and unmount.
  - After a reconnect sync, a draft left by the same user on a still
    writable page is reapplied to the live document and the user is
    notified. Yjs deduplicates updates the server already persisted, so
    recovery never duplicates content (proved in unit tests).
  - A foreign-user draft or a draft on a read-only page (session expiry,
    ACL revocation) is never auto-applied; it stays on the device with an
    explicit "Discard saved draft" control.
  - Oversized unsaved change sets stop draft capture with an explicit
    notice instead of silently exceeding the cap.

## Retention and security notes

- Storage is `window.localStorage`, per browser profile, per origin. Draft
  bytes contain unsaved document content and stay on the device only.
- Tenant safety relies on the existing server-side collab ticket ACL: a
  draft is only applied after the current principal successfully obtains a
  writable collab ticket for that page.
- Retention is bounded: at most 10 drafts, 512 KiB per draft, evicted
  oldest-first, cleared on persisted ack or manual discard.

## Acceptance evidence for this slice

- `tests/editor-draft-recovery.test.ts`: 6 passing tests covering
  round-trip recovery, no-duplicate convergence, malformed/empty draft
  rejection, size cap, eviction bound and foreign-user handling.
- `npm run typecheck` clean; `tests/editor-core-matrix.test.ts` 16/16.

## Still open for W18 acceptance

- Browser/e2e journey: real disconnect mid-edit, reload, recovered content.
- Reconnection/conflict UX against a concurrent remote editor.
- Session-expiry and tenant-switch journeys in a real session.
- Documented retention window policy decision (currently: clear on ack or
  discard, no time-based expiry).
