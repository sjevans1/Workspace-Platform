# Native deterministic automation architecture (W30-A)

W30-A is the Workspace-native workflow runtime. A workflow is
**Trigger -> Conditions -> Actions**, authored as a declarative JSON document,
published as an immutable revision, and executed by a deterministic engine that
never needs a model, a network service or an external account. It is the second
half of the promoted W29/W30 scope and consumes the normalized provider events,
connections and action boundary described in
[Connected Work architecture](CONNECTED_WORK_ARCHITECTURE.md).

The storage layer is `infrastructure/migrations/030_automation_runtime.sql`,
applied by the versioned runner in `packages/database/migrate.ts`, which reads
`infrastructure/migrations` in sorted order. The runtime is the module
`packages/automation` (`dsl.ts`, `conditions.ts`, `schedule.ts`, `triggers.ts`,
`actions.ts`, `engine.ts`, re-exported by `index.ts`). The HTTP surface is in
`apps/api/src/connected-work.ts`, and the worker drives the runtime from
`apps/worker/src/connected-work.ts` (`automationTick`, `workspaceEventTick`) inside
the tick loop in `apps/worker/src/worker.ts`.

## Boundaries

- **Deterministic.** `planSteps`, `planDigest`, condition evaluation,
  `nextOccurrence` and the idempotency keys are pure functions of their inputs. No
  model call, no `eval`, no `new Function`, no shell and no arbitrary code.
- **No ambient authority.** A run executes as a delegated user or as an explicitly
  constrained service principal, resolved and re-checked at run time. Database
  superuser or ambient system authority is never used.
- **Connectors are optional.** A workflow with `manual`, `schedule` or
  `workspace_event` triggers and only workspace or control actions runs with zero
  connected providers.
- **Run history carries no secrets.** Every step result is bounded, non-secret and
  built by the action itself, and the engine rejects a result that looks like
  credential material before it is written.
- **Bounded.** Every queue, batch, schedule frequency, retry and retention rule in
  this document is an explicit constant; there is no unbounded queue and no
  user-configurable sub-minute schedule.

## Status in this tranche

| Item | Location |
|---|---|
| Definitions, revisions, runs, steps, schedule state, health function | `infrastructure/migrations/030_automation_runtime.sql` |
| DSL, conditions, schedules, triggers, actions, engine | `packages/automation/{dsl,conditions,schedule,triggers,actions,engine}.ts` |
| Standard action registration at module load | `packages/automation/index.ts` |
| HTTP surface for workflows, runs, catalog and metrics | `apps/api/src/connected-work.ts` |
| Worker phases `automationTick` and `workspaceEventTick` | `apps/worker/src/connected-work.ts`, called from `apps/worker/src/worker.ts` |

The storage layer is authoritative and complete: the five tables, the
immutable-revision trigger, the count-only health function
`workspace_workflow_health()` and the per-table RLS and grant posture.

The engine module `packages/automation` implements the rules below and registers
the six standard actions at module load, so importing the package is enough to run
workflows. The API surface and the worker phases in this tranche call it.

One item is deliberately ahead of the runtime and is called out where it appears
below: `workflow_definitions.status='attention'` is stored vocabulary that nothing
sets yet.

Explicitly deferred, and NOT implemented here:

- **Approvals.** `docs/RELEASE_1_0_FINAL_GATES.md` lists approvals for sensitive
  and external actions as a W30 requirement. No approval step, approval record,
  approval API or approval-aware action exists in this tranche's action set.
- **Provider-backed actions.** No action sends mail, creates or cancels a calendar
  event, or posts to a messaging channel. `connector.action.invoke` can only call
  an action a registered adapter actually declares, and the only registered
  adapter is the synthetic one.
- **A workflow authoring interface and template library.** The HTTP contract
  exists; authoring tooling beyond the JSON definition is not part of the runtime.
- **Service-principal workflows.** The schema and `resolveAuthority` support
  `authority='service_principal'`, but nothing selects it in this tranche.
- **Agent or model steps.** See *No LLM is required for workflow execution*.
- **A loop detector.** There is no runtime cycle detector; see *Idempotency and
  loop bounds*.
