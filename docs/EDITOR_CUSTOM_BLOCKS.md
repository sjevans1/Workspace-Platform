# W10b shared BlockNote schema — custom callout and divider

**Candidate, not accepted until exact-final-head CI.** [W10b Issue #90](https://github.com/sjevans1/Workspace-Platform/issues/90) / [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74) / [1.0 #62](https://github.com/sjevans1/Workspace-Platform/issues/62).

- `packages/editor/schema.tsx` extends installed BlockNote Core 0.55.0 defaults with app-owned `callout` (`inline` content + enumerated `info|warning|success` variant) and `divider` (content `none`).
- **One schema** is imported by the browser React/Hocuspocus editor and server `ServerBlockNoteEditor.create({schema})`. Both use canonical Yjs `document` fragment, not alternate HTML storage.
- Editor toolbar has separate `Insert callout` and `Insert divider` controls, absent while read-only, with existing permissions unchanged. Visuals are local CSS variables supporting light/dark theme.
- Native tests exercise Yjs encode -> project -> reapply with styled callout content, divider, invalid variant/text rejection. Deployed browser tests create both blocks and verify API Yjs projection, cross-session visibility and reload.
- Custom blocks render external HTML with app-specific attributes for portability. **Markdown output remains lossy:** no promise that a Markdown export/import preserves custom block semantics, style marks, table/media metadata or divider position. Do not silently substitute Markdown for the authoritative Yjs state.
- No paid editor plugin, cloud dependency or OpenJM Enterprise AI code.

**Outstanding W10 release evidence after this candidate:** complete default Core block matrix, hostile HTML paste, undo/redo, mobile/touch, simultaneous rich-block edits and history/restore. This slice alone does not mark W10 complete.
