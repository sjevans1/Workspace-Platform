-- Tenant provider registrations are deliberately *inert* in T2.
-- No sign-in, callback, discovery or logout routing reads this table yet.
CREATE TABLE oidc_tenant_providers(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 256),
  token_auth_method text NOT NULL
    CHECK(token_auth_method IN ('client_secret_basic','client_secret_post','none')),
  client_secret_encrypted text,
  scopes text[] NOT NULL DEFAULT ARRAY['openid','profile','email']::text[],
  require_verified_email boolean NOT NULL DEFAULT true
    CHECK(require_verified_email),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  enabled boolean NOT NULL DEFAULT false CHECK(enabled = false),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (
    (token_auth_method = 'none' AND client_secret_encrypted IS NULL) OR
    (token_auth_method IN ('client_secret_basic','client_secret_post')
      AND client_secret_encrypted IS NOT NULL)
  ),
  UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX oidc_tenant_providers_live
  ON oidc_tenant_providers(tenant_id,issuer,client_id)
  WHERE revoked_at IS NULL;
CREATE INDEX oidc_tenant_providers_tenant
  ON oidc_tenant_providers(tenant_id,created_at DESC);

GRANT SELECT,INSERT,UPDATE,DELETE ON oidc_tenant_providers TO workspace_app;
ALTER TABLE oidc_tenant_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oidc_tenant_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oidc_tenant_providers
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