- **Interrupting an executing step, and a concurrency policy beyond queue.** See
  *Cancellation and the disable policy* and *Worker crash recovery and revision
  pinning*.

## Workflow model

A workflow is one trigger, zero or more conditions and one or more actions, in
document order. The plan that will execute is derived, never authored:

| Plan step | When it exists | `step_type` | `operation` |
|---|---|---|---|
| Trigger | always, first | `trigger` | `trigger.manual`, `trigger.schedule`, `trigger.workspace_event`, `trigger.connector_event` |
| Condition group | one step per top-level condition group | `condition` | `condition.all` or `condition.any`, with `node_id` of the group |
| Action | one step per action | `action` | the action key, with `node_id` of the action id |

`planSteps(definition)` produces that list and is pure and deterministic: it does
not read the clock, the random state or the database, and document order is
stable. `planDigest(plan)` is the SHA-256 hex digest of the plan and is stored on
the run as `workflow_runs.plan_digest` (64 characters), so the plan that was
authorized is distinguishable from a plan that would be produced later. This
tranche has no branching, no loops, no parallel branches and no sub-workflows:
execution is a linear walk of the plan. A condition group gates the action steps
that follow it.

## The workflow definition DSL

`packages/automation/dsl.ts` owns the schema.

- `WORKFLOW_SCHEMA_VERSION` is `1`, and `workflow_revisions.schema_version` is
  checked equal to `1`.
- `WorkflowDefinition` is
  `{ schema_version, trigger, conditions, actions }` with
  `ConditionLeaf`, `ConditionGroup`, `WorkflowAction` and `WorkflowTrigger` as
  defined there.
- `parseWorkflowDefinition(input)` validates strictly with zod, throws
  `HttpError` 400, and rejects unknown keys, unknown operations and out-of-bounds
  values rather than coercing them. An unknown action key fails with
  `Unknown workflow operation: <key>` from `actionFor`.
- `canonicalDefinition(definition)` is a stable JSON serialization with sorted
  keys, and `definitionDigest(definition)` is its SHA-256 hex digest. The digest
  is stored in `workflow_revisions.digest`, which the database checks is exactly
  64 characters.
- `scheduledTriggers(definition)` returns one entry per schedule trigger with
  `{trigger_id, kind, expression, timezone, missed_policy}`, and
  `describeTrigger(definition)` returns the `{type, label, summary}` shown in a
  workflow list.

Bounds (`WORKFLOW_LIMITS`): `max_conditions` 8, `max_condition_depth` 3,
`max_actions` 10, `max_definition_bytes` 32768, `max_workflows_per_tenant` 100,
`max_concurrent_runs_per_tenant` 4, `max_run_history_per_tenant` 5000,
`run_retention_days` 30, `step_timeout_seconds` 60, `max_delay_seconds` 3600,
`max_schedule_frequency_seconds` 60, `max_trigger_ref_bytes` 4096,
`max_runs_per_tick` 4, `max_schedule_fire_per_tick` 8, `prune_batch` 200. The
database independently bounds a stored definition at 65536 bytes
(`CHECK(pg_column_size(definition) <= 65536)`) and a run's `trigger_ref` and
`authority` at 8192 bytes each.

## Immutable revisions

`workflow_definitions` holds the identity and lifecycle of a workflow: `name`
(1 to 200 characters), `description` (up to 2000), `status` (`draft`, `enabled`,
`disabled`, `attention`), `owner_user_id`, `authority`
(`delegated_user` or `service_principal`), `current_draft_revision`,
`published_revision`, `concurrency_policy` (`queue`, `skip`, `parallel`),
`created_by`, `created_at`, `updated_at`, `enabled_at`, `disabled_at`. Two
constraints matter: `published_revision <= current_draft_revision`, and
`status='draft' OR published_revision IS NOT NULL`, so a workflow cannot leave
draft before a revision is published.

`workflow_revisions` is the execution record: primary key
`(tenant_id, workflow_id, revision)`, with `schema_version`, `definition`,
`digest`, `authority`, `authority_user_id`, `created_by` and `created_at`. It is
append-only in three places at once:

