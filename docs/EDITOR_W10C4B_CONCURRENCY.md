# W10c4b — Concurrent rich edits and local history isolation

**Accepted:** [PR #103](https://github.com/sjevans1/Workspace-Platform/pull/103) merged `f5f7e6a` after exact-head [CI #37138988506](https://github.com/sjevans1/Workspace-Platform/actions/runs/37138988506): 110/110 native, 26 deployed-browser pass / 1 skipped, all release gates PASS. Parent [Issue #100](https://github.com/sjevans1/Workspace-Platform/issues/100) remains open for same-block/structural conflict gates.

## Acceptance slice

Two independent browser contexts authenticate, load the same live Yjs room and simultaneously type into **different** rich blocks (app-owned callout and installed Core quote). Both clients must converge to the same text; the permission-checked server projection must persist both changes without changing block ID, block order, type or callout variant. Undo on the first session must remove **only that session's** callout edit, not the second session's quote; redo must bring it back. Both clients reload and confirm persisted rich-state fidelity including the divider.

This is a deployed-browser test, not a simulation of the REST revision API. It uses real keyboard input through the deployed editor and a second independently logged-in browser context.

## Still open after this slice

Same-block concurrent editing, simultaneous move/reorder/delete, undo of structural edits, offline/reconnect storms, two-principal permission revoke, touch and media/backup recovery. These require separate focused acceptance before W10c4 and W10 are closed. No enterprise-AI repo changes or paid BlockNote features.
