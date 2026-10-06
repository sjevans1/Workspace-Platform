# Event-driven CI orchestration

Issue: #132

## Goal

Wake the development agent when a relevant CI workflow reaches a terminal state instead of polling GitHub or requiring a human "check in".

This is development infrastructure for the standalone Workspace repository. It is not a runtime dependency of Workspace and it must never create a mandatory dependency on OpenJM Enterprise AI.

## Architecture

```text
GitHub Actions
    |
    | workflow_run: completed
    v
GitHub repository webhook
    |
    | HTTPS + X-Hub-Signature-256
    v
Cloudflare Worker receiver
    |
    | atomic X-GitHub-Delivery claim in D1
    v
Cloudflare Queue
    |
    | retry / dead-letter behavior
    v
Agent bridge endpoint
    |
    +--> success: inspect exact head and advance only the next allowed gate
    |
    +--> failure: inspect only failed jobs/steps/log excerpts, fix, push, stop
```

The receiver never fetches logs. This is deliberate: CI completion wakes an agent with a compact event; the agent queries GitHub only for the minimum evidence needed.

## Normalized event contract

Example:

```json
{
  "version": 1,
  "source": "github",
  "kind": "ci.workflow.completed",
  "delivery_id": "<github delivery guid>",
  "received_at": "2026-10-06T00:00:00.000Z",
  "repository": "sjevans1/Workspace-Platform",
  "workflow": {
    "id": 123,
    "name": "Workspace verification",
    "path": ".github/workflows/ci.yml",
    "run_id": 456,
    "run_number": 78,
    "run_attempt": 1,
    "event": "pull_request",
    "status": "completed",
    "conclusion": "failure",
    "head_sha": "<40-char sha>",
    "head_branch": "feature/example",
    "html_url": "https://github.com/..."
  },
  "pull_requests": [131],
  "next_action": "diagnose_failure"
}
```

`next_action` is advisory, not authority. The receiving agent must still verify current PR/roadmap state before mutating anything.

## Security model

1. GitHub webhook secret is stored as a Worker secret, never in source.
2. Every payload is authenticated with `X-Hub-Signature-256` before JSON parsing or queue work.
3. Repository and workflow allowlists reduce the accepted event surface.
4. `X-GitHub-Delivery` is claimed in D1 with a primary-key uniqueness constraint, so redelivery does not dispatch the same event twice.
5. The queue decouples GitHub's request timeout from downstream agent execution.
6. The agent bridge requires an independent bearer token.
7. The event contains CI metadata, not GitHub credentials, repository source, or logs.
8. A green event does not grant permission to merge by itself. The agent must verify exact-head acceptance and roadmap prerequisites.
9. A red event does not authorize broad log ingestion. Inspect failed jobs first, then only the relevant failing step/log range.

## Cloudflare resources

The implementation expects:

- one Worker,
- one D1 database bound as `DELIVERIES`,
- queue `workspace-ci-events`,
- dead-letter queue `workspace-ci-events-dlq`.

Cloudflare Queues are used so webhook receipt can complete quickly while downstream delivery has independent retries and DLQ handling.

## Deployment

From `tools/ci-orchestrator`:

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create the D1 database and replace `<replace-with-d1-database-id>`.
3. Apply `migrations/0001_github_deliveries.sql`.
4. Create `workspace-ci-events` and `workspace-ci-events-dlq`.
5. Set Worker secrets:
   - `GITHUB_WEBHOOK_SECRET`
   - `AGENT_DISPATCH_URL`
   - `AGENT_DISPATCH_TOKEN`
6. Deploy the Worker.
7. Confirm `GET /healthz` returns HTTP 200.
8. Configure the repository webhook URL as:
   `https://<worker-host>/github/webhook`
9. Use the same high-entropy value for the GitHub webhook secret and `GITHUB_WEBHOOK_SECRET`.
10. Subscribe only to **Workflow runs**.
11. Keep SSL verification enabled.
12. Send GitHub's ping/test delivery, then confirm a completed Workspace workflow produces one queued/agent event.

Do not put API keys or tokens in the webhook URL.

## Agent bridge contract

The Worker performs:

```http
POST $AGENT_DISPATCH_URL
Authorization: Bearer $AGENT_DISPATCH_TOKEN
Content-Type: application/json
X-CI-Event-ID: <delivery_id>
```

Body: the normalized event above.