- the trigger `workflow_revisions_immutable` (function
  `workspace_workflow_revision_immutable`) raises
  `workflow revisions are immutable` on any `UPDATE`;
- the runtime role is granted `SELECT, INSERT` and has `UPDATE, DELETE` revoked
  by the migration;
- saving a draft inserts a new row at `current_draft_revision + 1` and never
  rewrites an existing revision.

A `CHECK` constraint requires `authority_user_id` to be null unless
`authority='service_principal'`, so a delegated revision carries no separate
authority identity.

**An edited workflow never mutates a running execution.** A run stores the
`revision` it was created with, and the engine executes
`planSteps(revision.definition)` for that pinned revision. Enabling writes
`published_revision = current_draft_revision`, so a later edit creates a new draft
revision that will only take effect at the next enable; an execution that is
already running, waiting or queued continues to read the revision it was pinned
to.

## Trigger registry

`packages/automation/triggers.ts` declares `TRIGGER_TYPES`
(`manual`, `schedule`, `workspace_event`, `connector_event`), `triggerCatalog()`
for the catalog endpoint, and `triggerMatches(trigger, input)` to decide whether a
normalized input belongs to a workflow.

- **`manual`**: a signed-in member triggers the workflow by hand. The API route is
  `POST /automations/workflows/:id/run`, which accepts an optional
  `idempotency_key`.
- **`schedule`**: `{kind: "one_time" | "interval" | "cron", at?, every_seconds?,
  expression?, timezone, missed_policy}`. See *Schedule semantics*.
- **`workspace_event`**: `{event_types: string[]}` matched against the accepted
  transactional outbox. Workspace mutations already append minimal versioned
  references to `event_outbox` in the same transaction as the state change, and
  the existing worker dispatches them; `workspaceEventTick` runs the workflow
  dispatch inside that same outbox transaction, so an event and the run it causes
  commit or roll back together, and one outbox row produces at most one run.
  `WORKSPACE_EVENT_TYPES` is the bounded allowlist a definition may name, and it is
  exactly the set of types this product actually writes to `event_outbox`:
  `comment.created`, `comment.deleted`, `comment.updated`, `database.updated`,
  `export.performed`, `file.created`, `file.deleted`, `file.malware_blocked`,
  `import.completed`, `notification.created`, `page.updated`,
  `permission.updated`, `record.updated`. A `family.*` form (`comment.*`) is also
  accepted when it matches at least one of those types. `parseWorkflowDefinition`
  rejects anything else with a 400, including the whole `workflow.` namespace, and
  `dispatchWorkspaceEvent` only reads `event_outbox` rows where
  `type = ANY(WORKSPACE_EVENT_TYPES) AND dispatched_at IS NULL` (50 per call,
  `FOR UPDATE SKIP LOCKED`), so the vocabulary is enforced on both sides. Resource
  lifecycle events are written per resource kind (`page.updated`,
  `database.updated`, `record.updated`), so a definition subscribes to those exact
  names or to a matching `family.*` form; there is no literal `resource.*` type in
  the outbox and none is offered as a trigger. Administrative and security event
  families (`identity.*`, `scim.*`, `integration.*`, `support.*`, `membership.*`,
  `branding.*`, `retention.*`) are deliberately not exposed as trigger types in
  this tranche, which keeps the trigger surface bounded. The `workflow.` namespace
  is excluded on purpose: a workflow can emit a signed outbound webhook event, and
  if such an event could trigger another workspace event workflow there would be no
  natural ceiling on the resulting chain.
- **`connector_event`**: `{event_types: string[], provider_keys?, connection_ids?}`
  matched against normalized connector events. Only events recorded with
  `verification='verified'` are ever offered to the engine, so an unverified
  inbound request cannot become workflow input. Each consumed event carries the
  connector event id into the run's idempotency key.

## Schedule semantics

`packages/automation/schedule.ts` owns schedule arithmetic:
`isValidTimezone`, `nextOccurrence` and `parseCron`.

