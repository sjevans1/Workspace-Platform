-- W09e: cooperative cancellation signal for durable database export jobs.
--
-- A worker holds the claimed `jobs` row FOR UPDATE for the whole job, so a
-- cancellation request for a *running* export cannot be written to the jobs
-- row without blocking on that lock. This side table carries the signal
-- without contending with the job row, and the worker reads it between
-- bounded keyset batches. There is deliberately no foreign key to `jobs`:
-- a foreign key would take a KEY SHARE lock on the referenced job row and
-- block on the same FOR UPDATE the table exists to avoid. The worker deletes
-- the row when the job reaches any terminal state, so orphans are bounded.
CREATE TABLE job_cancellations(
  job_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid
);
ALTER TABLE job_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_cancellations
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON job_cancellations TO workspace_app;
