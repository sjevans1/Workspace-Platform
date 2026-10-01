-- T3A: schema-only provider binding for a single-use OIDC authorization state.
-- Existing deployment-wide OIDC login states remain valid with all five
-- binding columns NULL; the active sign-in/callback routes are unchanged.
ALTER TABLE oidc_login_states
  ADD COLUMN tenant_id uuid,
  ADD COLUMN provider_id uuid,
  ADD COLUMN provider_revision integer,
  ADD COLUMN expected_issuer text,
  ADD COLUMN expected_client_id text;

-- PostgreSQL CHECK expressions can evaluate to UNKNOWN; explicit IS NOT NULL
-- checks are necessary so a partially populated state fails closed.
ALTER TABLE oidc_login_states
  ADD CONSTRAINT oidc_state_complete_provider_binding CHECK (
    (
      tenant_id IS NULL
      AND provider_id IS NULL
      AND provider_revision IS NULL
      AND expected_issuer IS NULL
      AND expected_client_id IS NULL
    )
    OR
    (
      tenant_id IS NOT NULL
      AND provider_id IS NOT NULL
      AND provider_revision IS NOT NULL
      AND provider_revision > 0
      AND expected_issuer IS NOT NULL
      AND length(expected_issuer) BETWEEN 1 AND 2048
      AND expected_client_id IS NOT NULL
      AND length(expected_client_id) BETWEEN 1 AND 256
    )
  ),
  ADD CONSTRAINT oidc_state_provider_tenant_fk
    FOREIGN KEY (tenant_id,provider_id)
    REFERENCES oidc_tenant_providers(tenant_id,id);

CREATE INDEX oidc_state_provider_expiry
  ON oidc_login_states(tenant_id,provider_id,expires_at)
  WHERE provider_id IS NOT NULL;
