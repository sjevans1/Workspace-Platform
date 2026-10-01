CREATE TABLE scim_connectors(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE,
  default_role text NOT NULL DEFAULT 'member'
    CHECK(default_role IN ('member','guest')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE scim_users(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id text,
  user_name text NOT NULL CHECK(length(user_name) BETWEEN 1 AND 320),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY(tenant_id,user_id)
    REFERENCES memberships(tenant_id,user_id)
);

CREATE UNIQUE INDEX scim_users_live_user
  ON scim_users(tenant_id,user_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX scim_users_live_username
  ON scim_users(tenant_id,lower(user_name))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX scim_users_live_external_id
  ON scim_users(tenant_id,external_id)
  WHERE deleted_at IS NULL AND external_id IS NOT NULL;

GRANT SELECT,INSERT,UPDATE,DELETE ON scim_connectors,scim_users TO workspace_app;

ALTER TABLE scim_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_connectors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_connectors
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE scim_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_users
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION scim_connector_context(p_hash text)
RETURNS TABLE(
  id uuid,
  tenant_id uuid,
  label text,
  default_role text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  SELECT c.id,c.tenant_id,c.label,c.default_role
  FROM scim_connectors c
  WHERE c.token_hash=p_hash
    AND c.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION scim_connector_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scim_connector_context(text) TO workspace_app;