- **Timezone is explicit and never the host zone.** Every schedule trigger
  declares an IANA `timezone`, validated with `isValidTimezone` through `Intl`, and
  all evaluation happens in that zone. `workflow_schedule_state.timezone` stores it
  (1 to 64 characters) so catch-up survives a restart even when the process clock
  and the workflow timezone disagree. Nothing in the runtime reads the host's local
  timezone.
- **Kinds.** `one_time` returns its instant once and then null. `interval` uses
  `every_seconds`, based on `from` (the last scheduled instant) or `at`.
  `cron` accepts a 5-field expression (`minute hour day-of-month month
  day-of-week`) supporting `*`, lists, ranges and `*/n`, parsed by `parseCron`.
- **DST forward (spring forward).** A local time that does not exist resolves to
  the first instant that does exist at or after it.
- **DST backward (fall back).** A local time that occurs twice resolves to the
  first, earlier UTC instant.
- **No duplicate executions.** The rules above are chosen so the same
  `(trigger, local time)` can never produce two instants, and the persisted
  `next_at` plus the schedule idempotency key make a repeated fire a duplicate
  rather than a second run.
- **Missed-execution policy.** `missed_policy: "skip"` advances past all missed
  occurrences to the first occurrence strictly after `after`. `catch_up_once`
  returns the single oldest missed occurrence when any exist, never more than one
  per call, and the next future occurrence otherwise.
- **Persisted state.** `workflow_schedule_state` is keyed
  `(tenant_id, workflow_id, trigger_id)` with `revision`, `timezone`, `kind`,
  `expression`, `next_at`, `last_at`, `missed_policy`, `lease_token`,
  `lease_expires_at`, `attempts` and `updated_at`, and the partial index
  `workflow_schedule_due` supports the due scan. Enabling a workflow upserts one
  row per schedule trigger.
- **Bounded fire rate.** `max_schedule_frequency_seconds` is 60, so no schedule
  can fire more often than once a minute, and `scheduleTick` fires at most
  `max_schedule_fire_per_tick` (8) triggers per tenant per tick.

## Condition engine

`packages/automation/conditions.ts` implements `CONDITION_OPERATORS`
(`equals`, `not_equals`, `contains`, `starts_with`, `gt`, `gte`, `lt`, `lte`,
`empty`, `not_empty`, `boolean`), `evaluateConditions`, `evaluateCondition`,
`readPath` and `boundedContext`.

| Operator family | Semantics |
|---|---|
| `equals`, `not_equals`, `contains`, `starts_with` | Strings, case-sensitive and byte-exact |
| `gt`, `gte`, `lt`, `lte` | Numbers numerically; strings compared as dates when both sides parse |
| `empty`, `not_empty` | Presence and emptiness |
| `boolean` | Truthiness of a literal boolean |

Groups are `all` (AND) or `any` (OR) and may nest up to `max_condition_depth` (3),
with at most `max_conditions` (8) conditions in a definition. An empty group
evaluates to true. A missing path makes `empty` true, `not_empty` false and every
other operator false. `readPath` follows a bounded dot path and never throws.
`evaluateConditions` returns `{passed, evaluated}` where each evaluated node
carries an `id`, a `passed` flag and a `reason`, so a run can explain why a gate
closed.

**Conditions cannot reach inaccessible Workspace data.** A condition is evaluated
against a bounded, already-normalized, non-secret context:
`boundedContext` accepts at most 16 top-level keys and at most 8192 serialized
bytes, holding primitives and bounded arrays only. The engine builds it from the
run's `trigger_ref` under `trigger.*`, plus `workflow.*`, `authority.*` and
`run.*`. Evaluating a condition performs no database read and resolves no
Workspace permission, so a condition can neither observe a resource the run's
authority cannot access nor widen that authority. Anything the trigger did not
carry is simply absent, and an absent path is false.

When the gate closes, the condition step is recorded `skipped` with
`error_category='conditions_not_met'` and result `{passed: false}`, every remaining
action step is recorded `skipped` with result `{conditions_met: false}`, and the
run completes `succeeded` with `error_category = null`. A closed gate is not a
failure.

## Action registry

