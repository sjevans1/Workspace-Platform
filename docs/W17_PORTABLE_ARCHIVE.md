# W17 Portable workspace archive

Status: in progress on [PR #158](https://github.com/sjevans1/Workspace-Platform/pull/158) (draft). Workspace stays standalone; no OpenJM Enterprise AI dependency.

## Done

- Bounded ZIP codec (`packages/portable-archive/index.ts`): pinned fflate streaming ZIP, versioned `manifest.json`, canonical relative-path validation, case-collision rejection, per-entry SHA-256 + length checks, compressed/uncompressed/entry-count/per-entry bounds, per-entry and aggregate compression-ratio limits, unsupported-version/truncation/undeclared-entry rejection. Adversarial unit coverage in `tests/portable-archive.test.ts`.
- Tenant-safe subtree exporter (`apps/api/src/portable-export.ts`, `GET /api/v1/resources/:id/export/archive`):
  - recursive readable-subtree walk (depth 32, 5000-resource cap) with a fail-closed `requireAccess` re-check on every resource; a caller who can read only part of a tree gets an error instead of an archive that leaks hidden siblings or counts;
  - archive layout: `tree.json` (portable metadata only: id, parent, kind, title, icon, position), `documents/<id>.json`, `databases/<id>.json` with views, `records/<db>/<id>.json` with actor-visible presented values, `files/<id>.data` plus `files/index.json`;
  - attachment bytes are read through the Storage abstraction and must match the cataloged size exactly;
  - ACL rows, tenant identifiers, membership, Yjs states, comments, audit and notifications never enter the archive; export emits `export.performed`;
  - bounded errors: 413 on entry-count, record/file, attachment-size and archive-size overruns; 409 on stored-size mismatch or a subtree parent outside the archive.
- Integration acceptance `W17 portable archive export is tenant-safe, checksummed and bounded`: real upload, real archive bytes, manifest/count/tree/document/file assertions, no tenant-scoped fields, cross-tenant export fails closed.

## Remaining before ready-for-review

- async export/import jobs on the existing jobs + worker model and staged archive object lifecycle;
- fresh-ID allocation and second-pass remap of internal page links, database relations and record IDs on import;
- destination ACL inheritance (no transplant of source ACL/membership);
- antivirus on imported attachments and compensating storage cleanup;
- clean-target semantic round-trip acceptance including page links, relations and attachments, plus browser workflow.
