# W10c2 — Rich document history restore and hostile input acceptance

**ACCEPTED:** [W10c2 PR #96](https://github.com/sjevans1/Workspace-Platform/pull/96) merged `6a7430495615b3136c75562a18acd498dc54182b` after clean exact-head [CI #37061157674](https://github.com/sjevans1/Workspace-Platform/actions/runs/37061157674): native 99/99, deployed browser/security/accessibility/HTTPS/WSS success.  W10c #92. Depends on accepted W10c1 PR #94 on standalone Workspace main.

## Verification contract
- A browser user creates a page and stores callout, divider, heading and checklist with explicit stable block IDs, marks and safe variant.
- A subsequent content replacement saves that canonical rich document into the history API, and one historical revision is retrieved by ID.
- Stale expected_revision restore requests fail with HTTP 409. Correct restoration preserves canonical block IDs, variant, bold/underline marks, position, revision monotonicity and a new collaboration epoch.
- The persisted restored document renders visibly for a first and second authenticated browser session. Prior historical version remains available.
- Unsafe javascript link, invalid callout variant and divider with illicit content all fail with HTTP 400 and leave revision and content unchanged.
- Native shared BlockNote Core 0.55/Yjs snapshot encoding round-trip preserves explicit IDs, rich props and marks.

## Release boundary
This verifies normalised canonical blocks and Yjs replay, not byte-for-byte equivalence of the historical raw Yjs state. The existing replacement path reconstructs Yjs from blocks; CRDT event identity and arbitrary client annotations are not asserted.
Remaining W10 scope: untrusted HTML paste, complete table/quote/code/media block matrix, simultaneous reorder/conflict scenarios, full backup restore, device touch and offline reconnection.
Full final-head native/real browser/security/HTTPS/WSS must pass. No OpenJM Enterprise AI dependency.
