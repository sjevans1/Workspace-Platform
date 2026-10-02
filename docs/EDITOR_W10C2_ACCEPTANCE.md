# W10c2 — version restore of rich collaboration blocks

**Draft candidate** in [W10c #92](https://github.com/sjevans1/Workspace-Platform/issues/92), continuing merged W10c1 [PR #94](https://github.com/sjevans1/Workspace-Platform/pull/94). Full final-head CI required before any acceptance/merge.

## Verified server design, not a claim of raw Yjs equality
- Version history stores both canonical `blocks` and `y_state`; `POST /pages/:id/versions/:version/restore` currently calls `replaceDocument`, which applies `blocksToState(old.blocks)` and advances the document's epoch/revision. The REST endpoint is *not* a raw-Yjs-state replay.
- W10c2 tests normalized BlockNote structure: explicit stable IDs, block order, warning callout props, bold/underline text marks, divider, checklist. They do not assert binary equality between unrelated Yjs encodings.
- The previous revision must be captured without destroying older versions; stale `expected_revision` must return 409.
- A pair of logged-in browser sessions open the replaced version, see canonical rich content after a historical restore and reload, and do not re-persist the superseded replacement text.
- No paid editor, external AI, or cross-repo changes.

## Limits
This slice does not prove full simultaneous-merge history semantics, backup restore to a separate host, malicious pasted HTML, all code/table/media types, touch input or offline rejoin. These remain under W10c/W18/W19. Do not check W10 complete.