`packages/automation/actions.ts` defines `ActionDefinition`
(`key`, `display_name`, `kind: "workspace" | "connector" | "control"`,
`retryable`, `service_capability`, `describe()`, `validate(config)`, `run(...)`),
the registration functions `registerAction`, `actionFor`, `actionCatalog`, the
`ConnectorActionPort` boundary, and `deterministicUuid(...parts)`, which derives a
stable RFC4122-shaped identifier from a SHA-256 digest so a repeated attempt
addresses the same row. `actionFor` throws 400 for an unknown key, and
`actionCatalog()` is sorted by key. `packages/automation/index.ts` registers the
standard actions at module load.

The registered set in this tranche:

| Key | Kind | Retryable | `service_capability` | Config |
|---|---|---|---|---|
| `workspace.notification.create` | workspace | yes | `notification.create` | `resource_id`, optional `user_id`, `message` (1 to 500) |
| `workspace.record.create` | workspace | no | `record.create` | `database_id`, `values` |
| `workspace.record.update` | workspace | yes | `record.update` | `record_id`, `values` |
| `workspace.webhook.emit` | workspace | yes | `webhook.emit` | `event_type` matching `^workflow\.[a-z0-9][a-z0-9._-]{2,80}$`, optional `resource_id` |
| `connector.action.invoke` | connector | yes | `connector.action` | `connection_id`, `action`, `capability`, optional `payload` |
| `workflow.delay` | control | no | `workflow.delay` | `seconds` (1 to 3600, `max_delay_seconds`) |

Behaviour of note:

- `workspace.notification.create` calls `requireAccess` on the resource, writes
  `notifications` with a deterministic id and `ON CONFLICT DO NOTHING`, requires the
  recipient to be a live membership of the tenant, and emits
  `notification.created`. Repeating the step cannot create a second notification.
- `workspace.record.create` and `workspace.record.update` reuse the accepted
  domain operations (`createRecord`, `updateRecordCanonical`), so database schema
  validation, ACL checks and optimistic revisions behave exactly as they do for an
  interactive edit.
- `workspace.webhook.emit` reuses the accepted webhook machinery: it writes
  `event_outbox` (and the audit row) that the existing worker delivers to matching
  subscriptions. It does not deliver anything itself.
- `connector.action.invoke` is the only action that reaches a provider, and it
  fails closed. See *Execution authority model*.
- `workflow.delay` returns a `waiting_until` instant, which parks the run in
  `waiting` instead of holding a worker slot.

## Execution authority model

`RunAuthority` is `{kind: "delegated_user" | "service_principal", user_id,
capabilities}`.

- A **delegated user** run executes with the owning user's role from their live
  membership of the tenant.
- A **service principal** run executes as an explicitly constrained tenant
  automation identity: `users.is_service` must be true, the role used is `member`,
  and the only capabilities the run holds are those declared by the actions on the
  pinned revision (`declaredCapabilities` collects one `service_capability` per
  action). There is no other privilege. `resolveAuthority` implements this branch,
  and it also requires a live membership row for the authority user, but nothing
  selects it in this tranche: `createWorkflow` and `saveDraft` write
  `authority='delegated_user'`, so every run that executes today is delegated.
- Authority is resolved at run start and recorded on the run in
  `workflow_runs.authority`. If the authority user's membership is missing or not
  `active`, the run fails with `authorization_revoked`, no step executes and no
  external action occurs.
- A run executes under that pinned authority, not under the caller's. Any live
  member may trigger a manual run, and the run still acts as the workflow's
  authority, so a member cannot borrow their own broader permissions by pressing
  Run.

Every execution re-checks, rather than trusting the state at authoring time:

1. the tenant (`tenant_id` is asserted even though RLS makes cross-tenant access
   impossible);
2. the authority user's live membership and role;
3. the Workspace permission for the resource a workspace action touches, through
   `requireAccess` inside the action itself;
4. the workflow's status and its pinned revision;
5. for `connector.action.invoke`: the connection exists, `enabled` is true,
   `status` is `connected`, the run's authority is allowed to use it (a delegated
   run may only use a connection whose `owner_user_id` is its authority user, or a
   tenant-shared connection when the authority actor is an owner or administrator),
   and the connection holds the requested capability in `capabilities_granted`.

