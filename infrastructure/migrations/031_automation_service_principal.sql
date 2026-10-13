-- W30-A: the tenant automation service principal.
--
-- A workflow may execute under a DELEGATED USER authority (it runs as the user who
-- owns it, with that user's live Workspace permissions) or under an explicit TENANT
-- AUTOMATION SERVICE PRINCIPAL. The service principal is a real but deliberately
-- constrained identity, and its authority is bounded by an allowlist that an
-- owner/admin provisions here.
--
-- Two properties make that a genuine privilege boundary rather than a label:
--  - the identity is chosen by the operator, in this table, NOT by the workflow
--    author, so a workflow cannot name an arbitrary user as its own authority;
--  - every action declares a `service_capability`, and the engine refuses an action
--    whose capability is outside this allowlist.
--
-- The allowlist is restricted in the database to the capabilities the action
-- registry actually declares, so a future adapter cannot widen it by writing an
-- unregistered string.
CREATE TABLE tenant_automation_principals(
  tenant_id uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  capabilities text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(
    capabilities <@ ARRAY[
      'notification.create',
      'record.create',
      'record.update',
      'webhook.emit',
      'connector.action',
      'workflow.delay'
    ]::text[]
  ),
  CHECK(array_length(capabilities,1) IS NULL OR array_length(capabilities,1) <= 6)
);

ALTER TABLE tenant_automation_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_automation_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_automation_principals
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON tenant_automation_principals TO workspace_app;
