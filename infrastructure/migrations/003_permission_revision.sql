ALTER TABLE resources
  ADD COLUMN permission_revision integer NOT NULL DEFAULT 1
  CHECK(permission_revision > 0);
