import type { Query } from "../../../packages/database/index.ts";
import { one } from "../../../packages/database/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import type { Property } from "../../../packages/contracts/index.ts";
import { assert } from "../../../packages/contracts/index.ts";
import { access, requireAccess } from "../../../packages/permissions/index.ts";

// Relations are a one-way, bounded reference to records in a different
// database in the same tenant. This module never issues a global/unscoped
// query: callers must use db.tenant() with the restricted runtime role.

export const relationFields = (props: Property[]) =>
  props.filter((p) => p.type === "relation");

export function indexedRecordText(props: Property[], values: Record<string, unknown>) {
  // Raw related-record identifiers are not search keywords and must not enter
  // resources.search_text or excerpts shown to a less-privileged searcher.
  return props.filter((p) => p.type !== "relation")
    .map((p) => values[p.id]).filter((value) => value != null)
    .map((value) => Array.isArray(value) ? value.join(" ") : String(value))
    .join(" ");
}

export async function validateRelationSchema(
  q: Query, actor: Actor, sourceDatabaseId: string, props: Property[],
) {
  for (const field of relationFields(props)) {
    const targetId = field.target_database_id!;
    assert(targetId !== sourceDatabaseId, 400,
      "Relation target must be another database");
    const target = await requireAccess(q, actor, targetId);
    assert(target.kind === "database" && !target.deleted_at, 404,
      "Relation target database not found");
  }
}

async function permittedTarget(
  q: Query, actor: Actor, targetDatabaseId: string, recordId: string,
) {
  const row = await one(q,
    "SELECT r.id,r.title FROM resources r JOIN database_records v" +
      " ON v.resource_id=r.id AND v.database_id=$2" +
      " WHERE r.id=$1 AND r.parent_id=$2 AND r.kind='record'" +
      " AND r.deleted_at IS NULL AND r.tenant_id=$3",
    [recordId, targetDatabaseId, actor.tenant_id]);
  if (!row || !(await access(q, actor, row.id))) return null;
  return row;
}

export async function validateRelationWrites(
  q: Query, actor: Actor, props: Property[],
  submittedValues: Record<string, unknown>,
) {
  for (const field of relationFields(props)) {
    if (!Object.prototype.hasOwnProperty.call(submittedValues, field.id))
      continue;
    const value = submittedValues[field.id];
    if (value === null) continue;
    assert(Array.isArray(value) && value.length <= 20, 400,
      "Relation must contain at most 20 records");
    const target = await requireAccess(q, actor, field.target_database_id!);
    assert(target.kind === "database", 404, "Relation target not found");
    for (const recordId of value)
      assert(typeof recordId === "string" &&
        (await permittedTarget(q, actor, field.target_database_id!, recordId)),
        404, "Related record unavailable");
  }
}

export async function redactRelationValues(
  q: Query, actor: Actor, props: Property[], sourceValues: Record<string, any>,
) {
  const safe = { ...sourceValues };
  for (const field of relationFields(props)) {
    const ids = Array.isArray(sourceValues[field.id])
      ? sourceValues[field.id] as string[] : [];
    if (!field.target_database_id ||
      !(await access(q, actor, field.target_database_id))) {
      safe[field.id] = [];
      continue;
    }
    const kept: string[] = [];
    for (const recordId of ids.slice(0, 20)) {
      if (typeof recordId !== "string") continue;
      if (await permittedTarget(q, actor, field.target_database_id, recordId))
        kept.push(recordId);
    }
    safe[field.id] = kept;
  }
  return safe;
}

export async function redactRelationSchema(
  q: Query, actor: Actor, props: Property[],
) {
  const safe = [];
  for (const field of props) {
    if (field.type === "relation" &&
      (!field.target_database_id ||
        !(await access(q, actor, field.target_database_id)))) {
      const { target_database_id: _hidden, ...rest } = field;
      safe.push({ ...rest, target_unavailable: true });
    } else safe.push(field);
  }
  return safe;
}
