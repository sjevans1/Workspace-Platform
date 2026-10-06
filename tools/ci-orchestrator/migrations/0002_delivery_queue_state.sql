-- Tracks whether a delivery has actually reached the Cloudflare Queue.
-- A NULL queued_at on an existing row means a prior attempt wrote the claim
-- but did not finish enqueueing, so a GitHub redelivery re-enqueues it instead
-- of treating it as a duplicate. This makes the delivery ledger durable and
-- event-loss-free without a best-effort DELETE.
ALTER TABLE github_deliveries ADD COLUMN queued_at TEXT;