Any of those failures is fatal for the step: revocation is fail-closed, a denied
connector access raises an error carrying `fatal`, and the engine classifies 403
from the connector port as `authorization_revoked`. A run never continues with a
permission it lost, and never acts with authority it was not granted.

## Run model and status vocabulary

`workflow_runs` carries `id`, `tenant_id`, `workflow_id`, the pinned `revision`,
`trigger_type`, `trigger_ref` (bounded, non-secret trigger context: trigger node
id, connector event id, outbox event id, scheduled instant), `authority`,
`status`, `idempotency_key` (1 to 200 characters), `plan_digest`, `step_count`,
`current_step`, `attempts`, `error_category`, `started_at`, `completed_at`,
`cancelled_at`, `lease_token`, `lease_expires_at`, `next_attempt_at` and
`created_at`, with `UNIQUE(tenant_id,id)` and
`UNIQUE(tenant_id,idempotency_key)`.

Status vocabulary: `queued`, `running`, `succeeded`, `failed`, `cancelled`,
`waiting`, `dead_letter`. `queued`, `running` and `waiting` are non-terminal and
are the only statuses the index `workflow_runs_claimable` covers; `succeeded`,
`failed`, `cancelled` and `dead_letter` are terminal. `RunSummary` is the
projection the API returns, built by `runSummary(run)`.

## Per-step evidence

`workflow_run_steps` records one row per attempt of one step: `id`, `tenant_id`,
`run_id`, `seq`, `step_type` (`trigger`, `condition`, `action`), `operation`,
`status`, `attempt`, `started_at`, `completed_at`, `result`, `error_category` and
`retry_state`, unique on `(tenant_id, run_id, seq, attempt)`. Step statuses are
`pending`, `running`, `succeeded`, `failed`, `skipped`, `cancelled`,
`dead_letter`, `waiting`. `result` is bounded at 8192 bytes and `retry_state` at
4096, and `stepRecord(step)` is the projection returned by the run detail route.

A step is written before it runs and updated with its outcome, and the engine
skips a step whose row for `(run_id, seq)` is already `succeeded` or `skipped`.
That single rule is what makes a retry or a reclaimed run safe: a durably completed
action is never executed twice. Before a result is written, the engine rejects any
value whose serialization matches credential material
(`/secret_encrypted|refresh_token|access_token|bot_token|authorization:/`), so run
history cannot become a secret-bearing surface.

## Idempotency and loop bounds

One logical trigger maps to one run, enforced by
`UNIQUE(tenant_id, idempotency_key)`. Run creation inserts with
`ON CONFLICT (tenant_id, idempotency_key) DO NOTHING` and returns the existing run
when the insert collided, so a duplicate delivery returns the original run rather
than an error. The key formats:

| Trigger | Key |
|---|---|
| manual | the supplied `idempotency_key`, or `manual:<run uuid>` when none is supplied |
| schedule | `schedule:<workflow_id>:<trigger_id>:<ISO instant>` |
| workspace event | `workspace_event:<event_outbox id>:<trigger_id>` |
| connector event | `connector_event:<connector_event id>:<trigger_id>` |

That is what makes a duplicate connector event, a repeated webhook delivery, a
queue retry, a worker restart or a schedule recovery converge on one run. It
composes with the connector layer's own dedupe key, so one provider event maps to
one connector event and at most one run.

There is no runtime cycle detector in this tranche. Loop amplification is bounded
declaratively instead: a workflow's own `workspace.webhook.emit` action emits a
`workflow.*` event type, which is outside the `WORKSPACE_EVENT_TYPES` trigger
vocabulary, so a workflow cannot trigger itself through that action; `max_actions`
is 10; a workflow has no sub-workflow, branch or loop construct; and each tick
claims at most `max_runs_per_tick` (4) runs and fires at most
`max_schedule_fire_per_tick` (8) schedules per tenant.

## Failure classification, retry and backoff

`classifyStepFailure(error)` from `packages/connectors/failure.ts` classifies a
step failure, so the connector plane and the engine share one vocabulary:

