-- OCP-1C: customer-authorized support evidence.
--
-- A support window is an explicit, time-bounded, revocable, auditable authorization
-- held by a customer owner/admin. Generated package METADATA is retained boundedly;
-- package CONTENT is never persisted here, because a support bundle is evidence that
-- the operator downloads, not collected customer data.
CREATE TABLE support_authorizations(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  purpose text CHECK(purpose IS NULL OR length(purpose) BETWEEN 1 AND 64),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  actor_id uuid REFERENCES users(id),
  CHECK(expires_at > issued_at)
);
CREATE INDEX support_authorizations_active
  ON support_authorizations(tenant_id,expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE support_packages(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  authorization_id uuid REFERENCES support_authorizations(id) ON DELETE SET NULL,
  digest text NOT NULL CHECK(length(digest) = 64),
  bytes integer NOT NULL CHECK(bytes > 0),
  event_count integer NOT NULL DEFAULT 0 CHECK(event_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_packages_recent ON support_packages(tenant_id,created_at DESC);

ALTER TABLE support_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_authorizations
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE support_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_packages
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON support_authorizations TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON support_packages TO workspace_app;
