import type { Property } from "../contracts/index.ts";
import { assert } from "../contracts/index.ts";

/**
 * W06: deliberately small deterministic numeric formula language.
 * Grammar: [numeric_property_id], finite numeric literals, + - * /,
 * unary +/-, and parentheses. No JS execution, functions, SQL, HTTP,
 * relation traversal, formula-to-formula references or dynamic identifiers.
 */
type Eval = (row: Record<string, unknown>) => number | null;
const MAX_MAGNITUDE = 1e12;
const MAX_TOKENS = 64;
const MAX_DEPTH = 12;

function bounded(value: number | null): number | null {
  return value !== null && Number.isFinite(value) &&
    Math.abs(value) <= MAX_MAGNITUDE ? value : null;
}

export function compileFormula(expression: string, fields: Property[]): Eval {
  assert(typeof expression === "string" && expression.length > 0 &&
    expression.length <= 240, 400, "Formula must contain 1–240 characters");
  const tokens: string[] = [];
  const lexer = /\s*(\[[a-zA-Z][a-zA-Z0-9_-]{0,63}\]|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/-])\s*/gy;
  let offset = 0;
  while (offset < expression.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(expression);
    assert(match && match.index === offset, 400, "Invalid formula syntax");
    tokens.push(match![1]);
    assert(tokens.length <= MAX_TOKENS, 400, "Formula is too complex");
    offset = lexer.lastIndex;
  }
  assert(tokens.length > 0, 400, "Formula cannot be empty");
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const combine = (left: Eval, right: Eval, op: string): Eval => row => {
    const a = left(row), b = right(row);
    if (a === null || b === null || (op === "/" && b === 0))
      return null;
    return bounded(op === "+" ? a + b : op === "-" ? a - b :
      op === "*" ? a * b : a / b);
  };
  const expressionAt = (depth: number): Eval => {
    assert(depth <= MAX_DEPTH, 400, "Formula nesting is too deep");
    const factor = (): Eval => {
      const token = take();
      assert(token !== undefined, 400, "Incomplete formula");
      if (token === "+" || token === "-") {
        const operand = factor();
        return row => {
          const value = operand(row);
          return value === null ? null : bounded(token === "-" ? -value : value);
        };
      }
      if (token === "(") {
        const inner = expressionAt(depth + 1);
        assert(take() === ")", 400, "Formula parenthesis mismatch");
        return inner;
      }
      if (token.startsWith("[")) {
        const fieldId = token.slice(1, -1);
        const field = fields.find(p => p.id === fieldId);
        assert(field?.type === "number", 400,
          "Formula references must be existing numeric properties");
        return row => typeof row[fieldId] === "number" ?
          bounded(row[fieldId] as number) : null;
      }
      const value = Number(token);
      assert(/^(?:\d|\.)/.test(token) && Number.isFinite(value) &&
        Math.abs(value) <= MAX_MAGNITUDE, 400, "Invalid formula number");
      return () => value;
    };
    const product = (): Eval => {
      let left = factor();
      while (peek() === "*" || peek() === "/") {
        const op = take(), right = factor();
        left = combine(left, right, op);
      }
      return left;
    };
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const op = take(), right = product();
      left = combine(left, right, op);
    }
    return left;
  };
  const calculate = expressionAt(0);
  assert(position === tokens.length, 400, "Unexpected formula token");
  return calculate;
}

export function validateFormulaDefinitions(properties: Property[]) {
  for (const property of properties.filter(p => p.type === "formula"))
    compileFormula(property.formula!, properties);
}

export function computedFormulaValues(
  properties: Property[], stored: Record<string, any>,
) {
  const result = { ...stored };
  for (const property of properties.filter(p => p.type === "formula")) {
    // Always replace stale/untrusted persisted values with a fresh result.
    // Formula fields are virtual, are never accepted in record writes and
    // must never be treated as data available to other formulas.
    result[property.id] = compileFormula(property.formula!, properties)(stored);
  }
  return result;
}
