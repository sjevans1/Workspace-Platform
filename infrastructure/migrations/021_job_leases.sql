-- W09: crash-recoverable async job leases and bounded cancellation metadata.
ALTER TABLE jobs
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN cancelled_at timestamptz;

CREATE INDEX jobs_claimable
  ON jobs(tenant_id,created_at,id)
  WHERE status IN ('pending','running');
