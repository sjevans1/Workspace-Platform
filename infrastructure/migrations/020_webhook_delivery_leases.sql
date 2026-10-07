-- W20: crash-safe webhook delivery leases.
-- Network I/O must happen outside tenant transactions. A worker claims a
-- bounded lease, performs delivery without DB locks, then acknowledges only
-- if it still owns the lease token.
ALTER TABLE webhook_deliveries
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz;

CREATE INDEX webhook_delivery_claimable
  ON webhook_deliveries(tenant_id,next_at,id)
  WHERE status IN ('pending','retry');
