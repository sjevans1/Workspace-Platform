CREATE TABLE oidc_identities(
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer,subject),
  UNIQUE(user_id,issuer)
);

CREATE TABLE oidc_login_states(
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  invite_token_hash text,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX oidc_login_states_expiry ON oidc_login_states(expires_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON oidc_identities,oidc_login_states TO workspace_app;
