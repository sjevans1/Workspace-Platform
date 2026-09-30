ALTER TABLE organisations
  ADD COLUMN trash_retention_days integer DEFAULT 30
  CHECK (trash_retention_days IS NULL OR trash_retention_days BETWEEN 1 AND 3650);

CREATE TABLE object_deletions(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('resource_purge','file_retention','upload_rollback')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','completed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,object_key)
);
CREATE INDEX object_deletions_pending
  ON object_deletions(tenant_id,next_at)
  WHERE status IN ('pending','retry');

GRANT SELECT,INSERT,UPDATE,DELETE ON object_deletions TO workspace_app;
ALTER TABLE object_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON object_deletions
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