The bridge should acknowledge accepted work with any 2xx response. Non-2xx responses cause the queue message to retry; after the configured maximum attempts Cloudflare sends it to the DLQ.

### Recommended bridge behavior

For `conclusion=success`:

1. verify that `head_sha` is still the relevant PR/current roadmap head;
2. verify all required jobs/checks, not merely this one workflow event;
3. capture acceptance evidence if this is an acceptance boundary;
4. merge/advance only when policy permits;
5. otherwise take no action.

For any non-success terminal conclusion:

1. fetch jobs for exactly `workflow.run_id`;
2. locate only failed/cancelled jobs;
3. inspect failed step summaries;
4. fetch logs only for the failing job when needed;
5. make the smallest correction;
6. push once and stop; the next CI completion event wakes the loop again.

This intentionally produces a **push -> CI -> event -> focused action -> push** cycle rather than a continuously polling agent.

## Local agent bridge

The repository also includes `tools/ci-orchestrator/src/bridge.mjs`. This is the second hop when the coding agent runs on a host you control.

The bridge:

- listens on `127.0.0.1:8788` by default;
- requires `Authorization: Bearer $CI_AGENT_BRIDGE_TOKEN`;
- durably spools accepted events before returning HTTP 202;
- deduplicates the GitHub delivery ID again at the bridge boundary;
- launches one configured executable without a shell;
- writes a JSON envelope to the child process on stdin;
- moves successful events to `done/`;
- returns failed launches to `pending/` so they can run again;
- tells the agent to stop after a push and await the next CI completion event.

Required bridge environment:

```text
CI_AGENT_BRIDGE_TOKEN=<independent high-entropy token>
CI_AGENT_COMMAND=<absolute or trusted PATH executable>
CI_AGENT_ARGS_JSON=["arg1","arg2"]
CI_AGENT_SPOOL_DIR=.data/ci-agent-bridge
CI_AGENT_BRIDGE_HOST=127.0.0.1
CI_AGENT_BRIDGE_PORT=8788
```

`CI_AGENT_ARGS_JSON` is parsed as an array and passed directly to `spawn(..., { shell: false })`. Do not configure a shell command string.

The configured agent executable must consume one JSON object from stdin:

```json
{
  "version": 1,
  "instruction": "<bounded continuation instruction>",
  "ci_event": { "...": "normalized CI event" }
}
```

For a local Hermes/Astra wrapper, the wrapper is responsible for converting that envelope into the agent's native invocation and for selecting the Workspace repository. The bridge intentionally does not know agent-specific CLI syntax.

### Exposing a local bridge

Do not bind the bridge directly to a public interface. If the agent runs on a workstation, expose `127.0.0.1:8788` through an authenticated reverse tunnel (for example Cloudflare Tunnel + Access/service-token policy) and point `AGENT_DISPATCH_URL` at that protected HTTPS endpoint. Keep the bridge bearer token even when the tunnel has its own authentication.

If the agent runs on an always-on cloud host, terminate HTTPS at the platform/reverse proxy and keep the bridge itself bound to loopback.

## Testing

Run:

```bash
npm run test:ci-orchestrator
```

The tests cover:

- valid signed completion,
- signature tampering,
- duplicate delivery suppression,
- repository/workflow filtering,
- success/failure normalization,
- authenticated downstream dispatch,
- retry on downstream failure.

The root GitHub Actions backend job runs this test suite independently from product tests.

## Failure and recovery

- **Receiver unavailable:** GitHub records a failed webhook delivery. Redeliver it after recovery.
- **Duplicate/redelivery:** D1 delivery ID makes normal replay idempotent.
- **Agent bridge unavailable:** Queue retries; exhausted messages move to the DLQ.
- **CI provider changes:** add an adapter that emits the same normalized event contract. Do not change agent policy.
- **GitHub Actions outage:** an alternate provider may emit the same contract, allowing the agent bridge and roadmap logic to remain unchanged.

## Phase 2

After Phase 1 proves reliable:

- add a GitHub App with read-only Actions/Pull Requests/Contents access so the bridge can retrieve exact failed-job metadata without a user token;
- add an alternate CI adapter (Forgejo/Codeberg or self-hosted runner);
- add explicit event/state telemetry and DLQ alerting;
- split the monolithic deployed browser gate into smaller diagnosable slices while keeping a single exact-head acceptance aggregate;
- reduce or disable the hourly polling automation once event delivery has demonstrated reliability.
