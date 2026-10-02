# W10c3b — Pinned Core rich-block compatibility and table text indexing

**Candidate (not accepted until exact-head CI).** Parent W10c3 issue #97 and W10 #74. Starts at merge PR #98 (`c65b8e9`).

## Changes
- Query the installed **public `defaultBlockSpecs`** (BlockNote 0.55.0), not undocumented editor internals, and verify eight rich Core types are actually installed.
- Native tests exercise quote, codeBlock, toggleListItem, table, file, image, video, audio separately; each must preserve its type on shared client/server-schema Yjs encode/projection/replay. Media URLs are inert example.org fixtures, not browser/network fetch.
- Fix `textOf` used for page search text. Table `tableContent.rows[].cells[]` contains user-visible text, but prior logic only traversed `text`, `content`, `children`. Now read only user-visible cells; do **not** index props/media URLs/IDs or arbitrary object metadata.
- Deployed browser: write quote/code/table via permissioned revision-checked page API, verify Yjs canonical shape and visible table/text in **two authenticated sessions** and reload; search for a table-only cell phrase.

## Not yet proved
Native media persistence does not validate actual attachment retrieval/CSP/antivirus, remote URLs or UI previews. Broader table editing, accessibility/touch, concurrent reorganisations and encrypted host-backup restores are separate W10c release gates. Keep W10 and W10c incomplete. No OpenJM Enterprise AI dependence.
