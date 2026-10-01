ALTER TABLE object_deletions
  DROP CONSTRAINT object_deletions_reason_check;

ALTER TABLE object_deletions
  ADD CONSTRAINT object_deletions_reason_check
  CHECK(reason IN (
    'resource_purge',
    'file_retention',
    'upload_rollback',
    'storage_encryption_migration'
  ));
