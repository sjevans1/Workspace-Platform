-- W13c: preserve deterministic updated_at,id backlink ordering inside the
-- candidate index so PostgreSQL can paginate a hot target without evaluating
-- recursive ACLs across every matching source before LIMIT.
ALTER TABLE resource_links ADD COLUMN source_updated_at timestamptz;

UPDATE resource_links link
SET source_updated_at=source.updated_at
FROM resources source
WHERE source.tenant_id=link.tenant_id AND source.id=link.source_id;

ALTER TABLE resource_links
  ALTER COLUMN source_updated_at SET NOT NULL;

CREATE INDEX resource_links_target_updated
  ON resource_links(tenant_id,target_id,source_updated_at DESC,source_id DESC);

CREATE FUNCTION workspace_sync_resource_link_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    UPDATE resource_links
    SET source_updated_at=NEW.updated_at
    WHERE tenant_id=NEW.tenant_id AND source_id=NEW.id;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION workspace_sync_resource_link_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_sync_resource_link_updated_at() TO workspace_app;

CREATE TRIGGER resource_links_source_updated_at
AFTER UPDATE OF updated_at ON resources
FOR EACH ROW EXECUTE FUNCTION workspace_sync_resource_link_updated_at();
