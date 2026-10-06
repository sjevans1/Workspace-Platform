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

## Deployed Workspace instance

The live receiver is deployed as:

- Worker: `workspace-ci-orchestrator`
- Receiver: `https://workspace-ci-orchestrator.sjevans097.workers.dev`
- D1 database: `workspace-ci-orchestrator` (`347fbfc7-1407-4b6d-92d1-da6d6e584ed4`)
- Queue: `workspace-ci-events` (`226277fe6b584cfe9bac32280e868679`)
- DLQ: `workspace-ci-events-dlq` (`def60a0da7ce44889cb4e91c131d25bb`)
- GitHub repository webhook: hook `692802160`, active, `workflow_run` only, JSON content, SSL verification enabled
- Allowed repository: `sjevans1/Workspace-Platform`
- Allowed workflow: `Workspace verification` or `.github/workflows/ci.yml`

The deployed Worker secrets are named:

- `GITHUB_WEBHOOK_SECRET`
- `AGENT_DISPATCH_URL`
- `AGENT_DISPATCH_TOKEN`

Values are not stored in this repository. The host keeps secret files with mode `0600` under `~/.config/workspace-ci-orchestrator/`. The account-specific `wrangler.toml` is locally ignored through `.git/info/exclude`; `wrangler.toml.example` remains the committed template.

The bridge host currently has no Cloudflare-managed DNS zone. Cloudflare Access and a stable named public hostname therefore cannot be attached yet. The deployed bridge route uses a supervised Cloudflare Quick Tunnel with HTTPS transport, keeps the origin bound to loopback, and still requires the independent bridge bearer token. `run-quick-tunnel.mjs` updates `AGENT_DISPATCH_URL` and redeploys the Worker whenever a Quick Tunnel restart assigns a new hostname. Move this deployment to a named tunnel plus Access service-token policy when a managed zone is available. Do not remove the bridge bearer token after that migration.

## Trust boundaries

- **Fork pull requests fail closed.** `shouldProcessWorkflow` rejects any `workflow_run` whose `head_repository.full_name` is not the allowed repository, and rejects `pull_request` events with no `head_repository`. A fork PR can therefore never launch the privileged autonomous agent.
- **Only signed, allowlisted events enqueue.** The webhook requires a valid HMAC signature and matches the allowed repository plus workflow name/path before any D1 write or queue send.
- **Two independent layers protect the bridge.** The public route is an HTTPS Quick Tunnel (Cloudflare edge) in front of a loopback-only origin, and the bridge itself requires `Authorization: Bearer CI_AGENT_BRIDGE_TOKEN`.
- **Bridge secrets never reach the agent.** The Hermes wrapper strips `CI_AGENT_BRIDGE_TOKEN`, `AGENT_DISPATCH_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `CLOUDFLARE_API_TOKEN`, and `CF_API_TOKEN` from the environment it passes to Hermes, while leaving the agent's own provider/config variables intact.

## Deployment

From `tools/ci-orchestrator`:

1. Copy `wrangler.toml.example` to `wrangler.toml`.
2. Create the D1 database and replace `<replace-with-d1-database-id>`.
3. Apply the migrations in order: `migrations/0001_github_deliveries.sql` then `migrations/0002_delivery_queue_state.sql`.
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
- durably writes and fsyncs an immutable claim before returning HTTP 202;
- deduplicates the GitHub delivery ID again at the bridge boundary with one atomic claim file;
- launches one configured executable without a shell;
- writes a JSON envelope to the child process on stdin;
- moves successful events to `done/`;
- returns failed launches to `pending/` with persisted bounded exponential backoff;
- quarantines an event in `failed/` after 10 failed agent launches so it cannot starve later events;
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

### Hermes wrapper

`tools/ci-orchestrator/bin/hermes-wrapper.mjs` is the agent-specific adapter. It:

1. reads exactly one JSON envelope from stdin;
2. validates the instruction and normalized event contract;
3. verifies that the selected Git repository root has origin `sjevans1/Workspace-Platform`;
4. invokes Hermes without a shell as:

```text
hermes chat --query-file - --oneshot -Q --source tool \
  --in <Workspace-Platform-root> --run-budget 1800 --yolo
```

The wrapper sends the instruction and normalized CI metadata through stdin, returns Hermes' exit code, and never interpolates event data into a shell command. The bridge remains agent-neutral and only knows the wrapper executable path.

### Durable host services

The WSL host uses these enabled `systemd --user` units:

- `workspace-ci-agent-bridge.service`
- `workspace-ci-agent-tunnel.service`

Committed templates are under `tools/ci-orchestrator/systemd/`. Install them into `~/.config/systemd/user/`, adjust host paths, create the mode-`0600` environment files, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now workspace-ci-agent-bridge.service
systemctl --user enable --now workspace-ci-agent-tunnel.service
```

