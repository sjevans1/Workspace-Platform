-- X4b-2 / W03: issuer-scoped lookup for back-channel logout validation.
--
-- The logout endpoint is unauthenticated and runs without a tenant context, while
-- oidc_tenant_providers is RLS-forced. A logout token's claimed issuer must select
-- the provider(s) that validate it, so the lookup goes through a SECURITY DEFINER
-- function exactly as the invitation and recovery lookups already do.
--
-- The claimed issuer only SELECTS candidates; the token is then verified with each
-- candidate's own configuration, so an untrusted issuer can never authorize on its
-- own. Only activated, unrevoked providers are returned: a disabled or revoked
-- provider cannot validate a logout token.
CREATE FUNCTION oidc_tenant_providers_by_issuer(p_issuer text)
  RETURNS TABLE(
    id uuid, tenant_id uuid, label text, issuer text, client_id text,
    client_secret_encrypted text, token_auth_method text, scopes text[],
    require_verified_email boolean, enabled boolean, revision integer,
    revoked_at timestamptz
  )
  LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT id,tenant_id,label,issuer,client_id,client_secret_encrypted,
           token_auth_method,scopes,require_verified_email,enabled,revision,revoked_at
      FROM oidc_tenant_providers
     WHERE issuer=p_issuer AND enabled AND revoked_at IS NULL
     ORDER BY tenant_id, id;
  $$;
REVOKE ALL ON FUNCTION oidc_tenant_providers_by_issuer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oidc_tenant_providers_by_issuer(text) TO workspace_app;
