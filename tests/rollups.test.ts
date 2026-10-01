import test from "node:test";
import assert from "node:assert/strict";
import { properties, validateValues } from "../packages/contracts/index.ts";
import { calculateRollup } from "../apps/api/src/rollups.ts";

test("W07 visible-only rollup arithmetic returns bounded, deterministic values", () => {
  assert.equal(calculateRollup("count", 2, []), 2);
  assert.equal(calculateRollup("sum", 2, [15, 25]), 40);
  assert.equal(calculateRollup("avg", 2, [15, 25]), 20);
  assert.equal(calculateRollup("min", 2, [15, 25]), 15);
  assert.equal(calculateRollup("max", 2, [15, 25]), 25);
  assert.equal(calculateRollup("sum", 0, []), 0);
  assert.equal(calculateRollup("count", 0, []), 0);
  assert.equal(calculateRollup("avg", 0, []), null);
  assert.equal(calculateRollup("min", 0, []), null);
  assert.equal(calculateRollup("max", 0, []), null);
  assert.equal(calculateRollup("sum", 2, [1e12, 1e12]), null);
  assert.equal(calculateRollup("sum", 1, [Infinity]), null);
  assert.throws(() => calculateRollup("count", 21, []));
  assert.throws(() => calculateRollup("sum", 1, [1, 2]));
});

test("W07 Rollup schema is strictly readonly and operation-specific", () => {
  const base = [
    { id: "name", name: "Name", type: "title" },
    { id: "clients", name: "Clients", type: "relation",
      target_database_id: "123e4567-e89b-42d3-a456-426614174000" },
    { id: "size", name: "Linked count", type: "rollup",
      rollup_relation_id: "clients", rollup_operation: "count" },
    { id: "total", name: "Related revenue", type: "rollup",
      rollup_relation_id: "clients", rollup_operation: "sum",
      rollup_value_property_id: "revenue" },
  ];
  const valid = properties.parse(base);
  assert.equal(valid.length, 4);
  assert.deepEqual(validateValues(valid, { name: "Project" }),
    { name: "Project" });
  assert.throws(() => validateValues(valid,
    { name: "Project", size: 999 }));
  assert.throws(() => properties.parse(base.map((x) =>
    x.id === "total" ? { ...x, rollup_value_property_id: undefined } : x)));
  assert.throws(() => properties.parse(base.map((x) =>
    x.id === "size" ? { ...x, rollup_value_property_id: "revenue" } : x)));
  assert.throws(() => properties.parse(base.map((x) =>
    x.id === "size" ? { ...x, type: "text" } : x)));
});
