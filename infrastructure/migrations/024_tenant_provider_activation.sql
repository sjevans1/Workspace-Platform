-- X4b-1 / W02: tenant IdP activation.
--
-- Migration 009 intentionally registered tenant providers as permanently
-- disabled (`enabled boolean NOT NULL DEFAULT false CHECK(enabled = false)`), so
-- tenant-scoped sign-in could not be switched on by accident. W02 adds the
-- explicit, operator-controlled activation step, so the constraint is replaced by
-- one that still fails closed: a provider can only be enabled once an activation
-- has actually been recorded, and disabling clears that record.
ALTER TABLE oidc_tenant_providers
  DROP CONSTRAINT oidc_tenant_providers_enabled_check;
ALTER TABLE oidc_tenant_providers ADD COLUMN activated_at timestamptz;
ALTER TABLE oidc_tenant_providers
  ADD CONSTRAINT oidc_tenant_providers_activation_check
  CHECK (
    (NOT enabled AND activated_at IS NULL)
    OR (enabled AND activated_at IS NOT NULL)
  );
