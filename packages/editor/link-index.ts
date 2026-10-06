import type { Query } from "../database/index.ts";
import { linkedWorkspaceResources } from "./links.ts";

/**
 * Keep the materialized internal-link graph transactionally aligned with the
 * canonical document write. Targets are admitted only when they are a live
 * page/record in the same tenant; guessed or cross-tenant UUIDs are ignored.
 */
export async function syncWorkspaceResourceLinks(
  q: Query,
  tenantId: string,
  sourceId: string,
  blocks: unknown,
) {
  const targets=[...linkedWorkspaceResources(blocks)]
    .filter((id)=>id!==sourceId);
  await q.query(
    "DELETE FROM resource_links WHERE tenant_id=$1 AND source_id=$2",
    [tenantId,sourceId],
  );
  if(!targets.length)return;
  await q.query(
    "INSERT INTO resource_links(tenant_id,source_id,target_id,source_updated_at)" +
    " SELECT $1,$2,target.id,source.updated_at FROM resources target" +
    " JOIN resources source ON source.tenant_id=$1 AND source.id=$2" +
    " WHERE target.tenant_id=$1 AND target.id=ANY($3::uuid[])" +
    " AND target.kind IN ('page','record')" +
    " ON CONFLICT DO NOTHING",
    [tenantId,sourceId,targets],
  );
}
