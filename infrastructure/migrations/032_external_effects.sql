-- W29-P0/A1: durable external-effect lifecycle for connector actions.
--
-- A real provider action (send mail, create a calendar event, post to a channel)
-- must never run inside the workflow engine's tenant transaction. The engine's
-- transaction is a shared, bounded resource: a slow or hostile provider could hold
-- a database connection and a row lock for as long as it likes, and a rollback
-- would leave the process believing nothing happened while the provider had
-- already accepted the request.
--
-- This migration adds the durable record that separates PLANNING an external
-- effect from EXECUTING it:
--
--   authorize/validate -> persist/reuse the effect (engine, short transaction)
--   -> claim it (worker, short transaction) -> COMMIT
--   -> provider I/O with NO transaction and NO row lock held
--   -> new short transaction -> verify the lease is still authoritative
--   -> commit the normalized outcome -> the engine settles the step
--
-- The status vocabulary is deliberately honest. An effect whose provider I/O may
-- have happened but whose outcome cannot be proven is `outcome_unknown`: never a
-- success, and never an ordinary retry, because a blind retry could send twice.
--
-- Isolation posture matches the rest of the repository: tenant-scoped, ENABLE +
-- FORCE ROW LEVEL SECURITY with the standard `tenant_isolation` policy, per-table
-- grants for `workspace_app`, and an index for the worker's claim.

CREATE TABLE workflow_external_effects(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision >= 1),
  step_seq integer NOT NULL CHECK(step_seq >= 1),
  operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 120),
  -- Connector identity of the effect.
  connection_id uuid NOT NULL,
  provider_key text NOT NULL CHECK(length(provider_key) BETWEEN 1 AND 64),
  action text NOT NULL CHECK(length(action) BETWEEN 1 AND 120),
  capability text NOT NULL CHECK(length(capability) BETWEEN 1 AND 64),
  -- Stable deterministic identity: the same logical effect is ONE row no matter
  -- how often a step retry, a worker restart or a replayed event addresses it.
  idempotency_key text NOT NULL CHECK(length(idempotency_key) = 64),
  -- Digest of the bounded, non-secret request shape (action/capability/payload),
  -- so a re-entry can prove it is addressing the same request it planned.
  request_digest text NOT NULL CHECK(length(request_digest) = 64),
  -- The authority the effect was planned under, so the worker re-checks the same
  -- identity, membership and connection reach before any provider I/O.
  authority_kind text NOT NULL
    CHECK(authority_kind IN ('delegated_user','service_principal')),
  authority_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK(status IN (
    'planned','claimed','succeeded','failed','outcome_unknown','cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 7 CHECK(max_attempts BETWEEN 1 AND 32),
  -- Whether the provider offers an idempotency primitive for this action. It is
  -- what makes a re-send after a reclaimed lease safe, and nothing else does.
  provider_idempotent boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_expires_at timestamptz,
  -- Written in its OWN short transaction immediately BEFORE the provider call, so
  -- a reclaimed lease can tell "crashed before the boundary" (safe to retry) from
  -- "crashed after the boundary" (outcome unknown).
  io_started_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}',
  error_category text,
  error_summary text CHECK(error_summary IS NULL OR length(error_summary) <= 400),
  -- Safe provider-side reference (message/transaction/idempotency id). Never a
  -- token, never a payload, never a body.
  provider_reference text
    CHECK(provider_reference IS NULL OR length(provider_reference) <= 200),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  -- One logical effect per run step, whatever the retry count.
  UNIQUE(tenant_id,run_id,step_seq,operation),
  UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,run_id)
    REFERENCES workflow_runs(tenant_id,id) ON DELETE CASCADE,
  CHECK(pg_column_size(result) <= 8192)
);
-- The worker's claim walks due effects only; a claimed row stays in the index so
-- an expired lease is reclaimable without a second index.
CREATE INDEX workflow_external_effects_claimable
  ON workflow_external_effects(tenant_id,next_attempt_at,id)
  WHERE status IN ('planned','claimed');
CREATE INDEX workflow_external_effects_run
  ON workflow_external_effects(tenant_id,run_id,step_seq);

ALTER TABLE workflow_external_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_external_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_external_effects
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON workflow_external_effects TO workspace_app;