The bridge unit uses `Restart=on-failure`, a persistent `.data/ci-agent-bridge` spool, and one process managed by systemd. `claims/` is the immutable delivery ledger; `pending/`, `running/`, `done/`, and `failed/` are execution states; `retries/` stores attempt count and the next eligible timestamp. On startup, the bridge moves any orphaned `running/` event back to `pending/` and reconstructs a missing state link from its durable claim. This makes an interrupted agent launch recoverable without running two bridge instances.

Required local environment files and non-secret settings:

```text
~/.config/workspace-ci-orchestrator/bridge.env
  CI_AGENT_COMMAND=<repo>/tools/ci-orchestrator/bin/hermes-wrapper.mjs
  CI_AGENT_ARGS_JSON=[]
  CI_AGENT_SPOOL_DIR=<repo>/.data/ci-agent-bridge
  CI_AGENT_BRIDGE_HOST=127.0.0.1
  CI_AGENT_BRIDGE_PORT=8788
  WORKSPACE_PLATFORM_REPO=<repo>
  HERMES_BIN=<absolute Hermes executable>
  CI_HERMES_RUN_BUDGET_SECONDS=1800
  CI_HERMES_PROVIDER=openrouter
  CI_HERMES_MODEL=z-ai/glm-5.3-flash
  CI_AGENT_BRIDGE_TOKEN=<secret>

~/.config/workspace-ci-orchestrator/cloudflare.env
  CLOUDFLARE_ACCOUNT_ID=<account id>
  CF_API_TOKEN=<scoped Cloudflare token>
```

`CI_HERMES_PROVIDER` and `CI_HERMES_MODEL` are optional settings, not secrets. When both are set, the wrapper appends `--provider` and `--model` to the Hermes invocation so an event-driven run is pinned to one model instead of riding the configured fallback chain, which can silently land on a rate-limited free tier. When unset the flags are omitted and Hermes uses its own configuration. `CI_HERMES_MODEL` must be the provider's full model id.

The Quick Tunnel unit launches `run-quick-tunnel.mjs`. The supervisor waits for HTTPS health, writes the current public URL to `~/.config/workspace-ci-orchestrator/tunnel-url`, updates the Worker secret, and deploys the updated Worker version. A service restart therefore does not leave the Worker pointing at an expired Quick Tunnel hostname.

Service status and logs:

```bash
systemctl --user status workspace-ci-agent-bridge.service
systemctl --user status workspace-ci-agent-tunnel.service
journalctl --user-unit workspace-ci-agent-bridge.service -n 100 --no-pager
journalctl --user-unit workspace-ci-agent-tunnel.service -n 100 --no-pager
```

### Health checks

```bash
curl --fail https://workspace-ci-orchestrator.sjevans097.workers.dev/healthz
curl --fail http://127.0.0.1:8788/healthz
curl --fail "$(cat ~/.config/workspace-ci-orchestrator/tunnel-url)/healthz"
ss -ltnp 'sport = :8788'
```

The final command must show only `127.0.0.1:8788`, never `0.0.0.0:8788`.

## Testing

Run:

```bash
npm run test:ci-orchestrator
```

The tests cover:

- valid signed completion,
- signature tampering,
- duplicate delivery suppression and unqueued-claim recovery,
- fork pull request rejection,
- repository/workflow filtering,
- success/failure normalization,
- authenticated downstream dispatch,
- retry on downstream failure,
- atomic concurrent bridge dedupe, fsynced claims and startup recovery,
- agent-failure backoff, non-starvation and quarantine,
- Hermes wrapper origin validation, secret stripping and exit-code propagation,
- safe Quick Tunnel URL parsing, pinned Wrangler and supervisor exit behavior.

The root GitHub Actions backend job runs this test suite independently from product tests.

### Live end-to-end validation

Use a harmless branch or an event SHA that is deliberately stale. Never weaken a product gate to produce a test failure.

1. Push a harmless commit or use `workflow_dispatch` to run `Workspace verification`.
2. Confirm the exact-head run completes in GitHub Actions.
3. Inspect the repository webhook delivery and require HTTP 2xx.
4. Query D1 by the `X-GitHub-Delivery` ID.
5. Confirm one matching claim exists in `.data/ci-agent-bridge/claims` and its state link moves through `pending/` or `running/` to `done/`.
6. Confirm the bridge journal shows one Hermes session for that delivery.
7. Redeliver the same GitHub delivery or replay the same synthetic delivery ID and confirm D1 returns `duplicate: true` and no second spool file appears.
8. Confirm `git status --short` is unchanged when the test event is stale or requires no correction.

