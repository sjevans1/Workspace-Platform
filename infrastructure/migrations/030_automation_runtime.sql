-- W30-A: deterministic workflow runtime core.
--
-- A workflow is Trigger -> zero or more Conditions -> one or more Actions, and
-- each enabled workflow executes against an IMMUTABLE revision. This migration
-- adds the storage for the definition/revision pair, the run and per-step
-- evidence, and the persisted schedule state. Nothing here depends on an LLM, an
-- agent runtime, an external SaaS account or a connected provider.
--
-- Isolation posture matches the rest of the repository: tenant-scoped tables,
-- ENABLE + FORCE ROW LEVEL SECURITY with the standard `tenant_isolation` policy,
-- per-table grants for `workspace_app`, indexes for the worker's lease/claim and
-- for idempotency.

CREATE TABLE workflow_definitions(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  status text NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','enabled','disabled','attention')),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  -- Execution authority. 'delegated_user' runs as the owning user;
  -- 'service_principal' runs as an explicitly constrained tenant automation
  -- identity whose capability allowlist lives in the revision. Ambient database
  -- or system superuser authority is never used.
  authority text NOT NULL DEFAULT 'delegated_user'
    CHECK(authority IN ('delegated_user','service_principal')),
  current_draft_revision integer NOT NULL DEFAULT 1 CHECK(current_draft_revision >= 1),
  published_revision integer CHECK(published_revision IS NULL OR published_revision >= 1),
  concurrency_policy text NOT NULL DEFAULT 'queue'
    CHECK(concurrency_policy IN ('queue','skip','parallel')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled_at timestamptz,
  disabled_at timestamptz,
  UNIQUE(tenant_id,id),
  CHECK(published_revision IS NULL OR published_revision <= current_draft_revision),
  -- A workflow can only leave 'draft' once an immutable revision is published.
  CHECK(status='draft' OR published_revision IS NOT NULL)
);
CREATE INDEX workflow_definitions_tenant
  ON workflow_definitions(tenant_id,created_at DESC,id);
CREATE INDEX workflow_definitions_enabled
  ON workflow_definitions(tenant_id,id) WHERE status='enabled';

-- Immutable execution revisions. A run is pinned to (workflow_id, revision) and
-- this table is append-only: editing a workflow creates a NEW revision row and
-- never mutates behaviour underneath an active run.
CREATE TABLE workflow_revisions(
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision >= 1),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  definition jsonb NOT NULL,
  digest text NOT NULL CHECK(length(digest) = 64),
  authority text NOT NULL CHECK(authority IN ('delegated_user','service_principal')),
  authority_user_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workflow_id,revision),
  FOREIGN KEY(tenant_id,workflow_id)
    REFERENCES workflow_definitions(tenant_id,id) ON DELETE CASCADE,
  CHECK(pg_column_size(definition) <= 65536),
  CHECK(authority='service_principal' OR authority_user_id IS NULL)
);
CREATE FUNCTION workspace_workflow_revision_immutable()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow revisions are immutable';
END $$;
CREATE TRIGGER workflow_revisions_immutable
  BEFORE UPDATE ON workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION workspace_workflow_revision_immutable();

CREATE TABLE workflow_runs(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision >= 1),
  trigger_type text NOT NULL
    CHECK(trigger_type IN ('manual','schedule','workspace_event','connector_event')),
  -- Bounded, non-secret trigger context: the trigger node id, the connector
  -- event id, the workspace outbox event id, the scheduled instant.
  trigger_ref jsonb NOT NULL DEFAULT '{}',
  -- The authority the run actually executed under, resolved at start time.
  authority jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','failed','cancelled','waiting','dead_letter')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  plan_digest text CHECK(plan_digest IS NULL OR length(plan_digest) = 64),
  step_count integer NOT NULL DEFAULT 0 CHECK(step_count >= 0),
  current_step integer NOT NULL DEFAULT 0 CHECK(current_step >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  error_category text,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,workflow_id)
    REFERENCES workflow_definitions(tenant_id,id) ON DELETE CASCADE,
  CHECK(pg_column_size(trigger_ref) <= 8192),
  CHECK(pg_column_size(authority) <= 8192)
);
-- One logical trigger maps to one run: the unique idempotency key is what makes
-- duplicate connector events, repeated webhook delivery, queue retry and worker
-- restart safe.
CREATE INDEX workflow_runs_claimable
  ON workflow_runs(tenant_id,next_attempt_at,id)
  WHERE status IN ('queued','running','waiting');
