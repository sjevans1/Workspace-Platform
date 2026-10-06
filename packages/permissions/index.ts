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
 * W13: evaluate full hierarchy read access for a bounded set of arbitrary
 * resources in one recursive SQL operation. This is equivalent to evaluate()
 * for read/no-read decisions, including personal-over-wildcard precedence,
 * inherit=false resets, guest root grants, ancestor deny absorption, deleted
 * ancestors, and live membership verification.
 *
 * Callers must still enforce their own result/canonical-content contract.
 */
export async function batchReadableResourceIds(
  q: Query,
  a: Pick<Actor, "tenant_id" | "user_id" | "role">,
  ids: string[],
) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set<string>();
  const rows = (await q.query(
    `WITH RECURSIVE chain AS (
       SELECT input.id source_id,r.id,r.parent_id,r.deleted_at,
         r.inherit_permissions,ARRAY[r.id] path,0 depth
       FROM unnest($1::uuid[]) input(id)
       JOIN resources r ON r.id=input.id
       UNION ALL
       SELECT c.source_id,r.id,r.parent_id,r.deleted_at,
         r.inherit_permissions,c.path||r.id,c.depth+1
       FROM chain c
       JOIN resources r ON c.parent_id=r.id
       WHERE c.depth<64 AND NOT r.id=ANY(c.path)
     ), acl_state AS (
       SELECT c.*,
         personal.principal_id IS NOT NULL has_personal,
         personal.level personal_level,
         wildcard.principal_id IS NOT NULL has_wildcard,
         wildcard.level wildcard_level,
         max(c.depth) OVER(PARTITION BY c.source_id) root_depth
       FROM chain c
       LEFT JOIN acl personal
         ON personal.tenant_id=$4::uuid
        AND personal.resource_id=c.id
        AND personal.principal_id=$2::text
       LEFT JOIN acl wildcard
         ON wildcard.tenant_id=$4::uuid
        AND wildcard.resource_id=c.id
        AND wildcard.principal_id='*'
     )
     SELECT source_id
     FROM acl_state
     GROUP BY source_id
     HAVING bool_and(deleted_at IS NULL)
       AND EXISTS (
         SELECT 1 FROM memberships m
         WHERE m.tenant_id=$4::uuid AND m.user_id=$2::uuid
           AND m.role=$3::text AND m.active
       )
       AND CASE
         WHEN $3::text IN ('owner','admin') THEN true
         WHEN $3::text='member' THEN bool_and(
           CASE
             WHEN has_personal THEN personal_level>0
             WHEN has_wildcard THEN wildcard_level>0
             ELSE inherit_permissions
           END
         )
         WHEN $3::text='guest' THEN bool_and(
           CASE
             WHEN depth=root_depth THEN
               CASE
                 WHEN has_personal THEN personal_level>0
                 WHEN has_wildcard THEN wildcard_level>0
                 ELSE false
               END
             WHEN has_personal THEN personal_level>0
             WHEN has_wildcard THEN wildcard_level>0
             ELSE inherit_permissions
           END
         )
         ELSE false
       END`,
    [unique, a.user_id, a.role, a.tenant_id],
  )).rows;
  return new Set<string>(rows.map((row: any) => row.source_id));
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
