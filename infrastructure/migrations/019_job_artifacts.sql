CREATE TABLE job_artifacts(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  object_key text UNIQUE NOT NULL,
  kind text NOT NULL CHECK(kind IN ('input','output')),
  name text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL CHECK(size>=0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE UNIQUE INDEX job_artifacts_one_kind_per_job
  ON job_artifacts(tenant_id,job_id,kind);
CREATE INDEX job_artifacts_expiry
  ON job_artifacts(tenant_id,expires_at,id);

ALTER TABLE job_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_artifacts
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON job_artifacts TO workspace_app;
