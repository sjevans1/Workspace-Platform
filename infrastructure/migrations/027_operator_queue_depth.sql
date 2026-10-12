-- OCP-1 source enrichment: bounded, count-only deployment-wide queue aggregate.
--
-- The product job tables (webhook_deliveries, object_deletions) are FORCE ROW LEVEL
-- SECURITY, so a tenant-less direct aggregate sees nothing and would falsely report an
-- empty queue for a deployment with real backlog. This SECURITY DEFINER function
-- returns ONLY per-status counts.
--
-- Hardening, mirroring the repository's existing helpers (worker_tenants,
-- session_actor, invitation_context, oidc_tenant_providers_by_issuer):
-- - fixed search_path, no dynamic SQL, no caller-controlled input and no arguments;
-- - schema-qualified tables;
-- - return type is three integers, so it can never be used as a general cross-tenant
--   row primitive: no row, id, tenant, user, object, payload, URL, error text or
--   per-job timestamp can be obtained through it;
-- - EXECUTE is revoked from PUBLIC and granted only to the application role;
-- - created by the migration role, exactly like the existing helpers.
CREATE FUNCTION public.workspace_queue_depth()
  RETURNS TABLE(pending integer, retry integer, dead integer)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE(SUM(CASE WHEN s.status = 'pending' THEN s.c ELSE 0 END), 0)::integer AS pending,
    COALESCE(SUM(CASE WHEN s.status = 'retry' THEN s.c ELSE 0 END), 0)::integer AS retry,
    COALESCE(SUM(CASE WHEN s.status = 'dead' THEN s.c ELSE 0 END), 0)::integer AS dead
  FROM (
    SELECT status, count(*)::integer AS c
      FROM public.webhook_deliveries
     WHERE status IN ('pending', 'retry', 'dead')
     GROUP BY status
    UNION ALL
    SELECT status, count(*)::integer AS c
      FROM public.object_deletions
     WHERE status IN ('pending', 'retry', 'dead')
     GROUP BY status
  ) AS s;
$$;
REVOKE ALL ON FUNCTION public.workspace_queue_depth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_queue_depth() TO workspace_app;
