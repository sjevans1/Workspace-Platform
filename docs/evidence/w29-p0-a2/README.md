# W29-P0/A2 review evidence

Real browser captures of the shipped A2 surfaces, taken against the real local stack
(Next.js web + API + worker + database), at the review's request so the visuals can be
inspected without a FULL run. Nothing here is a mock-up: every state was produced by
driving the application.

## Customer Workspace (`Settings > Connections`)

Each combination is captured at **desktop (1440x900)** and **phone (390x844)**, in
**light** and **dark** (the application's own appearance preference):

| File | What it shows |
|---|---|
| `connections-<viewport>-<theme>-readiness.png` | The guided readiness journey: the use-case choice, its guidance, the host field, and the port list limited to that use case. |
| `connections-<viewport>-<theme>-readiness-blocked.png` | A blocked answer. The host `localhost` is not a canonical public hostname, so this state is deterministic and needs no DNS. Note the error block, the next action, and the metadata line ending in "no endpoint contact". |
| `connections-<viewport>-<theme>-create-guided.png` | The guided connection flow: provider, label, ownership, capabilities, and the honest statement that the acceptance provider needs no endpoint configuration. Raw JSON is collapsed. |
| `connections-<viewport>-<theme>-create-advanced.png` | The same dialog with **Advanced configuration (JSON)** expanded: the only place raw provider JSON appears. |
| `connections-<viewport>-<theme>-confirm-disable.png` | The deliberate confirmation for a lifecycle change: it names the connection and the consequence, and only the confirm button calls the API. |

## OpenJM Fleet Console (operator plane)

| File | What it shows |
|---|---|
| `console-egress-desktop-posture.png`, `console-egress-tablet-posture.png` | The read-only egress posture, including the **Fleet-local scope notice** that states this is not any customer deployment's policy. |
| `console-egress-desktop-diagnostic.png`, `console-egress-tablet-diagnostic.png` | A diagnostic answer, with the scope repeated and "endpoint contacted: no". |

## Regenerating

The captures come from `scripts`-free one-off Playwright runs against `npm run dev`
with a fresh development database. The customer surfaces use the deterministic
`localhost` case so no DNS dependency is involved; the console surfaces use the
existing `e2e-fleet-console` harness fixtures.