The initial live acceptance used stale SHA `0000000000000000000000000000000000000000`. Hermes checked GitHub, reported the event stale, changed no files, ran no tests, and pushed nothing. This proved automatic Hermes launch without creating an artificial repository mutation.

## Failure and recovery

- **Receiver unavailable:** GitHub records a failed webhook delivery. Restore the Worker and redeliver from repository webhook deliveries.
- **Duplicate/redelivery:** `github_deliveries.queued_at` is the durable ledger. A row with `queued_at` set is a true duplicate and is acknowledged without re-enqueueing; a row without `queued_at` means a prior attempt failed after the D1 write, so the redelivery re-enqueues instead of losing the event. There is no best-effort DELETE.
- **Agent bridge unavailable:** Queue delivery fails and retries. After `max_retries`, the normalized event moves to `workspace-ci-events-dlq`; it is not silently discarded.
- **Agent command fails:** `runOne` moves the event from `running/` back to `pending/` with a persisted exponential backoff. Other eligible events continue. After 10 failed launches, the state link moves to `failed/` for operator recovery while its immutable claim remains. An unexpected bridge-process exit leaves the event in `running/`; startup recovery returns it to `pending/` before the next launch. To redrive a quarantined event, stop the bridge, inspect only its operational metadata and root cause, move its `failed/<key>.json` link to `pending/<key>.json`, remove `retries/<key>.json`, then restart the bridge. Never delete `claims/<key>.json`.
- **Quick Tunnel restarts:** the tunnel supervisor obtains a new HTTPS hostname, health-checks it, updates `AGENT_DISPATCH_URL`, deploys the Worker, and writes the current URL file.
- **CI provider changes:** add an adapter that emits the same normalized event contract. Do not change agent policy.
- **GitHub Actions outage:** an alternate provider may emit the same contract, allowing the agent bridge and roadmap logic to remain unchanged.

Restart and verify the local path with:

```bash
systemctl --user restart workspace-ci-agent-bridge.service
systemctl --user restart workspace-ci-agent-tunnel.service
systemctl --user is-active workspace-ci-agent-bridge.service workspace-ci-agent-tunnel.service
curl --fail "$(cat ~/.config/workspace-ci-orchestrator/tunnel-url)/healthz"
```

### DLQ inspection and recovery

The deployed DLQ has an HTTP pull consumer for operator inspection. Pulling changes message visibility, so do not acknowledge a message until its metadata and recovery decision are recorded.

```bash
# The token needs Cloudflare Queues Read and Edit on this account.
source ~/.config/workspace-ci-orchestrator/cloudflare.env
curl --fail --request POST \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/def60a0da7ce44889cb4e91c131d25bb/messages/pull" \
  --header "Authorization: Bearer $CF_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"visibility_timeout_ms":30000,"batch_size":10}'
```

Inspect only operational metadata: delivery ID, repository, workflow run ID, SHA, conclusion, attempt count and timestamps. To redrive, publish the unchanged normalized `body` to the main queue's `/messages` endpoint, verify it reaches the bridge, then acknowledge the DLQ lease through `/messages/ack`. Never acknowledge first. Never alter the delivery ID during redrive.

### Temporarily disable the event loop

Pause new GitHub events and queue delivery without deleting state:

```bash
gh api --method PATCH repos/sjevans1/Workspace-Platform/hooks/692802160 -f active=false
source ~/.config/workspace-ci-orchestrator/cloudflare.env
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx --yes wrangler@4.147.0 queues pause-delivery workspace-ci-events
```

Resume in the opposite order:

```bash
source ~/.config/workspace-ci-orchestrator/cloudflare.env
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx --yes wrangler@4.147.0 queues resume-delivery workspace-ci-events
gh api --method PATCH repos/sjevans1/Workspace-Platform/hooks/692802160 -f active=true
```

The hourly/manual CI-checking fallback remains enabled during the reliability period. To operate manually, use exact-head `gh pr checks` and `gh run view` commands, inspect failed jobs only, make one focused correction, push, and stop. Do not remove the hourly fallback until multiple real event-driven CI cycles have completed reliably.

## Phase 2

After Phase 1 proves reliable:

- add a GitHub App with read-only Actions/Pull Requests/Contents access so the bridge can retrieve exact failed-job metadata without a user token;
- add an alternate CI adapter (Forgejo/Codeberg or self-hosted runner);
- add explicit event/state telemetry and DLQ alerting;
- split the monolithic deployed browser gate into smaller diagnosable slices while keeping a single exact-head acceptance aggregate;
- reduce or disable the hourly polling automation once event delivery has demonstrated reliability.
