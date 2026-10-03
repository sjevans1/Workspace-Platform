# W10c5d — Mixed rich blocks and private media in encrypted backup

**Draft candidate: do not mark accepted without exact-head CI.** Extends the existing PostgreSQL + storage backup test after accepted mobile-touch [PR #106](https://github.com/sjevans1/Workspace-Platform/pull/106) (`5390685`).

## Test scope
- Set up a realistic canonical Yjs document with explicit stable IDs, heading, bold warning callout, table cells, a private Core image block and a private Core file block.
- Store **two actual local media objects**, including a valid PNG and a text attachment, under tenant/resource/file keys. Keep their private `/api/v1/files/{id}/content` URL metadata in the Yjs state and the canonical JSON blocks.
- Verify encrypted archive envelope (no plaintext), exact schema/key fingerprint, file-object checksums, wrong-key rejection, legacy plaintext disabled by default, and rejection of nonempty restore destinations.
- Independently corrupt either media object and prove restore rejects the archive **before** destination objects are written.
- Restore to an empty PostgreSQL database and empty storage, then prove rich Yjs replay, stable block IDs/types/marks, warning variant, table content, original private file URLs, two file metadata records, and byte-perfect private image + attachment.

## Not claimed
This PostgreSQL + in-memory Storage fixture is a logical backup acceptance test, **not** a proof of an independent-host operational recovery drill or live restore during concurrent editing. Full W23 remains open for real filesystem/S3-like provider restoration, maintenance downtime, disaster scenarios and source-server resilience. Real phones, streaming audio/video, same-block conflict and ACL change races also remain open under their respective trackers. No paid extension or OpenJM Enterprise AI dependency.