CREATE INDEX workflow_runs_recent
  ON workflow_runs(tenant_id,created_at DESC,id DESC);
CREATE INDEX workflow_runs_workflow
  ON workflow_runs(tenant_id,workflow_id,created_at DESC,id DESC);

-- Durable per-step evidence. `result` carries normalized, non-secret metadata
-- only. A step that durably succeeded is never re-executed, which is what stops
-- a retry or a worker restart from duplicating an already-completed action.
CREATE TABLE workflow_run_steps(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq >= 1),
  step_type text NOT NULL CHECK(step_type IN ('trigger','condition','action')),
  operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 120),
  status text NOT NULL CHECK(status IN (
    'pending','running','succeeded','failed','skipped','cancelled','dead_letter','waiting')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}',
  error_category text,
  retry_state jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_runs(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,run_id,seq,attempt),
  CHECK(pg_column_size(result) <= 8192),
  CHECK(pg_column_size(retry_state) <= 4096)
);
CREATE INDEX workflow_run_steps_run
  ON workflow_run_steps(tenant_id,run_id,seq,attempt);

-- Persisted schedule state, one row per schedule trigger node of a published
-- revision. `next_at` is an absolute instant; the definition's timezone and
-- missed-execution policy live here so catch-up is deterministic across a
-- restart even when the process clock and the workflow timezone disagree.
CREATE TABLE workflow_schedule_state(
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision >= 1),
  trigger_id text NOT NULL CHECK(length(trigger_id) BETWEEN 1 AND 64),
  timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK(kind IN ('one_time','interval','cron')),
  expression text NOT NULL DEFAULT '' CHECK(length(expression) <= 200),
  next_at timestamptz NOT NULL,
  last_at timestamptz,
  missed_policy text NOT NULL DEFAULT 'skip'
    CHECK(missed_policy IN ('skip','catch_up_once')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workflow_id,trigger_id),
  FOREIGN KEY(tenant_id,workflow_id)
    REFERENCES workflow_definitions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX workflow_schedule_due
  ON workflow_schedule_state(tenant_id,next_at,workflow_id,trigger_id);

-- Deployment-wide, count-only automation health for the operator surfaces.
CREATE FUNCTION public.workspace_workflow_health()
  RETURNS TABLE(
    workflows_enabled integer,
    runs_started integer,
    runs_succeeded integer,
    runs_failed integer,
    runs_queued integer,
    runs_dead_letter integer,
    retries integer,
    execution_latency_seconds double precision
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*)::integer FROM public.workflow_definitions WHERE status='enabled'),
    (SELECT count(*)::integer FROM public.workflow_runs),
    (SELECT count(*)::integer FROM public.workflow_runs WHERE status='succeeded'),
    (SELECT count(*)::integer FROM public.workflow_runs WHERE status='failed'),
    (SELECT count(*)::integer FROM public.workflow_runs
      WHERE status IN ('queued','running','waiting')),
    (SELECT count(*)::integer FROM public.workflow_runs WHERE status='dead_letter'),
    (SELECT COALESCE(SUM(attempt),0)::integer FROM public.workflow_run_steps),
    (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))), 0)::double precision
       FROM public.workflow_runs
      WHERE completed_at IS NOT NULL AND started_at IS NOT NULL);
$$;

ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_definitions
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE workflow_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_revisions
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_runs
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_run_steps
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE workflow_schedule_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_schedule_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_schedule_state
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON workflow_definitions TO workspace_app;
-- Revisions are append-only: the runtime may create and read them, never rewrite
-- or remove them (the UPDATE trigger enforces the same rule at the trigger layer).
GRANT SELECT,INSERT ON workflow_revisions TO workspace_app;
REVOKE UPDATE,DELETE ON workflow_revisions FROM workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON workflow_runs TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON workflow_run_steps TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON workflow_schedule_state TO workspace_app;
REVOKE ALL ON FUNCTION public.workspace_workflow_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_workflow_health() TO workspace_app;
GRANT EXECUTE ON FUNCTION workspace_workflow_revision_immutable() TO workspace_app;
