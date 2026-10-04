-- W11c: reply threads are always constrained to their parent resource and tenant.
-- Historical comments are roots, so NULL preserves existing conversations.
ALTER TABLE comments ADD COLUMN parent_comment_id uuid;
-- PostgreSQL requires an exact referenced unique key for the composite FK.
CREATE UNIQUE INDEX comments_scope_identity ON comments(tenant_id,resource_id,id);
ALTER TABLE comments
  ADD CONSTRAINT comments_parent_same_resource
  FOREIGN KEY (tenant_id,resource_id,parent_comment_id)
  REFERENCES comments(tenant_id,resource_id,id)
  ON DELETE CASCADE;
CREATE INDEX comments_thread_listing
  ON comments(tenant_id,resource_id,parent_comment_id,created_at,id);
