# Connected Work UX contract (W29-P0/A2)

This document is the interaction contract the A2 egress work is built against. It
was written before implementation: the journeys decide the API shape, not the other
way round. It covers the three roles that touch provider connectivity, the states
each one can see, the permission boundary between them, and the mapping from every
screen element to the backend call that backs it.

Nothing here is a mock. Every control named below is wired to an authorized backend
behaviour in this package, and the browser lanes prove the journeys end to end.

## 1. The three roles

| Role                 | Plane                                           | Can see                                                                                                                                                                                     | Can never do                                                                                                                                            |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenJM operator      | Fleet console (`apps/fleet-web`, read-only BFF) | The **Fleet service's own** outbound-connection posture, its policy identity, the never-reachable classes, and a guarded diagnostic that answers "would this host and port be allowed under Fleet's policy?" | Change policy from the console, see credentials, tenant message content or raw addresses. The console is explicitly **Fleet-local**: it does not claim to diagnose a customer deployment |
| Client administrator | Customer Workspace (`Settings > Connections`)   | The provider catalog, the guided endpoint-readiness check for a chosen use case, the guided connection flow, and the connection lifecycle controls                                            | Grant itself private-network reach, disable TLS verification, or connect an unimplemented provider                                                        |
| End user / member    | Customer Workspace                              | Read-only status of the connections that exist, and what they may use them for                                                                                                                | Any connection or egress mutation; no policy editor, no exception toggle                                                                                 |

The boundary is enforced server-side: the operator plane and the customer plane have
separate services, separate credentials and separate read paths, and a customer
route cannot reach an operator route (or the reverse).

## 2. OpenJM operator journey

Scenario: an operator is asked why a customer's self-hosted mail server cannot be
reached, and must answer without touching tenant data.

**Scope boundary (corrected in review).** The console evaluates the *Fleet service
process's* own egress configuration and resolver. It answers "would Fleet's policy
permit this?" and says so on the page. It is not a per-deployment diagnosis: a
`ready` answer here does not prove that a customer deployment would permit the
destination, and a `blocked` answer here does not prove the customer is blocked. A
trusted, deployment-scoped policy-identity channel (count-only, no tenant content)
is required before the console can speak for a customer deployment; that is a
separately gated requirement before any real-provider activation. Until then the
surface is labelled Fleet-local and the equivalence claims are gone.

1. The operator signs in to the fleet console (unchanged bootstrap-token flow).
2. `Egress posture` (read-only page) shows:
   - a **scope** line naming the Fleet service process, with the note that this is
     not the policy of any customer deployment;
   - the Fleet process's policy **fingerprint** and configuration source, so two
     Fleet releases can be compared without disclosing the policy body;
   - whether public destinations are pinned to an allowlist, and how many operator
     rules exist;
   - whether an internal trust chain (CA bundle) is configured;
   - the classes that are never reachable, listed by class name only;
   - the last diagnostics this process answered, from the audit trail.
3. The operator enters the exact host and port from the customer's report and runs
   the diagnostic. The answer is one of the canonical states in section 5, with the
   matching reason, the next action, and the Fleet-local scope repeated. The
   diagnostic:
   - runs the SAME evaluator and resolver contract a real connection uses;
   - never opens a socket to the endpoint, so a blocked destination is not
     contacted to produce its denial;
   - is rate-limited per operator client, bounded in timing, and audited as
     `egress.diagnostic` with a bounded detail;
   - returns class names and a destination digest, never raw addresses, a URL path,
     the CA bundle, credentials or tenant content.
4. Policy authoring stays a deployment/operator-managed operation. The console is
   read-only and shows no "Apply" or "Save policy" control, because there is no safe
   operator-write capability in this package.

```
+-----------------------------------------------------------------------+
| OpenJM Fleet  |  Deployments  Alerts  Audit  Egress posture           |
+-----------------------------------------------------------------------+
| SCOPE: Fleet service process (local policy)                           |
|   This is not the policy of any customer deployment: a Ready answer   |
|   here does not prove a customer deployment would permit it.          |
|   Per-deployment effective-policy diagnosis is not implemented.       |
+-----------------------------------------------------------------------+
| Outbound provider egress                                              |
|   policy fingerprint  e3f1...9c22   source: Fleet service environment |
|   public destinations  pinned allowlist (2 rules)                     |
|   internal trust chain configured                                     |
|   never reachable  loopback · link-local · metadata · ...             |
+-----------------------------------------------------------------------+
| Diagnostic:  [ mail.internal.example ] [ 993 ]  [ Check destination ] |
|   BLOCKED BY OPERATOR POLICY                                          |
|   Destination resolves to private space and no operator rule          |
|   permits this host, port and range.                                  |
|   Scope: Fleet service process (local policy).                        |
+-----------------------------------------------------------------------+
| Recent diagnostics                                                    |
|   2026-10-15 09:12  denied mail.internal.example:993                  |
+-----------------------------------------------------------------------+
```

