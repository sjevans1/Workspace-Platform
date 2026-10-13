-- W29-A: provider-neutral Connected Work foundation.
--
-- This migration creates the storage layer for the governed connector plane that
-- provider adapters (Gmail, Microsoft Graph, CalDAV, Telegram, Discord, WhatsApp)
-- will plug into. No provider is implemented here and no external account is
-- required: Workspace remains fully functional with zero connected providers.
--
-- Tenant isolation posture is the repository's existing one: every table is
-- tenant-scoped, ENABLE + FORCE ROW LEVEL SECURITY with the standard
-- `tenant_isolation` policy, and the runtime role `workspace_app` receives its own
-- per-table grant. Secret MATERIAL never lives in a plain column: the credential
-- envelope stores ciphertext only, and all non-secret descriptors live in
-- `metadata`, which is what audit, status and support surfaces may read.

CREATE TABLE connector_connections(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK(length(provider_key) BETWEEN 1 AND 64),
  -- The ownership kind is explicit and immutable (see the guard trigger below).
  -- 'user' means the connection belongs to one delegated user; 'tenant' means it
  -- is a shared tenant resource. Authorization can therefore never be ambiguous.
  ownership text NOT NULL CHECK(ownership IN ('user','tenant')),
  owner_user_id uuid REFERENCES users(id),
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','connected','attention_required','disabled','revoked','error')),
  enabled boolean NOT NULL DEFAULT true,
  capabilities_requested text[] NOT NULL DEFAULT '{}',
  capabilities_granted text[] NOT NULL DEFAULT '{}',
  -- Non-secret provider configuration only (for example a selected mailbox label
  -- or an allowlisted chat id). Secrets belong in connector_credentials.
  config jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  connected_at timestamptz,
  disabled_at timestamptz,
  revoked_at timestamptz,
  last_success_at timestamptz,
  last_sync_at timestamptz,
  last_event_at timestamptz,
  last_error_at timestamptz,
  last_error_category text,
  attention_reason text,
  UNIQUE(tenant_id,id),
  CHECK((ownership='user' AND owner_user_id IS NOT NULL)
     OR (ownership='tenant' AND owner_user_id IS NULL)),
  CHECK(status<>'revoked' OR revoked_at IS NOT NULL),
  CHECK(pg_column_size(config) <= 8192)
);
CREATE INDEX connector_connections_tenant
  ON connector_connections(tenant_id,provider_key,created_at DESC,id);
CREATE INDEX connector_connections_owner
  ON connector_connections(tenant_id,owner_user_id,created_at DESC,id)
  WHERE owner_user_id IS NOT NULL;

-- Ownership identity is immutable: a connection can be disabled, revoked,
-- reconnected or re-labelled, but it can never silently change owner, tenant or
-- provider, because authorization decisions are bound to exactly those columns.
CREATE FUNCTION workspace_connector_connection_identity_guard()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.ownership IS DISTINCT FROM OLD.ownership
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'connector connection identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_connections_identity_immutable
  BEFORE UPDATE ON connector_connections
  FOR EACH ROW EXECUTE FUNCTION workspace_connector_connection_identity_guard();

-- The credential envelope. `secret_encrypted` carries the AES-256-GCM envelope
-- produced by the existing Workspace encryption module (iv.tag.ciphertext,
-- base64url) keyed by ENCRYPTION_KEY. `metadata` is the non-secret half: key id,
-- algorithm, scope list, expiry, and for ingress credentials an irreversible
-- token digest used to resolve a connection without a tenant context.
CREATE TABLE connector_credentials(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN (
    'oauth_access','oauth_refresh','api_key','bot_token',
    'client_secret','webhook_secret','basic')),
  secret_encrypted text NOT NULL CHECK(length(secret_encrypted) BETWEEN 1 AND 16384),
  metadata jsonb NOT NULL DEFAULT '{}',
  key_version integer NOT NULL DEFAULT 1 CHECK(key_version BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY(tenant_id,connection_id)
    REFERENCES connector_connections(tenant_id,id) ON DELETE CASCADE,
  CHECK(pg_column_size(metadata) <= 4096)
);
-- At most one ACTIVE credential per (connection, kind). Rotation inserts the
-- replacement first and revokes the predecessor, so a connection is never
-- left without usable material by an interrupted rotation.
CREATE UNIQUE INDEX connector_credentials_active
  ON connector_credentials(tenant_id,connection_id,kind)
  WHERE revoked_at IS NULL;
CREATE INDEX connector_credentials_history
  ON connector_credentials(tenant_id,connection_id,kind,created_at DESC,id);

