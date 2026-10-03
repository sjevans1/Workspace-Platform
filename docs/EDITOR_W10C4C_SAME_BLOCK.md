# W10c4c — simultaneous same-block CRDT acceptance

**Candidate; do not mark accepted until exact-head CI completes.** Parent [W10c4 #100](https://github.com/sjevans1/Workspace-Platform/issues/100), [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74).

## Test
Two independently authenticated **browser contexts** open the same seeded quote and callout in a permissioned page. The two carets target opposite ends of the **same quote** before either writes, then both browser sessions insert distinct tokens concurrently over Hocuspocus/Yjs (not REST revision replacement). The suite demands both edits exactly once in canonical block JSON and plain text, stable block IDs/order, unchanged warning callout, and both sessions converged. Undo from one editor must remove only its insertion and preserve the peer's same-block contribution; redo must restore it. Both clients reload and revalidate.

**Limits:** two sessions on the same demo principal rather than two separately entitled users. This does not prove conflicting structural delete/reorder, in-flight ACL revoke, reconnect storms, remote offline queues or independent-device hardware. Those W10c4 checks remain open.

No change to the editor/runtime, paid BlockNote extension or OpenJM Enterprise AI. Release gates are exact-head PostgreSQL/RLS native, deployed Chromium/Firefox/a11y, release SBOM/Trivy/ClamAV and trusted HTTPS/WSS.
