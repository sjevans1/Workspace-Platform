# W10c3a — Browser HTML paste and canonical URL security

**Draft acceptance candidate, not yet merged.** [W10c3 Issue #97](https://github.com/sjevans1/Workspace-Platform/issues/97), W10c parent #92.

## Tests
- Real Chromium clipboard HTML data and keyboard paste into the installed BlockNote 0.55 Core editor; no synthetic paste event that the editor might silently ignore.
- Preserve heading and bold/plain approved content through committed canonical page API and reload.
- Disallow scripts, SVG/image event handlers and javascript/data URL anchors from DOM and canonical stored blocks; no script/event execution.
- Native validateBlocks allowlist accepts http/https/mailto and workspace authenticated relative URLs; rejects javascript/data/vbscript/file/protocol-relative/malformed schemes.

## Scope boundary
This does not certify the entire rich-block matrix. Test code, not browser behavior alone, must establish each advertised block's Yjs persistence. Other remaining W10c criteria include code/tables/media, concurrent editing/reordering, offline/reconnect, backup restore and full mobile/touch.
Keep Workspace independent from OpenJM Enterprise AI and paid editor extensions. Full exact-head backend, real deployed browser, scans/ClamAV and HTTPS/WSS acceptance required before merge.
