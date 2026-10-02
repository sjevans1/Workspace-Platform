import type { Query } from "../database/index.ts";
import type { Actor } from "../auth/index.ts";
import { HttpError } from "../contracts/index.ts";
export function evaluate(
  a: Pick<Actor, "role" | "user_id">,
  path: any[],
  deleted = false,
) {
  if (!path.length || (!deleted && path.some((p) => p.deleted_at))) return 0;
  if (["owner", "admin"].includes(a.role)) return 4;
  let level = a.role === "guest" ? 0 : 3;
  for (const p of path) {
    if (!p.inherit_permissions) level = 0;
    const g =
      p.acl.find((g: any) => g.principal_id === a.user_id) ??
      p.acl.find((g: any) => g.principal_id === "*");
    if (g) level = g.level;
    if (!level) return 0;
  }
  return level;
}
export async function ancestry(q: Query, id: string) {
  return (
    await q.query(
      `WITH RECURSIVE chain AS(SELECT r.*,0 depth,ARRAY[r.id] path FROM resources r WHERE id=$1 UNION ALL SELECT r.*,c.depth+1,c.path||r.id FROM resources r JOIN chain c ON c.parent_id=r.id WHERE NOT r.id=ANY(c.path) AND c.depth<64) SELECT c.*,coalesce((SELECT jsonb_agg(jsonb_build_object('principal_id',a.principal_id,'level',a.level)) FROM acl a WHERE a.resource_id=c.id),'[]') acl FROM chain c ORDER BY depth DESC`,
      [id],
    )
  ).rows;
}
export async function access(q: Query, a: Actor, id: string, deleted = false) {
  return evaluate(a, await ancestry(q, id), deleted);
}
export async function requireAccess(
  q: Query,
  a: Actor,
  id: string,
  level = 1,
  deleted = false,
) {
  const path = await ancestry(q, id),
    effective = evaluate(a, path, deleted);
  if (effective < level)
    throw new HttpError(
      effective ? 403 : 404,
      effective ? "Insufficient permission" : "Resource not found",
    );
  return { ...path.at(-1), effective_permission: effective };
}
export async function visible(
  q: Query,
  a: Actor,
  rows: any[],
  deleted = false,
) {
  const out = [];
  for (const r of rows) {
    const level = await access(q, a, r.resource_id || r.id, deleted);
    if (level) out.push({ ...r, effective_permission: level });
  }
  return out;
}

/**
 * W08: a caller who has already passed requireAccess() on a known parent
 * can filter its DIRECT children with two indexed ACL probes per resource.
 * This reproduces evaluate()'s final child step, avoiding 10k individual
 * recursive ancestry / membership checks in listing and relation pickers.
 *
 * SQL RLS remains enforced; the parent level and role MUST come from the
 * authenticated server actor/requireAccess(), never request parameters.
 * Use on direct-child queries only (r.parent_id = accepted parent.id),
 * with the normal JS visible() recheck after LIMIT as defense in depth.
 */
export function directChildCanReadSql(
  resourceAlias: "r",
  role: Actor["role"],
  tenantParam: number,
  userParam: number,
  parentPermissionParam: number,
) {
  // All callers bind tenant, principal and inherited permission slots.
  // Even privileged roles must reference all three placeholders; returning
  // bare TRUE would leave untyped gaps in PostgreSQL's prepared parameters.
  const verifiedParent =
    "(" + resourceAlias + ".tenant_id=$" + tenantParam +
    "::uuid AND $" + userParam + "::uuid IS NOT NULL AND $" +
    parentPermissionParam + "::integer>0)";
  if (role === "owner" || role === "admin") return verifiedParent;
  if (role !== "member" && role !== "guest")
    return "(" + verifiedParent + " AND FALSE)";
  const r = resourceAlias;
  const tenant = "$" + tenantParam;
  const actor = "$" + userParam + "::text";
  const base = "$" + parentPermissionParam + "::integer";
  const grant = (principal: string) =>
    "(SELECT a.level FROM acl a WHERE a.tenant_id=" + tenant +
    "::uuid AND a.resource_id=" + r + ".id AND a.principal_id=" +
    principal + ")";
  return "(COALESCE(" + grant(actor) + "," + grant("'*'") +
    ",CASE WHEN " + r + ".inherit_permissions THEN " + base +
    " ELSE 0 END)>0)";
}

/**
 * A batched, independent application-side ACL recheck for already SQL-filtered
 * direct records. This avoids 10k sequential ancestry queries during exports.
 *
 * Reverify live parent ancestry once, then fetch current child metadata and
 * personal/wildcard grants under tenant RLS. This is not a global permission
 * cache: any changed/missing/trashed/moved record is excluded fail-closed.
 */
export async function visibleDirectRecordChildren(
  q: Query, a: Actor, parentId: string, rows: any[],
) {
  if (!rows.length) return [];
  const parent = await requireAccess(q, a, parentId);
  const ids = rows.map((r) => r.resource_id || r.id);
  const meta = (await q.query(
    "SELECT id,inherit_permissions FROM resources" +
    " WHERE id=ANY($1::uuid[]) AND parent_id=$2 AND kind='record'" +
    " AND deleted_at IS NULL AND tenant_id=$3",
    [ids, parentId, a.tenant_id],
  )).rows;
  const current = new Map<string, any>(meta.map((r) => [r.id, r]));
  const grants = new Map<string, { personal?: number; wildcard?: number }>();
  if (a.role !== "owner" && a.role !== "admin") {
    const items = (await q.query(
      "SELECT resource_id,principal_id,level FROM acl" +
      " WHERE resource_id=ANY($1::uuid[])" +
      " AND tenant_id=$2 AND principal_id=ANY($3::text[])",
      [meta.map((r) => r.id), a.tenant_id, [a.user_id, "*"]],
    )).rows;
    for (const item of items) {
      const grant = grants.get(item.resource_id) || {};
      if (item.principal_id === a.user_id) grant.personal = item.level;
      else if (item.principal_id === "*") grant.wildcard = item.level;
      grants.set(item.resource_id, grant);
    }
  }
  const visibleRows = [];
  for (const row of rows) {
    const id = row.resource_id || row.id;
    const state = current.get(id);
    if (!state) continue;
    const permission = a.role === "owner" || a.role === "admin" ? 4 :
      grants.get(id)?.personal ?? grants.get(id)?.wildcard ??
      (state.inherit_permissions ? parent.effective_permission : 0);
    if (permission > 0)
      visibleRows.push({ ...row, effective_permission: permission });
  }
  return visibleRows;
}