| Condition | Category | Retryable |
|---|---|---|
| 403, 401 | `authorization_revoked` | no |
| 404 | `not_found` | no |
| 409 | `conflict` | yes |
| 429 | `rate_limited` | yes |
| 5xx | `transient` | yes |
| 400, 422 | `validation` | no |
| anything else | `transient` | yes |

A step is retried only when the category is retryable and the action itself
declares `retryable: true`, so `workflow.delay` and `workspace.record.create` are
never retried. The engine classifies through its own `classifyActionFailure`,
which maps an error carrying `details.fatal` with a message starting
`Connector access denied` to `capability_missing` and otherwise returns the
`classifyStepFailure` category. A retryable failure is scheduled with
`backoffSeconds(attempt)`, which is `min(3600, 5 * 2^attempt)` with no jitter,
bounded by `RETRY_POLICY.max_attempts` (7). The attempt count lives on the step
row (`workflow_run_steps.attempt`, mirrored in the run's `attempts`), so a worker
restart resumes the same attempt rather than resetting the budget. On exhaustion
the step and the run become `dead_letter`; a non-retryable category fails the run
immediately with the classified `error_category`. An action that returns a
`waiting_until` instant sets the step and the run to `waiting` with
`next_attempt_at = waiting_until`; on resume the same step completes instead of
restarting the plan.

## Worker crash recovery and revision pinning

`engineTick` claims at most `max_runs_per_tick` (4) runs whose status is `queued`,
`running` or `waiting`, whose `next_attempt_at <= now()` and whose lease is absent
or expired, ordered by `next_attempt_at` then `id`, with
`FOR UPDATE SKIP LOCKED`, then sets `status='running'`, a fresh `lease_token`,
`lease_expires_at = now() + 120 s`, `attempts = attempts + 1` and
`started_at = COALESCE(started_at, now())`. The lease is what makes a crashed
worker's run reclaimable: another worker takes it after expiry, resumes at
`current_step`, skips the steps that are already durably `succeeded`, and the
persisted attempt count keeps the retry budget honest.

Runs never re-plan. A reclaimed run continues against its pinned
`(workflow_id, revision)` and the plan digest recorded at creation, so an edit
that lands while the run is in flight cannot change what it does.

## Cancellation and the disable policy

`cancelRun` moves a run to `cancelled` and records `cancelled_at`; the claim
predicate never picks a terminal run up again. Cancellation is a run-level state
change: this tranche specifies no mechanism to interrupt a step that is already
executing. What bounds a single step is `WORKFLOW_LIMITS.step_timeout_seconds`
(60): `executeRun` races the action against that ceiling and fails the step as a
retryable timeout, so a step cannot hold the run's lease and the tenant
transaction indefinitely.

Disabling is the documented deterministic policy. `disableWorkflow` sets
`status='disabled'` and `disabled_at=now()`, and cancels every run of that workflow
that is still `queued` (they never started), returning the count as
`cancelled_queued_runs`. Runs already `running` or `waiting` continue against their
pinned revision and finish normally. Nothing is silently dropped and nothing is
silently allowed to keep starting.

## Retention

`pruneRuns` deletes at most `prune_batch` (200) terminal runs
(`succeeded`, `failed`, `cancelled`, `dead_letter`) older than
`run_retention_days` (30) in one call, then terminal runs beyond
`max_run_history_per_tenant` (5000) newest-first. It never deletes a run in
`queued`, `running` or `waiting`, and it reads the database's `now()` rather than
the process clock, so two workers with skewed clocks agree on what is old.
Step rows and schedule rows follow their run or workflow through
`ON DELETE CASCADE`.

## Metrics, health and audit

- `workspace_workflow_health()` (migration 030) is a `SECURITY DEFINER` count-only
  aggregate returning `workflows_enabled`, `runs_started`, `runs_succeeded`,
  `runs_failed`, `runs_queued`, `runs_dead_letter`, `retries` (the sum of step
  attempts) and `execution_latency_seconds`. It exists because the workflow tables
  are `FORCE ROW LEVEL SECURITY` and a tenant-less aggregate would report an empty
  fleet. It returns numbers only and can never become a cross-tenant row
  primitive.
- `workflowMetrics(db)` exposes those counters to the API, and the
  deployment-wide Prometheus snapshot (read in `apps/api/src/app.ts`, rendered by
  `packages/operations/metrics.ts`) publishes them as
  `workspace_workflow_<counter>` samples (HELP and TYPE `workspace_workflow_count`)
  alongside the connector counters. The counters are observational: an unreadable
  function omits them from the snapshot rather than failing it. Worker health, the
  internal health server and `/operations/status` are unchanged.
- Audit rows go to the existing `audit_events` in the same transaction as the
  change: `workflow.created`, `workflow.edited`, `workflow.enabled`,
  `workflow.disabled`, `workflow.deleted`, `workflow.run_triggered`,
  `workflow.run_cancelled` and `workflow.run_retried`.

## Bounded limits

| Limit | Value | Where it applies |
|---|---|---|
| `max_conditions` | 8 | definition validation |
| `max_condition_depth` | 3 | nested condition groups |
| `max_actions` | 10 | definition validation |
| `max_definition_bytes` | 32768 | definition validation (65536 in the database) |
| `max_workflows_per_tenant` | 100 | workflow creation |
| `max_concurrent_runs_per_tenant` | 4 | the `engineTick` claim predicate: a tenant may hold at most this many runs in flight, so one tenant cannot monopolize the worker |
| `max_run_history_per_tenant` | 5000 | retention |
| `run_retention_days` | 30 | retention |
| `step_timeout_seconds` | 60 | the bounded ceiling `executeRun` races every action against |
| `max_delay_seconds` | 3600 | `workflow.delay` |
| `max_schedule_frequency_seconds` | 60 | schedule triggers |
| `max_trigger_ref_bytes` | 4096 | trigger context |
| `max_runs_per_tick` | 4 | `engineTick` |
| `max_schedule_fire_per_tick` | 8 | `scheduleTick` |
| `prune_batch` | 200 | `pruneRuns` |

Database bounds in migration 030: `name` 1 to 200 characters, `description` up to
2000, `revision` at least 1, `digest` exactly 64 characters, `idempotency_key` 1
to 200 characters, `plan_digest` at most 64 characters, `step_count`,
`current_step` and `attempts` at least 0, `seq` at least 1, `operation` 1 to 120
characters, `trigger_id` 1 to 64 characters, `timezone` 1 to 64 characters,
`expression` up to 200 characters, and `trigger_ref`, `authority`, `result` and
`retry_state` bounded on byte size.

`concurrency_policy` (`queue`, `skip`, `parallel`) is enforced, and the three values
are distinguishable. `skip` is applied where a run would be created: if the
workflow already has a run in `queued`, `running` or `waiting`, no second run is
created and the caller receives the existing one, so a trigger is never silently
dropped. `queue` (the default) serializes a workflow's own runs: the claim
predicate will not start a run of a workflow while another run of that same
workflow is running, while different workflows still run in parallel. `parallel`
opts a workflow out of that per-workflow gate. Independently of the policy, the
tenant-wide `max_concurrent_runs_per_tenant` gate always applies.

## No LLM is required for workflow execution.

No LLM is required for workflow execution. Nothing in this runtime calls a model,
an inference endpoint or an external AI service, and no step, condition, schedule
or retry decision depends on one. A future agent layer may propose or invoke
permitted workflows, but it can never bypass workflow validation, Workspace
authorization, connector capabilities, approvals or run recording: a proposal is
still a `WorkflowDefinition` that must pass `parseWorkflowDefinition`, an
invocation still has to satisfy the execution authority model above, and every
outcome still lands in `workflow_run_steps` and `audit_events`. A model can
propose; it cannot authorize, cannot execute, and cannot edit the record of what
happened.

## Deferred beyond this tranche

- Approvals for sensitive and external actions, and the approval record, API and
  UI that would carry them.
- Provider-backed actions (send mail, create, update or cancel a calendar event,
  post to a messaging channel), which require the W29 provider adapters.
- The visual builder, workflow template library and run-history interface.
- Agent or model steps, and any autonomous workflow authoring.
- Interrupting a step that is already executing.
- A runtime cycle detector, if a later tranche adds a construct that can close a
  loop.
