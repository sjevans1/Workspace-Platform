-- W13b: indexed internal page-link graph for scalable backlinks.
-- Backfill narrows to canonical ?page=<uuid> references. Application reads
-- still re-parse canonical blocks, so legacy false-positive text is never
-- exposed as a backlink; future writes maintain this table exactly.
CREATE TABLE resource_links(
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,source_id,target_id),
  FOREIGN KEY(tenant_id,source_id)
    REFERENCES resources(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,target_id)
    REFERENCES resources(tenant_id,id) ON DELETE CASCADE,
  CHECK(source_id<>target_id)
);
CREATE INDEX resource_links_target
  ON resource_links(tenant_id,target_id,source_id);
GRANT SELECT,INSERT,DELETE ON resource_links TO workspace_app;
ALTER TABLE resource_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON resource_links
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Backfill existing documents without trusting arbitrary UUID text.
INSERT INTO resource_links(tenant_id,source_id,target_id)
SELECT DISTINCT d.tenant_id,d.resource_id,(match.ids)[1]::uuid
FROM page_documents d
CROSS JOIN LATERAL regexp_matches(
  d.blocks::text,
  '[/]?[?]page=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})',
  'g'
) AS match(ids)
JOIN resources target
  ON target.tenant_id=d.tenant_id
 AND target.id=(match.ids)[1]::uuid
 AND target.kind IN ('page','record')
WHERE d.resource_id<>(match.ids)[1]::uuid
ON CONFLICT DO NOTHING;
