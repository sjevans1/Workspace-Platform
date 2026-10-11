-- X4b-2 / W03: tenant provider provenance on sessions.
--
-- Revocation scoped only by issuer + sid/subject cannot separate two providers
-- that share an issuer but use different clients, because a subject-only logout
-- would match every session with that issuer and subject regardless of which
-- provider created it. Sessions therefore record the provider that created them.
--
-- Semantics: a tenant-provider session stores that exact provider id; a
-- deployment-level OIDC session stores NULL (the deployment scope); a
-- local/password session stores NULL and carries no OIDC provenance at all.
ALTER TABLE sessions ADD COLUMN oidc_provider_id uuid;

-- Upgrade safety: sessions created before provider provenance existed cannot be
-- attributed to a provider without guessing, and an issuer-only backfill would be
-- ambiguous whenever an issuer is registered more than once. This is pre-1.0, so
-- existing OIDC sessions are invalidated once and SSO users reauthenticate.
-- Local/password break-glass sessions carry no issuer and are untouched.
DELETE FROM sessions WHERE oidc_issuer IS NOT NULL;

CREATE INDEX sessions_oidc_provider
  ON sessions(oidc_issuer,oidc_provider_id,oidc_sid)
  WHERE oidc_issuer IS NOT NULL;
CREATE INDEX sessions_oidc_provider_subject
  ON sessions(oidc_issuer,oidc_provider_id,oidc_subject)
  WHERE oidc_issuer IS NOT NULL;