## 3. Client administrator journey

Scenario: an administrator wants to connect a mailbox on a mail server that is not
one of the built-in providers.

1. `Settings > Connections` shows a provider catalog: implemented providers are
   offered, declared-but-unimplemented providers are labelled **unavailable** and
   offer no Connect action.
2. `Endpoint readiness` is the guided entry point, and its choice is real:
   - step 1: choose the **use case** (custom mailbox over IMAP, custom mailbox over
     SMTP, or an HTTPS API endpoint). The choice selects the ports the check may
     consider and the guidance shown, and it is sent to the API, which answers for
     exactly that use case;
   - step 2: type the host and choose the port from that use case's set (TLS is
     required and not negotiable for these ports, so there is no control that could
     turn verification off);
   - step 3: press **Check network readiness**. The answer carries the canonical
     state, the summary, the use-case guidance and a grounded next action.
3. The check is DNS and policy only: it never opens a socket to the endpoint, so it
   cannot be used as a port scanner, and a blocked destination is not contacted to
   produce its message. It also runs outside any tenant database transaction, and
   both the resolution and the whole check are bounded, so a slow resolver can never
   occupy a pool connection.
4. If the answer is `private_requires_approval`, the screen explains that an OpenJM
   operator must approve internal destinations and that a workspace administrator
   cannot grant itself private reach.
5. Creating a connection is a guided flow, not a JSON form: the provider choice
   drives the fields shown (ownership, capabilities, and endpoint host/port when the
   provider needs an endpoint; the acceptance provider says plainly that it needs
   none). Raw provider JSON exists only under an explicit **Advanced configuration
   (JSON)** disclosure.
6. Connecting, disabling, enabling, rotating and revoking are deliberate operations:
   - selecting a use case or typing a host never mutates anything;
   - disable/enable and revoke open a review dialog that names the connection, the
     effect and the consequence, and only the confirm button calls the API;
   - revoke states plainly that the credential is destroyed and the granted
     capabilities are withdrawn;
   - busy, success and failure are visible per connection, and a failed mutation
     leaves the previous state on screen.

```
Settings > Connections
+---------------------------------------------------------------+
| Connections                                                   |
|   External services connected to this workspace.              |
|   [ Refresh ]                            [ New connection ]   |
+---------------------------------------------------------------+
| Endpoint readiness                                            |
|   Use case  [ Custom mailbox over IMAP                    v ] |
|   IMAP over TLS on port 993. Connecting needs the mailbox     |
|   host, port 993 and a credential the provider issues.        |
|   Host      [ mail.internal.example                       ]   |
|   Port      [ 993 (IMAP over TLS)                         v ] |
|   [ Check network readiness ]                                 |
|   ---------------------------------------------------------   |
|   BLOCKED BY OPERATOR POLICY                                  |
|   Destination resolves to private space and no operator rule  |
|   permits this host, port and range.                          |
|   Next: an OpenJM operator must approve this internal         |
|   destination. Workspace administrators cannot grant          |
|   private-network reach.                                      |
+---------------------------------------------------------------+
| Your connections                                              |
|   [row] Mailbox (synthetic)          [connected]              |
|         [Test] [Sync now] [Disable] [Events] [Revoke]         |
+---------------------------------------------------------------+
```

New connection (guided; JSON only under Advanced):

```
+---------------------------------------------------------------+
| New connection                                                |
|   Provider  [ Synthetic test provider                     v ] |
|   Label     [ Review mailbox                              ]   |
|   Ownership [ Delegated to me                             v ] |
|   Capabilities requested  [x] connection.health ...           |
|   This provider needs no endpoint configuration: it is the    |
|   acceptance test provider, and its credential is supplied on |
|   the next step.                                              |
|   > Advanced configuration (JSON)                             |
|   No secret is entered here.                                  |
|                                       [ Create connection ]   |
+---------------------------------------------------------------+
```

