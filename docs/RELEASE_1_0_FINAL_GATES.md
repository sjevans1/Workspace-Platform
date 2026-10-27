# Workspace 1.0 — final release gates

> **Handover note (2026-10-26):** This is the release acceptance contract, not a statement that W29, W30, the manual NVDA gate or W31 are finished. See [TEAM_HANDOVER.md](TEAM_HANDOVER.md) for the verified branch/PR snapshot.

**Authoritative checkpoint:** 2026-10-12 — scope rebaseline  
**Accepted baseline main:** `d9f269e864ab217aca9fde910dfe1fabf3b53b65`

This file is the concise release-state source of truth after the product owner promoted the previously discussed Connected Work and deterministic automation capabilities into the Workspace 1.0 build. Older statements that W29/W30 are post-1.0 are historical and no longer authoritative.

## Accepted baseline

- W01–W28 engineering/release work remains accepted baseline evidence.
- W27 final FULL `38319965439` passed on exact head `2d26dc83810549b68964c637e640dc8ed621cc72`.
- PR #214 merged W27 as `main@d9f269e864ab217aca9fde910dfe1fabf3b53b65`.
- Post-merge main verification `38323160547` passed.
- W27 #210 and shipped-image sub-gate #112 are closed.
- Existing W28/UAT host work may continue as preview/baseline evidence, but the accepted baseline SHA is no longer the final 1.0 tag candidate once W29/W30 are implemented.

Workspace must remain independently deployable with:
- no mandatory OpenJM Enterprise AI dependency;
- no mandatory LLM;
- no mandatory email/calendar/SaaS account;
- optional connectors off by default;
- native deterministic workflows usable without AI.

## Revised remaining release path

The fixed sequence is now:

`W29 Connected Work (#215) -> W30 Deterministic Workflows (#216) -> final NVDA (#211) -> W31 final requalification/tag (#217) -> Workspace 1.0 handover`

### W29 — Connected Work (#215)

First-class governed optional integrations:
- shared connector control plane;
- Google Workspace and Microsoft 365 provider adapters;
- external calendar integration distinct from native database calendar views;
- mailbox/email integration distinct from mandatory Workspace system SMTP;
- encrypted credentials/tokens, least-privilege scopes, sync cursors, retry/idempotency, health and audit;
- link/capture calendar events and email threads/messages into Workspace objects;
- explicit or policy-approved outbound calendar/email actions;
- Workspace remains fully functional with all connectors disabled.

Later Telegram/Discord/standards-based adapters may reuse the contract but are not silently required for W29 closure unless separately promoted.

### W30 — Native deterministic workflows (#216)

Native trigger -> condition -> action automation:
- event/manual/scheduled/date-relative/W29 triggers;
- safe deterministic conditions;
- native Workspace actions;
- W29 calendar/email actions;
- approvals for sensitive/external actions;
- deterministic timezone/DST scheduling;
- idempotency, retry/backoff, dead-letter, pause/resume and loop prevention;
- permission re-check at run time;
- versioned definitions and immutable run evidence;
- visual workflow builder, templates and run history;
- no LLM/agent dependency.

Future autonomous/LLM agent capabilities are outside this deterministic 1.0 requirement unless explicitly promoted later.

### Manual accessibility — NVDA (#211)

The human-only NVDA gate must run against the **completed W29/W30 surface**, not merely the earlier pre-W29 UAT build. Automated Playwright/accessibility coverage cannot substitute for this evidence.

### W31 — final 1.0 requalification and tag (#217)

After W29, W30 and final NVDA:
- freeze the final exact release SHA;
- re-run complete CI-3L FULL acceptance;
- prove W27 security/image/supply-chain gates still pass;
- fresh independent-host install;
- prove standalone operation with connectors disabled;
- record real-provider Google/Microsoft connector acceptance separately and securely;
- validate workflow schedule/action/approval execution;
- backup/restore with connector metadata and workflow definitions/state;
- trusted HTTPS/Secure cookies/WSS;
- final accessibility/browser/visual/capacity acceptance;
- changelog/support matrix/runbooks/license/source package;
- explicit product-owner release approval;
- post-merge main verification;
- Workspace 1.0 tag and handover.

## No-scope-expansion rule

The 1.0 scope expansion is limited to the explicitly promoted W29/W30 requirements recorded in #215 and #216. Do not use this rebaseline to pull unrelated post-1.0 ideas into the release.

Any additional capability requires an explicit scope decision before implementation.
