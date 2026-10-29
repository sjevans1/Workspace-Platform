-- W29-P0/A3 correction: the durable pre-I/O boundary for a refresh claim.
--
-- A refresh that may already have sent bytes to the provider cannot be safely
-- retried: the provider may have rotated the refresh token while the local commit
-- did not land. The claim therefore records the boundary explicitly, so an expired
-- lease that never started I/O may be reclaimed and retried, while an expired lease
-- that HAD started I/O transitions to attention/reconnect instead of blindly
-- replaying a possibly-invalidated token.

ALTER TABLE connector_oauth_refresh_claims
  ADD COLUMN state text NOT NULL DEFAULT 'claimed'
    CHECK(state IN ('claimed','in_flight','settled')),
  ADD COLUMN io_started_at timestamptz;

-- Reclaiming walks expired live claims only.
CREATE INDEX connector_oauth_refresh_claims_expiry
  ON connector_oauth_refresh_claims(tenant_id,expires_at)
  WHERE status = 'claimed';
