-- W29-P0/A3: provider-neutral OAuth2 authorization substrate.
--
-- This migration creates the storage layer for external-account authorization
-- (authorization-code + PKCE S256), for the durable refresh lease, and for the
-- bounded retention of both. No real provider is activated by this migration: the
-- registered descriptors are deployment configuration, and the release gate for a
-- real outbound provider remains the accepted #234 deployment-scoped egress work.
--
-- Tenant isolation follows the repository convention exactly: every table is
-- tenant-scoped, ENABLE + FORCE ROW LEVEL SECURITY with the standard
-- `tenant_isolation` policy, and the runtime role receives its own per-table grant.
-- Secret MATERIAL never lives in a plain column: only the *digest* of the externally
-- presented OAuth state is stored, and the PKCE verifier is sealed with
-- attempt-scoped AAD into `verifier_sealed`.
--
-- This table set is deliberately separate from the Workspace sign-in OIDC state
-- table (`oidc_login_states`). An identity-provider login state and an external
-- connector authorization attempt are different objects with different lifetimes,
-- bindings and failure modes, and sharing storage would let one masquerade as the
-- other.

CREATE TABLE connector_oauth_attempts(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  provider_key text NOT NULL CHECK(length(provider_key) BETWEEN 1 AND 64),
  initiated_by uuid NOT NULL REFERENCES users(id),
  -- NON-REVERSIBLE binding to the initiating session (the digest of the session
  -- token, never the token itself), so only the same authenticated session can
  -- consume the callback.
  session_digest text NOT NULL CHECK(length(session_digest) = 64),
  -- Only the HASH of the state that was handed to the browser. The raw state exists
  -- in the redirect and nowhere else.
  state_digest text NOT NULL CHECK(length(state_digest) = 64),
  -- The PKCE verifier, sealed with AAD bound to tenant + connection + attempt.
  verifier_sealed text NOT NULL,
  -- The exact registered redirect URI for this attempt: compared on callback, never
  -- taken from the request.
  redirect_uri text NOT NULL CHECK(length(redirect_uri) BETWEEN 1 AND 512),
  requested_scopes text[] NOT NULL DEFAULT '{}',
  requested_capabilities text[] NOT NULL DEFAULT '{}',
  -- One active generation per connection. A new authorization supersedes its
  -- predecessor, so two browser tabs cannot both hold a live authorization and a
  -- stale callback cannot revive an older intent.
  generation integer NOT NULL DEFAULT 1 CHECK(generation >= 1),
  status text NOT NULL DEFAULT 'authorizing'
    CHECK(status IN ('authorizing','exchanging','consumed','expired','denied','failed','superseded')),
  failure_category text CHECK(failure_category IS NULL OR length(failure_category) <= 64),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id)
    REFERENCES connector_connections(tenant_id,id) ON DELETE CASCADE
);

-- At most ONE live attempt per connection.
CREATE UNIQUE INDEX connector_oauth_attempts_active
  ON connector_oauth_attempts(tenant_id,connection_id)
  WHERE status IN ('authorizing','exchanging');
-- The callback resolves a presented state by digest.
CREATE UNIQUE INDEX connector_oauth_attempts_state
  ON connector_oauth_attempts(state_digest);
-- Expiry sweeping walks live attempts only.
CREATE INDEX connector_oauth_attempts_expiry
  ON connector_oauth_attempts(tenant_id,expires_at)
  WHERE status IN ('authorizing','exchanging');

-- The durable refresh lease. One active claim per connection: a concurrent worker
-- cannot start a second refresh for the same credential version, and a claim that
-- expires may be reclaimed, which is what makes a crashed worker recoverable
-- without a second refresh racing the first.
CREATE TABLE connector_oauth_refresh_claims(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  -- The credential version this claim is fenced to: a claim whose version is no
  -- longer the active credential cannot commit a rotation.
  credential_version integer NOT NULL CHECK(credential_version >= 1),
  claim_token text NOT NULL CHECK(length(claim_token) = 64),
  status text NOT NULL DEFAULT 'claimed'
    CHECK(status IN ('claimed','completed','failed','abandoned')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  -- Honest outcome category: `unknown` means the provider may have rotated the
  -- refresh token while the local commit did not land.
  failure_category text CHECK(failure_category IS NULL OR length(failure_category) <= 64),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id)
    REFERENCES connector_connections(tenant_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX connector_oauth_refresh_claims_active
  ON connector_oauth_refresh_claims(tenant_id,connection_id)
  WHERE status = 'claimed';
CREATE INDEX connector_oauth_refresh_claims_due
  ON connector_oauth_refresh_claims(tenant_id,expires_at)
  WHERE status = 'claimed';

ALTER TABLE connector_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_oauth_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_oauth_attempts
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE connector_oauth_refresh_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_oauth_refresh_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_oauth_refresh_claims
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON connector_oauth_attempts TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON connector_oauth_refresh_claims TO workspace_app;

-- Bounded retention. Consumed, expired and superseded attempts are kept long enough
-- to explain a failure to a customer and to prove a replay was refused, then pruned.
-- The function is tenant-scoped by the caller's RLS context: it is not a
-- deployment-wide sweep and it never crosses tenants.
CREATE OR REPLACE FUNCTION workspace_connector_oauth_prune(
  attempt_retention interval DEFAULT interval '7 days',
  claim_retention interval DEFAULT interval '7 days'
) RETURNS TABLE(pruned_attempts integer, pruned_claims integer) AS $$
DECLARE
  attempts integer;
  claims integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.connector_oauth_attempts
    WHERE status IN ('consumed','expired','denied','failed','superseded')
      AND updated_at < now() - attempt_retention
    RETURNING 1
  )
  SELECT count(*)::integer INTO attempts FROM gone;
  WITH gone AS (
    DELETE FROM public.connector_oauth_refresh_claims
    WHERE status IN ('completed','failed','abandoned')
      AND updated_at < now() - claim_retention
    RETURNING 1
  )
  SELECT count(*)::integer INTO claims FROM gone;
  RETURN QUERY SELECT attempts, claims;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION workspace_connector_oauth_prune(interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_connector_oauth_prune(interval, interval) TO workspace_app;
