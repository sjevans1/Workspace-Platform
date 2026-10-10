-- X4b-3 / W04: admin/owner-assisted, mail-free account recovery material.
--
-- For 1.0 there is deliberately NO unauthenticated self-service "forgot password"
-- initiation: with no trusted delivery or verification channel in a mail-free
-- deployment, such a route would have to invent a second identity-verification
-- mechanism. An already authorised tenant owner/admin issues material for an
-- eligible same-tenant user; the material itself is then the proof of possession
-- when the user sets a new credential.
--
-- Only the hash is stored. The raw material is returned once at issuance and is
-- never persisted, logged or audited. Every row is single-use, expiring and
-- superseded by a newer issuance for the same user.
CREATE TABLE recovery_material(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  issued_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX recovery_material_user
  ON recovery_material(tenant_id,user_id,created_at DESC);

-- Tenant isolation, matching the existing pattern. The unauthenticated
-- completion path looks the row up by token hash through the system connection
-- (the same shape the invitation acceptance path already uses), then performs the
-- tenant-scoped writes inside a tenant transaction.
DO $$ BEGIN
  ALTER TABLE recovery_material ENABLE ROW LEVEL SECURITY;
  ALTER TABLE recovery_material FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON recovery_material
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
END $$;

-- The runtime role needs its own grant on every new table, matching the pattern
-- used by the other migrations. Without it the tenant-scoped statements fail with
-- "permission denied for table", even though RLS is configured correctly.
GRANT SELECT,INSERT,UPDATE,DELETE ON recovery_material TO workspace_app;

-- The unauthenticated completion path must resolve material by token hash with no
-- tenant context, so it goes through a SECURITY DEFINER function exactly as the
-- invitation acceptance path already does. It returns the row regardless of state
-- (expired/used/revoked), because the caller applies ONE uniform denial to every
-- unusable case and the atomic claim below enforces single-use and expiry.
CREATE FUNCTION recovery_material_context(p_hash text)
  RETURNS TABLE(id uuid,tenant_id uuid,user_id uuid,expires_at timestamptz,used_at timestamptz,revoked_at timestamptz)
  LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT id,tenant_id,user_id,expires_at,used_at,revoked_at
      FROM recovery_material WHERE token_hash=p_hash;
  $$;
REVOKE ALL ON FUNCTION recovery_material_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recovery_material_context(text) TO workspace_app;
