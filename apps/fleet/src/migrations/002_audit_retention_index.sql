-- Bounded audit retention support: an index on the pruning predicate so each pass selects the
-- oldest eligible rows without scanning the whole audit table.
CREATE INDEX IF NOT EXISTS fleet_audit_created_at ON fleet_audit(created_at);
