# W10c5a — Local, permission-checked PNG blocks

**Draft candidate until exact-head full CI.** Parent [W10c5 #102](https://github.com/sjevans1/Workspace-Platform/issues/102) and [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74); starts after W10c4b [PR #103](https://github.com/sjevans1/Workspace-Platform/pull/103) merged `f5f7e6a`.

## What this slice proves
- In an actual deployed browser and authenticated API, upload a small **valid decodable 1x1 PNG**, receive an `/api/v1/files/{id}/content` URL, download and compare **exact bytes**, content type, `inline` disposition and `nosniff`.
- A false `.png` with wrong magic bytes is rejected 400 without a new file record.
- Store that **private local URL** in a Core `image` BlockNote block via revision-checked canonical Yjs state. Assert image type + URL survive projection.
- Open two independently logged-in browser sessions, assert the image actually decodes (browser `naturalWidth===1`) alongside a callout; reload both sessions and repeat; compare retrieved bytes in session two.
- Delete the file through its permissioned endpoint, verify subsequent GET 404 and absence from attachment catalog.

## Boundaries
No external image URL, proxy, paid extension or hosted CDN. A PNG signature is not full MIME safety validation; this test's browser decoding plus malware scanning gives specific additional evidence, not a universal media guarantee. File bytes are not restored via historical page revision; no audio/video playback, range/seek, image resizing, global revocation, scanner-down or mobile touch claim. These remain W10c5 / W10 / W23 gates. Workspace standalone, no OpenJM Enterprise AI changes.
