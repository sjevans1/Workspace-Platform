ALTER TABLE sessions
  ADD COLUMN oidc_issuer text,
  ADD COLUMN oidc_subject text,
  ADD COLUMN oidc_sid text;

CREATE INDEX sessions_oidc_subject
  ON sessions(oidc_issuer,oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

CREATE INDEX sessions_oidc_sid
  ON sessions(oidc_issuer,oidc_sid)
  WHERE oidc_issuer IS NOT NULL AND oidc_sid IS NOT NULL;

CREATE TABLE oidc_logout_events(
  issuer text NOT NULL,
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer,jti)
);

CREATE INDEX oidc_logout_events_expiry
  ON oidc_logout_events(expires_at);

GRANT SELECT,INSERT,DELETE ON oidc_logout_events TO workspace_app;
