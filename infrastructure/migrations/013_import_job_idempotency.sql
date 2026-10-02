-- W09c: optional durable, principal-scoped CSV import replay keys.
-- Historical jobs (without keys) retain legacy behavior. The index covers
-- all job states, including completed/failed, to prevent replay after crash.
ALTER TABLE jobs ADD COLUMN idempotency_key text;
ALTER TABLE jobs ADD COLUMN request_digest text;
ALTER TABLE jobs ADD CONSTRAINT jobs_idempotency_pair_chk CHECK (
  (idempotency_key IS NULL AND request_digest IS NULL)
  OR (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'
    AND request_digest ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX jobs_principal_idempotency_unique
  ON jobs(tenant_id,user_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
