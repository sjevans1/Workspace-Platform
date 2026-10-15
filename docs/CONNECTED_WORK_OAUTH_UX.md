# Connected Work OAuth — UX and acceptance contract (A3)

> **Status:** pre-implementation product contract for W29-P0/A3 (#229). This document does **not** claim OAuth is shipped, nor that Google, Microsoft, Zoho or Fastmail accounts can be connected today.
>
> **Baseline:** `main@aa89038e998b8fade973557285501ff2d5efa826` following the A2 merge. Technical implementation brief: https://github.com/sjevans1/Workspace-Platform/issues/229#issuecomment-6185005826
>
> **Release gate:** #234 verified deployment-scoped egress posture **before the first real outbound-provider activation**. Test-only OAuth fixtures may exercise A3 without that activation.

## The product promise

A company administrator can authorize an external account for a shared workspace without handling access/refresh tokens; a member can authorize a private delegated account when permitted. Every step explains **what access is requested, what happens next, and whether the provider actually granted it**. External provider charges stay with the organization's own provider account.

The application should be simple for nontechnical users, but its underlying connection, credential, authorization and audit contracts must be tenant-safe, revocable and demonstrably correct.

### People and their boundaries

| Role | Allowed journey | Must not be possible |
| --- | --- | --- |
| OpenJM operator | Read platform/fleet health and future privacy-safe status; view existing Fleet-local egress posture | Initiate consent as a customer, see codes/tokens/private account details, edit customer permissions or claim deployment-specific egress evidence before #234 |
| Client owner/admin | Create and authorize *tenant-shared* accounts; review requested scopes; reconnect or revoke with explicit confirmation; see health/attention states | Enter arbitrary OAuth endpoint or scope, silently grant additional permissions, approve private-network reach, see raw OAuth tokens |
| End user/member | Create and authorize a *personal delegated* account if provider allows; use permitted shared connections; see their own account status | Create shared account, manage another user's delegated account, see another user's account identity/token |

### Representative scenarios

1. **Operations admin connects a shared calendar**: selects a supported provider, sees “Read calendar events” and “Create calendar events” as separate capabilities, confirms shared ownership and effective scopes, follows an external consent redirect. Workspace only shows **Connected** after tokens are securely committed and scopes validated.
2. **Member connects their own mailbox**: authorizes a personal connection; its account identity and management actions are not shown to unrelated members. Shared-account permissions are unchanged.
3. **Provider denies consent**: the connection stays `pending`; the user sees “Authorization not completed” and a safe **Try again** control. No false success.
4. **Refresh token is invalidated**: connection transitions to `attention_required` and shows “Reconnect required”; no further provider actions are attempted with an unusable grant.
5. **Admin revokes**: a review dialog states the effect on workflows and stored credentials. Once confirmed, local access stops immediately. A delayed callback or refresh response cannot restore the revoked connection.

## Actual interface, not a backend debug console

### Screen A — Connections catalog

```text
Connections                                    [Refresh]  [New connection]

Connect your organization's services. Workspace remains useful without them.

AVAILABLE                                         COMING LATER
[Provider card: logo, clear name]                 [Google Mail — unavailable]
Provider permissions: Read / Write / Send          [Microsoft Calendar — unavailable]
Account ownership: Personal / Shared             [Fastmail — unavailable]
[View permissions]  [Connect]                      No Connect button

YOUR CONNECTIONS
Shared Calendar      [Connected]      [View details]
My Mailbox           [Reconnect required] [Reconnect]
```

**Rules:** show **Connect** only when an actual registered OAuth descriptor and executable adapter are enabled. An A3 deterministic fake OAuth provider exists only in tests/nonproduction acceptance; never advertise it as a real SaaS integration.

### Screen B — New connection / authorization wizard

```text
Step 1 of 3: Provider & account         Step 2 of 3: Permissions & review

Account ownership                       Provider: <registered provider>
(o) My account   ( ) Shared workspace   Account: Shared with this workspace
Connection name [Operations Calendar]   Workspace will request:
                                         [x] Read events
[Continue]                              [ ] Create events
                                         Provider may bill your own account.
                                         No OpenJM-owned provider credit required.
                                         [Back] [Continue to provider]
```

No automatic durable permission changes from choosing a dropdown or ticking a capability. Requested capabilities/scopes are immutable for the active authorization attempt, and the review screen must name the account ownership, consent effects and external-account billing. Scope choices must come from provider metadata, not user-supplied free-text OAuth scopes.

### Screen C — Redirect, completion and failure

The click on **Continue to provider** starts a short-lived server-side authorization attempt and navigates to the operator-registered provider authorization URL. The application shows a recoverable waiting/pending state rather than assuming success. On callback, immediately redirect to a clean Workspace URL:

```text
[Connected ✓]
Operations Calendar
Account: operations@example.com (provider-supplied safe hint)
Ownership: Shared workspace
Approved: Read events, Create events
Last authorization: [timestamp]
[View details] [Disable]
```

If user cancels, provider denies, token exchange fails, the session expired or the returned scopes are insufficient, use honest states **Pending / Authorization denied / Could not connect / Reconnect required** with a safe retry. No tokens, PKCE verifier, authorization code, OAuth state, raw provider error description or client secret may appear in the cleaned URL, status API, telemetry, audit, screenshots or user-visible errors.

### Screen D — Connection detail and recovery

```text
Operations Calendar                     Status: Attention required
Provider / ownership / account hint
Last successful authorization     Last status check
Authorized capabilities           Granted provider scopes (safe labels)

Why action is needed
Your provider authorization is no longer valid.
[Reconnect account]              [Disable]
[Revoke connection...]             [View safe activity]
```

- **Reconnect** starts a NEW one-time authorization attempt; never changes a revoked connection back to connected.
- **Revoke connection** requires a focused dialog naming interrupted automation/sync and credential destruction, with Cancel and explicit **Revoke connection** buttons.
- **Refresh in progress** is non-blocking; it does not display tokens or claim success before commit.
- A revoked shared connection remains visible as historical status where authorized, but its action and sync controls disappear.
- Admin can manage shared; member can only manage own delegated connection. Other users see at most the safe shared status permitted by policy.

### State-to-action contract

| State | User-facing meaning | Allowed action |
| --- | --- | --- |
| `unavailable` | Provider metadata only; no executable adapter | Learn more, no Connect |
| `pending` | Connection exists but has no committed grant | Continue/Retry authorization |
| `authorizing` | One active, bounded authorization attempt | Cancel/Wait/Retry after expiry |
| `connected` | Encrypted token committed and scopes verified | View, sync/use if adapter permits, disable, revoke |
| `attention_required` | Consent denied, permission insufficient, invalid_grant or unsafe uncertain refresh | Reconnect, inspect safe status, revoke |
| `disabled` | User deliberately stopped new activity | Enable with confirmation if grant still valid, or reconnect |
| `revoked` | Local terminal state; credentials withdrawn | New connection only; no resurrection |
| `expired` | Authorization attempt timeout | Start a fresh attempt |
| `error` | Technical failure, with safe category only | Retry when safe, support guidance |

Provider-auth errors cannot be used to promote a pending connection to connected. Any successful network exchange whose local commit is uncertain must be reconciled honestly, not treated as authenticated or blindly retried.

## APIs and storage shaped by the interaction

| Interaction | Server operation | Security evidence |
| --- | --- | --- |
| Catalog and capability review | Registered OAuth descriptor via existing catalog, safe scopes/capabilities labels and `connectable` flag | No arbitrary provider URL/scopes from customer |
| Review → Continue | `POST /connectors/connections/:id/oauth/start` | Live human identity, manage access, tenant/connection/provider binding, immutable requested scopes, one-time state, PKCE S256 |
| Provider callback | `GET /connectors/oauth/callback` | Exact redirect URI; state/session/tenant/connection validation; consumed once; code exchanged outside DB transaction via A2; fenced credential commit |
| Pending/Connected status | Authorized connection status read (reuse public connection projection) | No code, state, verifier or token in response |
| Refresh | Leased background refresh phase | DB claim → release → governed network → fenced DB commit; no second concurrent refresh; honest unknown outcome |
| Reconnect | Start new attempt on same eligible non-revoked connection | New attempt generation invalidates old callback/refresh |
| Revoke | Existing confirmed revoke route + provider hook where supported | Local denial immediate; remote attempt bounded; old work cannot revive |

Existing login OIDC is not external connector consent. Do not reuse the login state table. Use the existing sealed credential envelope and FORCE RLS. A pending external authorization must not create an active grant before token/scopes commit; old provider responses must not expand capability or override revocation.

## Acceptance: three planes and falsification

**Security:** PKCE S256, hash-only state storage, session binding, one-time callback, expiry, replay/concurrency tests, tenant/membership/ownership negatives, wrong redirect, canceled/revoked during exchange, invalid scope, token leak scans, rotation and ambiguous refresh handling. OAuth token/refresh/revoke network I/O must use A2's validated-dial and run outside DB transaction.

**Functional:** Playwright drives a deterministic test-only provider through review → redirect → callback → connected, denial, stale callback, refresh-needed, reconnect and revoke. Every displayed action is backed by a real state transition, with explicit confirmation for destructive operations.

**Visual:** reviewable screenshots at desktop/phone in light/dark, plus empty/denied/attention/connected/confirmation. Keyboard focus on dialogs; status announcements for changing states; no raw JSON or fake live-provider success. The operator plane remains accurately scoped and non-mutating.

**No activation:** #234 deployment-scoped egress must be accepted before any real external provider adapter is made connectable. A3 remains a reusable, tested OAuth substrate and matching real UI, not a production Google/Microsoft integration.

**CI:** targeted + typecheck/build + one exact-head STANDARD at completed candidate; no FULL for A3 unless approved separately; independent Sol security and UX review; no merge without explicit user approval.
