-- Preparing a rotation leaves delivery signing unchanged until activation.
ALTER TABLE webhook_subscriptions
  ADD COLUMN signing_revision integer NOT NULL DEFAULT 1 CHECK(signing_revision > 0),
  ADD COLUMN pending_secret_encrypted text;
