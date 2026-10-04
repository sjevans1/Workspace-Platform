# W10c4e — accessible structural changes under live collaboration

**ACCEPTED:** [PR #110](https://github.com/sjevans1/Workspace-Platform/pull/110) merged `a4372a27a672147471ea4c0406b2777b22161703` following exact-head [CI #37172366202](https://github.com/sjevans1/Workspace-Platform/actions/runs/37172366202): backend 110/110; deployed browser 32 passed / 1 skipped; 4 compatibility, HTTPS/WSS, Trivy, SBOM and ClamAV successful. Same-block conflicting move-vs-delete remains W10c4f #111, unaccepted. Parent [W10c4 #100](https://github.com/sjevans1/Workspace-Platform/issues/100), [W10c #92](https://github.com/sjevans1/Workspace-Platform/issues/92), [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74).

## Customer-visible change

The existing installed BlockNote Core/Yjs editor exposes accessible **Move up**, **Move down** and **Delete block** actions in the Formatting toolbar for authorized editors. The actions use BlockNote's own transactions (`moveBlocksUp`, `moveBlocksDown`, `removeBlocks`) rather than reconstructing rich text from the lossy Markdown/JSON projection. Controls are absent when permission falls below edit level; server checks remain authoritative. Deleted blocks can be restored using the existing local Undo button.

## Required deployed acceptance

Two independent authenticated browser contexts connect to the same canonical Yjs document containing a stable heading, custom warning callout, Core quote and tail paragraph. One editor moves the callout while the peer concurrently appends quote text. Verify both clients and the permission-checked server show the same ordered original block identifiers and unchanged warning variant, with peer text preserved. Local undo/redo of the structural move must not erase peer edits. Then delete the callout while the peer continues editing; assert convergence, no reappearing ghost block, local undo/redo restoring/removing the same block identity, and fresh reload in both browsers.

## Boundaries

This does **not** prove cross-account authorization races (separately covered in W10c4d), conflict when *two clients concurrently delete/move the exact same block*, delayed/in-flight stale client updates after explicit revocation, network-partition/reconnect storms or multiple collaboration writers. Those remain explicit open W10c4/W18/W19 acceptance. No paid extensions, external services or Enterprise AI runtime coupling.

Exact-head acceptance requires native PostgreSQL/RLS, TypeScript/production build, deployed Chromium, Firefox keyboard/a11y, local files and S3 safety, SBOM/Trivy, ClamAV/EICAR, and HTTPS/WSS.
