# W10a — BlockNote Core formatting and persistence matrix

**Status:** implementation candidate; full exact-head acceptance required. [Issue #74](https://github.com/sjevans1/Workspace-Platform/issues/74) and master [#62](https://github.com/sjevans1/Workspace-Platform/issues/62).

All four related dependencies are pinned to **0.55.0**: `@blocknote/core`, `@blocknote/react`, `@blocknote/mantine`, `@blocknote/server-util`. This slice adds small, keyboard-activatable formatting buttons without replacing BlockNoteView, Yjs or Hocuspocus.

| Core block / operation | Editor control | Native Yjs round-trip | Scope |
| --- | --- | --- | --- |
| Paragraph | Text | Candidate test | Core |
| Heading level 2 | H2 | Candidate test | Core |
| Bulleted list | Bullets | Candidate test | Core |
| Numbered list | Numbers | Candidate test | Core |
| Checklist | Existing BlockNote Core UI | Candidate test | Core |
| Bold / italic text | Bold / Italic | Candidate test | Core |
| Tables, quote and code | Built-in only where installed version supports them | Not yet signed off | W10b |
| Media/files | Existing authenticated upload | Not yet signed off across import/export | W10b |
| Custom callout / divider | None yet | Not yet signed off | W10b, **must share client and server schema** |

Server canonical Yjs bytes are authoritative. `blocksToMarkdownLossy()` and Markdown imports are deliberately *not* promised to preserve all rich features. The added native tests exercise the installed server editor through real serialization (without private schema introspection) and verify paragraph/heading/lists/checklist/text marks survive a server Yjs encode/project/re-encode round-trip, including input guards for malicious URLs, oversized JSON and deep nesting.

**Release boundary:** These controls disappear in read-only mode. Existing browser acceptance must additionally prove a heading/list survives reload and two-user collaboration without changing permission enforcement. This is not a claim of full W10 completion; callouts/dividers, tables/code/quote/media parity, paste/undo/touch, exact mobile and visual regression remain open. No paid extensions, no OpenJM Enterprise AI changes.
