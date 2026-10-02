# W10a — BlockNote Core formatting and persistence matrix

**Status:** W10a accepted as [PR #89](https://github.com/sjevans1/Workspace-Platform/pull/89), merged `a5b8810` after 96/96 native plus full exact-head browser/security/HTTPS CI. W10b accepted [PR #91](https://github.com/sjevans1/Workspace-Platform/pull/91), merged `0005d207` after 97/97 native, 20 browser passes (1 skipped) and full release gates. W10c1 accepted in PR #94, W10c2 accepted in PR #96, W10c3a accepted in PR #98. W10c3b below remains an unaccepted candidate. [Issue #74](https://github.com/sjevans1/Workspace-Platform/issues/74) and master [#62](https://github.com/sjevans1/Workspace-Platform/issues/62).

All four related dependencies are pinned to **0.55.0**: `@blocknote/core`, `@blocknote/react`, `@blocknote/mantine`, `@blocknote/server-util`. This slice adds small, keyboard-activatable formatting buttons without replacing BlockNoteView, Yjs or Hocuspocus.

| Core block / operation | Editor control | Native Yjs round-trip | Scope |
| --- | --- | --- | --- |
| Paragraph | Text | Accepted native test (W10a) | Core |
| Heading level 2 | H2 | Accepted native test (W10a) | Core |
| Bulleted list | Bullets | Accepted native test (W10a) | Core |
| Numbered list | Numbers | Accepted native test (W10a) | Core |
| Checklist | Existing BlockNote Core UI | Accepted native test (W10a) | Core |
| Bold / italic text | Bold / Italic | Accepted native test (W10a) | Core |
| Tables, quote and code | Built-in only where installed version supports them | Not yet signed off | W10b |
| Media/files | Existing authenticated upload | Not yet signed off across import/export | W10b |
| Custom callout / divider | Callout / Divider | Accepted native and deployed two-session reload (W10b) | Shared client/server schema |\n| H1/H3, underline, checklist, Undo/Redo | Accepted toolbar (W10c1) | Accepted legacy state + deployed keyboard/mobile ACL | W10c1 |

Server canonical Yjs bytes are authoritative. `blocksToMarkdownLossy()` and Markdown imports are deliberately *not* promised to preserve all rich features. The added native tests exercise the installed server editor through real serialization (without private schema introspection) and verify paragraph/heading/lists/checklist/text marks survive a server Yjs encode/project/re-encode round-trip, including input guards for malicious URLs, oversized JSON and deep nesting.

**Release boundary:** These controls disappear in read-only mode. Existing browser acceptance must additionally prove a heading/list survives reload and two-user collaboration without changing permission enforcement. This is not a claim of full W10 completion; tables/code/quote/media parity, paste/undo/touch, exact mobile and visual regression remain open. No paid extensions, no OpenJM Enterprise AI changes.

## W10c3a security accepted (PR #98, full exact-head CI #37062580900)

Chromium deployed paste acceptance uses the real Clipboard API and Ctrl/Meta+V to paste benign heading/strong text and attempted executable script, SVG/image event attributes and `javascript:` anchors. The browser must preserve benign content in the canonical server block projection, prevent script/event execution, strip dangerous links and survive reload. Native tests lock down accepted https/http/mailto/internal URLs and reject executable/protocol-relative URLs. This is accepted for the tested clipboard vectors, but does not certify every block type; Yjs stays authoritative.

## W10c3b core blocks (pending acceptance)

Native tests from the installed default BlockNote 0.55.0 public `defaultBlockSpecs` inventory now test quote, codeBlock, toggleListItem, table, file, image, audio and video separately for strict block-type preservation on `blocksToState` → `project` → Yjs reload. Media URLs use **local-memory fixtures only**; this is not a remote-media loading or file-security claim. Browser acceptance specifically tests quote, code and table across two authenticated sessions, reload and permission-filtered search text from table cells. Legacy basic formatting/callouts/dividers remain covered by earlier merged PRs.

**Unproven after W10c3b:** full media upload/preview/re-download and local storage, all nested block and table cell editing operations, concurrent reorder/undo semantics, touch, encrypted backup-and-restore. Keep W10 open.
