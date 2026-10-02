# W10c1 — editing controls, legacy compatibility and mobile acceptance

**Draft acceptance candidate:** [W10c issue #92](https://github.com/sjevans1/Workspace-Platform/issues/92), parent [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74). Do not check W10 off until the entire acceptance matrix is met.

## Product
- Toolbar uses installed self-hosted **BlockNote Core 0.55** commands: H1, H2, H3, checklist, underline, Undo and Redo. Every new action is explicitly guarded behind the same existing read-only ACL boundary and toolbar visibility as bold/italic and callout/divider. Button activation via keyboard is native.
- Editor history uses the collaboration-aware `editor.undo()` / `editor.redo()` methods. No ad hoc browser stack or plain-text save path.
- Existing Core-only 0.55 state is encoded by the default server editor and decoded under the new extended shared schema without modifying old persisted data; inspect paragraph text marks, heading levels and checked list.

## Evidence to gather in exact-head CI
- Node tests: legacy Yjs round-trip preserves styled content and blocks.
- Real deployed browser: atomic text insertion, Undo removal, Redo restoration, H1/H3 render, checklist persistence through canonical API, narrow 390px viewport without horizontal overflow, reload, and existing ACL suite hides/restores toolbar when access is reduced/restored.
- Normal backend + S3 + build + container/SBOM/Trivy/ClamAV + Chromium/Firefox/a11y/HTTPS/WSS unchanged.

## Still outside W10c1
Hostile pasted HTML, advanced table/quote/code/media roundtrip, collaboration conflict resolution, historical snapshot/backup restore, 2-device/touch input, offline rejoin and cross-version old-client awareness. Unsupported capabilities are **not** implied by a new toolbar button. No dependency on OpenJM Enterprise AI.
