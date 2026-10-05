-- W12d: self-hosted, recipient-owned per-tenant alert choices.
-- Defaults preserve existing notification delivery semantics.
CREATE TABLE notification_preferences(
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  mentions_enabled boolean NOT NULL DEFAULT true,
  replies_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,user_id),
  FOREIGN KEY(tenant_id,user_id)
    REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_preferences TO workspace_app;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
