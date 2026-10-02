# W10c4a — Live editor epoch restoration regression gate

**Draft, not accepted.** Parent [W10c4 #100](https://github.com/sjevans1/Workspace-Platform/issues/100), [W10c #92](https://github.com/sjevans1/Workspace-Platform/issues/92), and [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74).

## What the deployed acceptance test proves
- Two distinct authenticated browser contexts attach to the **same version-3 page** containing a temporary paragraph.
- A permissioned historical version restore advances the canonical revision and collaboration **epoch**, and subsequent `/collab` tickets bind a new room.
- **Without manual page reload**, both already-connected editors must receive the reset, reconnect to the new room and show restored heading, styled callout, divider and stable block IDs—not obsolete text.
- The reconnected second editor writes a fresh update; the first editor receives it and server canonical plain text contains new content but does not resurrect the old temporary paragraph.
- Existing 1-second permission/epoch `prune()` guard and `onStoreDocument` epoch check stay intact. Do not relax ACL/RLS for tests.

## Limitations
This is two **sessions**, not yet a two-principal editing policy or full concurrent block-reordering benchmark. W10c4 remains open for overlapping edits, reconnect storms, revoked writers and conflicts. Broader offline reliability and encrypted backup recovery belong to W18/W19/W23. No Enterprise AI/LLM/SaaS dependency.

Full exact-head backend, deployed browser, Chromium/Firefox keyboard, SBOM/Trivy/ClamAV and HTTPS/WSS acceptance required before merge.