-- Provider-neutral sync state. The cursor is OPAQUE to generic Workspace code:
-- only the owning adapter may interpret it. A failed sync must not advance it,
-- so the cursor is written exclusively in the same statement that records a
-- successful committed sync.
CREATE TABLE connector_sync_state(
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  cursor text CHECK(cursor IS NULL OR length(cursor) <= 4096),
  sync_generation integer NOT NULL DEFAULT 1 CHECK(sync_generation >= 1),
  status text NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle','pending','running','failed','attention')),
  poll_interval_seconds integer NOT NULL DEFAULT 300
    CHECK(poll_interval_seconds BETWEEN 60 AND 86400),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_category text,
  last_error_summary text CHECK(last_error_summary IS NULL OR length(last_error_summary) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,connection_id),
  FOREIGN KEY(tenant_id,connection_id)
    REFERENCES connector_connections(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX connector_sync_claimable
  ON connector_sync_state(tenant_id,next_attempt_at,connection_id)
  WHERE status IN ('pending','failed');

-- Normalized external events. A provider delivery is deduplicated by the
-- adapter-supplied dedupe key: repeated delivery of the same provider event
-- INCREMENTS duplicate_count on the one logical row instead of inserting a
-- second event, so one provider event maps to exactly one connector event and
-- therefore to at most one workflow run.
CREATE TABLE connector_events(
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  provider_key text NOT NULL,
  event_type text NOT NULL CHECK(length(event_type) BETWEEN 1 AND 120),
  provider_event_id text CHECK(provider_event_id IS NULL OR length(provider_event_id) <= 256),
  dedupe_key text NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 256),
  -- Authentication/verification status of the inbound request. Only 'verified'
  -- events may become executable workflow input.
  verification text NOT NULL CHECK(verification IN ('verified','unverified','rejected')),
  received_at timestamptz NOT NULL DEFAULT now(),
  provider_occurred_at timestamptz,
  normalized_resource_refs jsonb NOT NULL DEFAULT '[]',
  -- Opaque reference to the provider payload plus bounded metadata. Never the
  -- raw payload, never credential material.
  payload_ref jsonb NOT NULL DEFAULT '{}',
  duplicate_count integer NOT NULL DEFAULT 0 CHECK(duplicate_count >= 0),
  dispatch_state text NOT NULL DEFAULT 'pending'
    CHECK(dispatch_state IN ('pending','dispatched','skipped')),
  processed_at timestamptz,
  UNIQUE(tenant_id,connection_id,dedupe_key),
  CHECK(pg_column_size(payload_ref) <= 8192),
  CHECK(pg_column_size(normalized_resource_refs) <= 8192),
  FOREIGN KEY(tenant_id,connection_id)
    REFERENCES connector_connections(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX connector_events_recent
  ON connector_events(tenant_id,received_at DESC,id DESC);
CREATE INDEX connector_events_pending
  ON connector_events(tenant_id,received_at,id) WHERE dispatch_state='pending';

-- Ingress resolution runs WITHOUT a tenant context (the provider request is
-- unauthenticated), while connector_connections and connector_credentials are
-- FORCE ROW LEVEL SECURITY, so a raw SELECT would silently return zero rows and
-- every request would look like a uniform denial. This definer lookup mirrors
-- the repository's existing helpers (session_actor, invitation_context,
-- oidc_tenant_providers_by_issuer): fixed search_path, no dynamic SQL, and it
-- returns only the connection identity needed to establish tenant context plus
-- the verification material the caller must itself compare.
CREATE FUNCTION connector_ingress_context(p_connection uuid, p_token_hash text)
  RETURNS TABLE(
    tenant_id uuid,
    connection_id uuid,
    provider_key text,
    status text,
    enabled boolean,
    ownership text,
    owner_user_id uuid,
    secret_encrypted text
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.tenant_id, c.id, c.provider_key, c.status, c.enabled, c.ownership,
         c.owner_user_id, cr.secret_encrypted
    FROM public.connector_connections c
    JOIN public.connector_credentials cr
      ON cr.tenant_id = c.tenant_id
     AND cr.connection_id = c.id
     AND cr.kind = 'webhook_secret'
     AND cr.revoked_at IS NULL
   WHERE c.id = p_connection
     AND cr.metadata->>'token_digest' = p_token_hash;
$$;

-- Deployment-wide, count-only connector health for the operator surfaces. The
-- connector tables are FORCE ROW LEVEL SECURITY, so a tenant-less aggregate
-- returns zero rows and would falsely report a healthy fleet. Return type is
-- integers only, so this can never become a cross-tenant row primitive.
CREATE FUNCTION public.workspace_connector_health()
  RETURNS TABLE(
    connections integer,
    attention_required integer,
    sync_failures integer,
    events_received integer,
    events_duplicate integer
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*)::integer FROM public.connector_connections),
    (SELECT count(*)::integer FROM public.connector_connections
      WHERE status = 'attention_required'),
    (SELECT count(*)::integer FROM public.connector_sync_state
      WHERE status IN ('failed','attention')),
    (SELECT count(*)::integer FROM public.connector_events),
    (SELECT COALESCE(SUM(duplicate_count),0)::integer FROM public.connector_events);
$$;

ALTER TABLE connector_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_connections
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_credentials
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE connector_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_sync_state
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_events
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON connector_connections TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON connector_credentials TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON connector_sync_state TO workspace_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON connector_events TO workspace_app;
REVOKE ALL ON FUNCTION connector_ingress_context(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connector_ingress_context(uuid,text) TO workspace_app;
REVOKE ALL ON FUNCTION public.workspace_connector_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_connector_health() TO workspace_app;
GRANT EXECUTE ON FUNCTION workspace_connector_connection_identity_guard() TO workspace_app;
