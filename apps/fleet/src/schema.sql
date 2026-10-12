-- OCP-2A: fleet/operator plane schema. Independent of the Workspace schema: this
-- service owns its own tables and is applied idempotently at boot. It stores no
-- customer content, no tenant data and no Workspace secrets.
CREATE TABLE IF NOT EXISTS deployments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_deployment_id text NOT NULL UNIQUE,
  alias text CHECK(alias IS NULL OR length(alias) <= 64),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','disabled','revoked')),
  first_seen timestamptz,
  last_seen timestamptz,
  app_version text,
  build_sha text,
  schema_version text,
  contract_version text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployment_credentials(
  id text PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS deployment_credentials_deployment ON deployment_credentials(deployment_id);

CREATE TABLE IF NOT EXISTS deployment_current_state(
  deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  contract_version text NOT NULL,
  envelope_version text NOT NULL,
  telemetry jsonb NOT NULL
);

-- Bounded history: state observations only, pruned deterministically to the
-- configured limit per deployment on each accept.
CREATE TABLE IF NOT EXISTS deployment_state_history(
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  queue_state text,
  backup_state text,
  online_state text
);
CREATE INDEX IF NOT EXISTS deployment_state_history_recent ON deployment_state_history(deployment_id, observed_at DESC);

-- Replay protection: bounded, pruned to a retention window on each accept. The
-- uniqueness on (credential_id, nonce) rejects a replayed nonce and the uniqueness on
-- signature rejects a replayed envelope.
CREATE TABLE IF NOT EXISTS fleet_replay(
  credential_id text NOT NULL,
  nonce text NOT NULL,
  signature text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, nonce),
  UNIQUE (signature)
);
CREATE INDEX IF NOT EXISTS fleet_replay_seen ON fleet_replay(seen_at);

-- Fleet operator audit. Bounded metadata only; never secret material.
CREATE TABLE IF NOT EXISTS fleet_audit(
  id uuid PRIMARY KEY,
  action text NOT NULL,
  deployment_id uuid,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_audit_recent ON fleet_audit(created_at DESC);