Confirm dialog (disable / enable / revoke):

```
+---------------------------------------------+
| Disable Mailbox (synthetic)?                |
| This stops sync and workflow actions for    |
| this connection. The stored credential is   |
| kept and the connection can be enabled      |
| again.                                      |
|                       [ Cancel ] [ Disable ]|
+---------------------------------------------+
```

## 4. End user / member journey

Scenario: a member wants to know whether their workspace can send a notification
through a connected account.

- The member sees a read-only list of the connections that exist, their status and
  the capabilities granted, in plain language.
- There is no endpoint-readiness form, no policy view and no lifecycle control: the
  member role cannot manage a shared connection, so no mutator is rendered at all.
- Their ordinary work is unchanged and uncluttered; the section is a status surface,
  not a configuration surface.

## 5. Canonical readiness states

One vocabulary, shared by the operator diagnostic and the customer check, so the two
planes can never disagree about what a state MEANS (they still answer for different
scopes, as section 2 states):

| State                                     | Meaning                                                  | Next action shown                         |
| ----------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| `ready`                                   | DNS and policy permit this host and port                 | Continue to connect                       |
| `blocked_by_operator_policy`              | A never-reachable class, or private space without a rule | Operator approval or a different endpoint |
| `private_requires_approval`               | Private/ULA address with no matching operator rule       | Ask the OpenJM operator                   |
| `dns_not_safe`                            | The hostname resolved to a blocked address               | Use a public endpoint                     |
| `dns_failure`                             | Resolution failed, timed out, or returned nothing usable | Check the hostname                        |
| `invalid_destination`                     | The host is not a valid canonical public name            | Correct the hostname                      |
| `unsupported_scheme` / `unsupported_port` | Only the use case's ports are supported                  | Choose a supported port                   |
| `tls_issue`                               | Reported by a real connection test, not by preflight     | Fix the certificate or trust chain        |
| `unreachable`                             | Reported by a real connection test, not by preflight     | Check connectivity                        |

Preflight never contacts the endpoint, so it never claims `tls_issue` or
`unreachable`; those come from the existing per-connection Test action, which runs
through the governed transport. Every answer also carries its `scope` and
`scope_note`, so a Fleet-local answer can never be mistaken for a deployment answer.

## 6. Screen-to-backend mapping

| Screen element                        | Backend                                                                                        | Authorization                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Provider catalog + availability       | `GET /api/v1/connectors/catalog` (existing, now with `endpoint_required`)                       | signed-in session                                                                   |
| Endpoint readiness check              | `POST /api/v1/connectors/endpoints/preflight` (new; `use_case` is one of the three)             | owner/admin re-read live in a short tenant transaction; human session; CSRF; 30/min |
| Guided connection create              | existing `POST /connectors/connections` (typed fields; JSON only under Advanced)                | owner/admin or connection owner                                                     |
| Connect / rotate / enable / revoke    | existing `POST /connectors/connections…` routes                                                 | owner/admin or connection owner                                                     |
| Connection test (TLS/transport truth) | existing `POST /connectors/connections/:id/test`                                                | owner/admin or connection owner                                                     |
| Fleet posture (Fleet-local)           | `GET /egress` on the fleet API (new, read-only)                                                 | operator bearer token, read budget                                                  |
| Fleet diagnostic (Fleet-local)        | `GET /egress/diagnostic?host&port` (new, read-only)                                             | operator bearer token, read budget, audited                                         |
| Fleet console page                    | `GET /egress` on the console (new, server-rendered HTML)                                        | console session cookie                                                              |

## 7. What this package deliberately does not do

- No real provider adapter is activated; only the synthetic provider is
  connectable, and every other provider is labelled unavailable.
- No OAuth flow, no billing, no WhatsApp scope change (A3/A4).
- The console remains read-only: policy authoring is a deployment operation.
- Preflight performs no outbound connection, by design, so it cannot be used as an
  SSRF or port-scanning oracle.
- Per-deployment effective-policy diagnosis from the console is **not implemented**:
  it needs a trusted, deployment-scoped policy-identity channel from each Workspace
  deployment (count-only, no tenant content), gated separately before any
  real-provider activation. The operator surface is Fleet-local until then.
