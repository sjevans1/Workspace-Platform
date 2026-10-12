# Workspace 1.0 — final release gates

**Authoritative checkpoint:** 2026-10-12  
**Reconciled baseline:** `main@017a1882669822cf40a07ab42aeddd7f9575375b`

This file is the concise release-state source of truth after Wave X and OCP closure. Older planning sections in the roadmap and delivery-wave documents are retained as history, not as instructions to restart accepted work.

## Accepted product scope

- W01–W26 are accepted for the Workspace 1.0 feature/product scope through the X5 closeout.
- X5 exact-head release acceptance completed on `3ec344931f0745af0b05c850c0c02ed6e2ec7ed4` with FULL run `38178739224` green.
- OCP-1 and OCP-2 are accepted and issue #198 is closed.
- OCP-2B final accepted candidate `b52c49ad68f6b4a29b73e75eb927e2879b044aa2` passed FULL run `38237353310`; PR #209 merged to `main@017a1882669822cf40a07ab42aeddd7f9575375b`.
- Post-merge main verification run `38240845145` passed FAST + backend; deployment was correctly skipped for the push tier.
- SMTP is not a Workspace 1.0 blocker: W04 intentionally ships mail-free admin-assisted recovery.
- W29 Connected Work and W30 Native Automation & Agent Runtime are post-1.0 and must not enter the release blocker list.

## Remaining release path

The fixed sequence is:

`release reconciliation -> W27 (#210) -> manual NVDA (#211) -> W28 (#212) -> Workspace 1.0 tag/handover`

### W27 — security, privacy and commercial distribution (#210)

Final governance and hardening only. Do not reopen accepted product functionality unless review finds a genuine release-blocking defect.

Required areas:
- threat-model/adversarial review;
- dependency/image/SBOM/vulnerability policy;
- secrets and key-rotation operations;
- privacy/retention configuration;
- license/notices/corresponding-source obligations;
- public-repository secret/private-data check;
- trusted TLS/Secure-cookie/WSS and fleet transport review;
- standalone operation with OCP unavailable or disabled.

OCP hardening carried from #198 is explicitly bounded inside #210. Existing W27a issue #112 remains the full shipped-image SBOM/vulnerability-policy evidence lane, and CI-H1 #183 remains the GHCR mirror + immutable digest-pinning supply-chain lane. Neither is a separate feature wave.

### Manual accessibility — NVDA (#211)

X5 carried exactly one human-only evidence item: manual NVDA review. Automated Playwright, keyboard, WebKit/Chromium/Firefox, viewport and visual gates must not be represented as this manual proof.

If the manual pass finds a blocker, make only the bounded remediation required and requalify normally.

### W28 — independent-host RC and 1.0 tag (#212)

After W27 and #211 close:
- clean customer-like host;
- fresh install and setup;
- auth/onboarding/recovery;
- two-user authoring;
- database workflows;
- comments/notifications;
- import/export;
- attachment/AV path;
- encrypted backup + isolated restore;
- upgrade/preflight/rollback smoke;
- trusted HTTPS/Secure cookies/WSS;
- health/operations;
- optional OCP connectivity plus proof Workspace functions without it;
- changelog, support matrix, runbooks and release artifacts;
- exact release SHA, FULL CI, main verification and explicit sign-off.

## No-scope-expansion rule

No new product feature enters 1.0 after this checkpoint unless it is required to correct a release-blocking defect discovered by W27, manual accessibility review or W28 independent-host acceptance.

W29/W30 and other post-1.0 ideas stay deferred.
