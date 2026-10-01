import test from "node:test";
import assert from "node:assert/strict";
import { properties, validateValues } from "../packages/contracts/index.ts";
import { compileFormula, computedFormulaValues,
  validateFormulaDefinitions } from "../packages/formulas/index.ts";

const props = properties.parse([
  { id: "name", name: "Name", type: "title" },
  { id: "unit_cost", name: "Unit cost", type: "number" },
  { id: "quantity", name: "Quantity", type: "number" },
  { id: "gross", name: "Gross amount", type: "formula",
    formula: "[unit_cost] * [quantity] + 2.5" },
]);
test("W06 number formulas evaluate deterministically, with correct precedence", () => {
  validateFormulaDefinitions(props);
  const stored = validateValues(props,
    { name: "Supply", unit_cost: 12.5, quantity: 4 });
  const result = computedFormulaValues(props, stored);
  assert.equal(result.gross, 52.5);
  assert.equal(compileFormula("-(2+3)*[quantity]", props)(stored), -20);
  assert.equal(compileFormula("8/2/2", props)(stored), 2);
  assert.equal(compileFormula("[quantity]+0.3", props)({ quantity: 2 }), 2.3);
});
test("W06 missing numeric inputs, unsafe division or overflow yield null", () => {
  assert.equal(computedFormulaValues(props,
    { name: "Incomplete", unit_cost: 5 }).gross, null);
  assert.equal(compileFormula("[unit_cost]/[quantity]",props)
    ({ unit_cost: 100, quantity: 0 }), null);
  assert.equal(compileFormula("999999999999*99", props)({}), null);
});
test("W06 rejects arbitrary expressions, unexpected fields and cycles", () => {
  for (const expression of [
    "eval(1)", "process.env.API_KEY", "[name]", "[gross]",
    "[__proto__]", "1;2", "1/0**2", "4+", "2 3",
    "(".repeat(14) + "1" + ")".repeat(14),
  ]) assert.throws(() => compileFormula(expression, props), undefined,
    expression);
  assert.throws(() => validateValues(props,
    { name: "No formula writes", gross: 25 }));
  const invalid = properties.parse([
    { id: "name", type: "title", name: "Name" },
    { id: "a", name: "Formula", type: "formula", formula: "[missing]+1" },
  ]);
  assert.throws(() => validateFormulaDefinitions(invalid));
});
