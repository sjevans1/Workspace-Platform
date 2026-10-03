# W10c5b — Private Core file-block and non-inline attachment acceptance

**Candidate, pending exact-head CI.** This slice extends accepted [W10c5a PR #104](https://github.com/sjevans1/Workspace-Platform/pull/104). Parent issue [#102](https://github.com/sjevans1/Workspace-Platform/issues/102).

## Deployed-browser contract
- Upload a real local **text/plain attachment** through authenticated multipart and read the exact uploaded bytes from the app-owned `/api/v1/files/{id}/content` route; no remote URL or CDN.
- Prove **Content-Disposition: attachment**, `nosniff`, and `Cache-Control: no-store` so untrusted file content isn't silently rendered as an inline document.
- Put file name and private authenticated URL into the **actual pinned BlockNote Core `file` block** alongside rich content; assert canonical Yjs type, identity, props and absence of file bytes from indexed page text.
- Verify the attached filename renders in **two independent authenticated browser sessions**, and survives reload; both users retrieve identical permissioned bytes.
- Delete the attachment; ensure the authenticated URL becomes unavailable, even if old block metadata survives as historical content.

## Boundaries
This does not prove direct browser click/download UX, distinct-principal ACL revocation or backup/restore of binary objects. Nor does it assert audio/video playback, HTTP range-seek, mobile touch or malformed archive protection. Keep W10c5 and W10 open pending those separately recorded gates. Workspace remains independently deployable, with no OpenJM Enterprise AI edits.
