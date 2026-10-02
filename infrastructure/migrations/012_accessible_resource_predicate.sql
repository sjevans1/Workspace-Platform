-- W08: permission check performed by PostgreSQL *before* pagination.
-- SECURITY INVOKER is intentional: workspace_runtime is NOBYPASSRLS, and
-- this function uses the same tenant-scoped resources and ACL relations as
-- packages/permissions/index.ts::evaluate. Never change to SECURITY DEFINER.
CREATE FUNCTION workspace_can_read_resource(
  p_resource uuid, p_actor uuid, p_role text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=public,pg_temp
AS $$
DECLARE
  chain_entry record;
  permission_level integer;
  grant_level integer;
  have_resource boolean := false;
BEGIN
  IF p_role IS NULL OR
    p_role NOT IN ('owner','admin','member','guest') OR
    p_actor IS NULL THEN RETURN false;
  END IF;
  -- A caller may never manufacture a higher privilege by passing an
  -- arbitrary role. Tenant RLS applies to memberships under this invoker.
  IF NOT EXISTS (
    SELECT 1 FROM memberships
    WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      AND user_id=p_actor AND role=p_role AND active
  ) THEN RETURN false; END IF;
  permission_level := CASE WHEN p_role IN ('owner','admin') THEN 4
    WHEN p_role = 'guest' THEN 0 ELSE 3 END;
  FOR chain_entry IN
    WITH RECURSIVE parents AS (
      SELECT id,parent_id,deleted_at,inherit_permissions,
        ARRAY[id] AS ancestors,0 AS depth
      FROM resources WHERE id=p_resource
      UNION ALL
      SELECT r.id,r.parent_id,r.deleted_at,r.inherit_permissions,
        parents.ancestors || r.id,parents.depth+1
      FROM resources r JOIN parents ON parents.parent_id=r.id
      WHERE parents.depth<64 AND NOT r.id=ANY(parents.ancestors)
    )
    SELECT id,deleted_at,inherit_permissions FROM parents ORDER BY depth DESC
  LOOP
    have_resource := true;
    IF chain_entry.deleted_at IS NOT NULL THEN RETURN false; END IF;
    -- JS evaluate() grants owners/admins level 4 after validating a live
    -- ancestry path, without applying per-resource ACLs.
    IF p_role IN ('owner','admin') THEN CONTINUE; END IF;

    IF NOT chain_entry.inherit_permissions THEN permission_level := 0; END IF;
    SELECT level INTO grant_level FROM acl
      WHERE resource_id=chain_entry.id AND principal_id=p_actor::text;
    IF FOUND THEN
      permission_level := grant_level;
    ELSE
      SELECT level INTO grant_level FROM acl
        WHERE resource_id=chain_entry.id AND principal_id='*';
      IF FOUND THEN permission_level := grant_level; END IF;
    END IF;
    -- Match JS early return: a denied ancestor cannot be overruled later.
    IF permission_level = 0 THEN RETURN false; END IF;
  END LOOP;
  RETURN have_resource AND permission_level > 0;
END
$$;

REVOKE ALL ON FUNCTION workspace_can_read_resource(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_can_read_resource(uuid,uuid,text) TO workspace_app;
