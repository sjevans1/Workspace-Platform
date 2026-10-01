ALTER TABLE scim_users
  ADD COLUMN base_role text
  CHECK(base_role IN ('member','guest'));

UPDATE scim_users s
SET base_role = CASE
  WHEN m.role IN ('member','guest') THEN m.role
  ELSE 'member'
END
FROM memberships m
WHERE m.tenant_id=s.tenant_id
  AND m.user_id=s.user_id
  AND s.base_role IS NULL;

ALTER TABLE scim_users
  ALTER COLUMN base_role SET DEFAULT 'member',
  ALTER COLUMN base_role SET NOT NULL;

CREATE TABLE scim_groups(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  external_id text,
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX scim_groups_live_name
  ON scim_groups(tenant_id,lower(display_name))
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX scim_groups_live_external_id
  ON scim_groups(tenant_id,external_id)
  WHERE deleted_at IS NULL AND external_id IS NOT NULL;

CREATE TABLE scim_group_members(
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  scim_user_id uuid NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id,scim_user_id)
);

CREATE TABLE scim_group_role_mappings(
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  group_id uuid PRIMARY KEY REFERENCES scim_groups(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('member','guest')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT,INSERT,UPDATE,DELETE
  ON scim_groups,scim_group_members,scim_group_role_mappings
  TO workspace_app;

ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_groups
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE scim_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_group_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_group_members
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE scim_group_role_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE scim_group_role_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scim_group_role_mappings
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
