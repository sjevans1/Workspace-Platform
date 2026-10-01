-- T3 schema groundwork only: preserve deployment-level OIDC state rows.
-- Tenant-selected sign-in MUST populate the full provider identity and compare
-- these values with the currently approved registry row on callback.
ALTER TABLE oidc_login_states
  ADD COLUMN tenant_id uuid,
  ADD COLUMN provider_id uuid,
  ADD COLUMN provider_revision integer,
  ADD COLUMN expected_issuer text,
  ADD COLUMN expected_client_id text;

ALTER TABLE oidc_login_states
  ADD CONSTRAINT oidc_state_provider_fields_atomic CHECK (
    (
      tenant_id IS NULL AND
      provider_id IS NULL AND
      provider_revision IS NULL AND
      expected_issuer IS NULL AND
      expected_client_id IS NULL
    ) OR (
      tenant_id IS NOT NULL AND
      provider_id IS NOT NULL AND
      provider_revision IS NOT NULL AND provider_revision > 0 AND
      expected_issuer IS NOT NULL AND length(expected_issuer) BETWEEN 1 AND 2048 AND
      expected_client_id IS NOT NULL AND length(expected_client_id) BETWEEN 1 AND 256
    )
  ),
  ADD CONSTRAINT oidc_state_tenant_provider_fk
    FOREIGN KEY(tenant_id,provider_id)
    REFERENCES oidc_tenant_providers(tenant_id,id) ON DELETE CASCADE;

ALTER TABLE sessions
  ADD COLUMN oidc_provider_id uuid;

ALTER TABLE sessions
  ADD CONSTRAINT oidc_session_provider_provenance CHECK (
    oidc_provider_id IS NULL OR (
      scopes IS NULL AND oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL
    )
  ),
  ADD CONSTRAINT oidc_session_tenant_provider_fk
    FOREIGN KEY(tenant_id,oidc_provider_id)
    REFERENCES oidc_tenant_providers(tenant_id,id);

CREATE INDEX sessions_oidc_provider
  ON sessions(tenant_id,oidc_provider_id)
  WHERE oidc_provider_id IS NOT NULL;

-- No UI, callback routing, provider enablement, or logout behavior changes.
