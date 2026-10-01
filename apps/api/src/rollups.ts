import type { Query } from "../../../packages/database/index.ts";
import { one } from "../../../packages/database/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import type { Property } from "../../../packages/contracts/index.ts";
import { assert } from "../../../packages/contracts/index.ts";
import { access, requireAccess } from "../../../packages/permissions/index.ts";

export type RollupOperation = "count" | "sum" | "avg" | "min" | "max";

// Limit matches the W05 Relation 20-ID cap; no bulk unrestricted JOINs or
// user-defined SQL are permitted.
const MAGNITUDE_LIMIT = 1e12;
export function calculateRollup(
  operation: RollupOperation,
  visibleCount: number,
  numericValues: number[],
): number | null {
  assert(Number.isInteger(visibleCount) && visibleCount >= 0 &&
    visibleCount <= 20 && numericValues.length <= visibleCount, 400,
    "Invalid aggregate inputs");
  if (operation === "count") return visibleCount;
  const nums = numericValues.filter((n) => Number.isFinite(n) &&
    Math.abs(n) <= MAGNITUDE_LIMIT);
  if (nums.length !== numericValues.length) return null;
  if (operation === "sum" && !nums.length) return 0;
  if (!nums.length) return null;
  const result = operation === "sum" || operation === "avg"
    ? nums.reduce((total, n) => total + n, 0) /
      (operation === "avg" ? nums.length : 1)
    : operation === "min" ? Math.min(...nums) :
      operation === "max" ? Math.max(...nums) : NaN;
  return Number.isFinite(result) && Math.abs(result) <= MAGNITUDE_LIMIT
    ? result : null;
}

export async function validateRollupDefinitions(
  q: Query, actor: Actor, props: Property[],
) {
  for (const property of props.filter((p) => p.type === "rollup")) {
    const relation = props.find((p) =>
      p.id === property.rollup_relation_id && p.type === "relation");
    assert(relation?.target_database_id, 400,
      "Rollup requires an existing Relation property");
    const target = await requireAccess(q, actor, relation!.target_database_id!);
    assert(target.kind === "database" && !target.deleted_at, 404,
      "Rollup target database unavailable");
    if (property.rollup_operation === "count") continue;
    const definition = await one(q,
      "SELECT properties FROM databases WHERE resource_id=$1",
      [relation!.target_database_id]);
    assert(definition?.properties?.some((p: Property) =>
      p.id === property.rollup_value_property_id && p.type === "number"), 400,
    "Rollup numeric target property unavailable");
  }
}

export async function redactRollupSchema(
  q: Query, actor: Actor, props: Property[],
) {
  const visible = [];
  for (const property of props) {
    if (property.type !== "rollup") {
      visible.push(property);
      continue;
    }
    const relation = props.find((p) =>
      p.id === property.rollup_relation_id && p.type === "relation");
    if (relation?.target_database_id &&
      await access(q, actor, relation.target_database_id)) {
      visible.push(property);
      continue;
    }
    // Numeric-field IDs in a revoked target are sensitive metadata, not
    // necessarily discoverable to the user who can see the source database.
    const { rollup_value_property_id: _hidden, ...safe } = property;
    visible.push({ ...safe, target_unavailable: true });
  }
  return visible;
}

export async function computeRollupValues(
  q: Query, actor: Actor, properties: Property[],
  sourceValues: Record<string, any>,
) {
  // sourceValues MUST be passed through redactRelationValues for this actor
  // BEFORE reaching this function. Still recheck each related record's ACL,
  // parent database and active status here (no global caches).
  const calculated = { ...sourceValues };
  for (const property of properties.filter((p) => p.type === "rollup")) {
    const relation = properties.find((p) =>
      p.id === property.rollup_relation_id && p.type === "relation");
    const targetDatabaseId = relation?.target_database_id;
    const ids = Array.isArray(sourceValues[property.rollup_relation_id!])
      ? (sourceValues[property.rollup_relation_id!] as string[]).slice(0, 20)
      : [];
    if (!targetDatabaseId || !await access(q, actor, targetDatabaseId)) {
      calculated[property.id] = property.rollup_operation === "count" ||
        property.rollup_operation === "sum" ? 0 : null;
      continue;
    }
    const targetRows = ids.length ? (await q.query(
      "SELECT r.id,v.values FROM resources r JOIN database_records v" +
      " ON v.resource_id=r.id AND v.database_id=$2" +
      " WHERE r.id=ANY($1::uuid[]) AND r.tenant_id=$3" +
      " AND r.parent_id=$2 AND r.kind='record' AND r.deleted_at IS NULL",
      [ids, targetDatabaseId, actor.tenant_id],
    )).rows : [];
    const accessible = [];
    for (const row of targetRows)
      if (await access(q, actor, row.id)) accessible.push(row);
    const numeric = accessible.map((row) =>
      row.values[property.rollup_value_property_id!])
      .filter((n) => n !== null && n !== undefined && typeof n === "number");
    calculated[property.id] = calculateRollup(
      property.rollup_operation!, accessible.length, numeric);
  }
  return calculated;
}
