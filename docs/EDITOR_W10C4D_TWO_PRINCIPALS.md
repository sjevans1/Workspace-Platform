# W10c4d — distinct-principal live collaboration and ACL changes

**DRAFT: do not accept until exact-head full CI.** Parents [W10c4 #100](https://github.com/sjevans1/Workspace-Platform/issues/100), [W10 #74](https://github.com/sjevans1/Workspace-Platform/issues/74).

## Acceptance under test
One actual invited **member** account and a separate owner account (distinct session, identity and browser context) open the same page with canonical heading, quote and warning callout. Both editors put carets at opposite ends of the **same quote** and insert different tokens concurrently over Yjs/Hocuspocus. Both browsers and server projection must contain both once with the same three block IDs, order and unchanged callout variant.

While both sessions are live the owner changes the member's access to **view only** using the real Manage access UI. The member editor becomes non-editable and loses formatting controls; attempted typing does not change the server. The owner's subsequent change is still visible to the member. The owner then removes the member's grant and disables inheritance: the member's live editor, page text and toolbar disappear without reload; resource/content/version fetches and a new collaboration ticket return 404, while the owner's canonical content and block identities survive unchanged.

## Constraints and honest limitations
- This is stronger than PR #108's two separate browser sessions using the same demo principal. It does not simulate an already-in-flight revoked Yjs update, structural reorder/delete conflict, a reconnect storm, long network partition or a malicious handcrafted WebSocket frame. Track these separately under #100/W18/W19.
- No new editor runtime behavior, paid BlockNote feature, bypassed access check, rate-limit exemption, external SaaS, or OpenJM Enterprise AI code.
- CI must run real PostgreSQL/RLS native tests, production Compose browser tests with two principals, Chromium/Firefox keyboard/accessibility, release SBOM/Trivy/ClamAV and trusted HTTPS/WSS **on this PR's final head**.
