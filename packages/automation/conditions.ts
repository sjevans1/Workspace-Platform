/**
 * W30-A: deterministic condition evaluation.
 *
 * A condition is a small, pure predicate over a bounded context. Nothing here
 * reads the clock, the database or the network, so the same context always
 * produces the same decision, and a missing path is handled explicitly rather
 * than by a thrown error: an unset field compares empty, everything else is
 * false. The context is sanitized first, so a workflow can never reach into
 * anything but the small, non-secret slice the engine hands it.
 */
import type {
  ConditionLeaf,
  ConditionOperator,
  WorkflowCondition,
} from "./dsl.ts";

export const CONDITION_OPERATORS: ConditionOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "not_empty",
  "boolean",
];

/** Keys that would let a crafted path mutate or probe the prototype chain. */
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type ConditionContext = Record<string, unknown>;

const MAX_DEPTH = 4;
const MAX_KEYS = 16;
const MAX_ARRAY = 32;
const MAX_STRING = 512;
const MAX_BYTES = 8192;

function sanitize(value: unknown, depth: number): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string") return (value as string).slice(0, MAX_STRING);
  if (kind === "number") return Number.isFinite(value as number) ? value : null;
  if (kind === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return [];
    return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
  }
  if (kind === "object") {
    if (depth >= MAX_DEPTH) return null;
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort().slice(0, MAX_KEYS)) {
      if (BLOCKED_KEYS.has(key)) continue;
      output[key] = sanitize(source[key], depth + 1);
    }
    return output;
  }
  return undefined;
}

/**
 * Bounds the context a condition may see: at most 16 top-level keys, at most 8192
 * serialized bytes, primitives and bounded nested structures only. Oversized
 * input is dropped deterministically (sorted key order) rather than truncated
 * mid-value, so the evaluation stays reproducible.
 */
export function boundedContext(
  input: Record<string, unknown>,
): ConditionContext {
  const source = input && typeof input === "object" ? input : {};
  const sanitized = (sanitize(source, 0) as Record<string, unknown>) || {};
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(sanitized).slice(0, MAX_KEYS).sort()) {
    if (sanitized[key] === undefined) continue;
    output[key] = sanitized[key];
  }
  while (
    Object.keys(output).length > 1 &&
    Buffer.byteLength(JSON.stringify(output)) > MAX_BYTES
  ) {
    const last = Object.keys(output).sort().pop()!;
    delete output[last];
  }
  return output;
}

/**
 * Reads a dot path out of the context. Bounded depth, never throws, and any
 * missing or non-traversable segment is simply undefined so a caller compares it
 * as "empty" rather than treating it as an error.
 */
export function readPath(path: string, context: ConditionContext): unknown {
  if (typeof path !== "string" || !path) return undefined;
  const segments = path.split(".");
  if (segments.length > 6) return undefined;
  let current: unknown = context;
  for (const segment of segments) {
    if (!segment || BLOCKED_KEYS.has(segment)) return undefined;
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment))
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asDateMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (
    !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?)?$/.test(
      value,
    )
  )
    return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function orderedCompare(
  operator: "gt" | "gte" | "lt" | "lte",
  left: unknown,
  right: unknown,
): boolean {
  let a: number | null = null;
  let b: number | null = null;
  if (typeof left === "number" && typeof right === "number") {
    a = left;
    b = right;
  } else {
    a = asDateMs(left);
    b = asDateMs(right);
  }
  if (a === null || b === null) return false;
  if (operator === "gt") return a > b;
  if (operator === "gte") return a >= b;
  if (operator === "lt") return a < b;
  return a <= b;
}

function evaluateLeaf(leaf: ConditionLeaf, context: ConditionContext): boolean {
  const actual = readPath(leaf.path, context);
  const expected = leaf.value;
  const missing = actual === undefined;

  switch (leaf.operator) {
    case "empty":
      return isEmpty(actual);
    case "not_empty":
      return !isEmpty(actual);
    case "boolean":
      return missing ? false : Boolean(actual) === expected;
    case "equals":
      return missing ? false : actual === expected;
    case "not_equals":
      return missing ? false : actual !== expected;
    case "contains":
      return missing ||
        typeof actual !== "string" ||
        typeof expected !== "string"
        ? false
        : actual.includes(expected);
    case "starts_with":
      return missing ||
        typeof actual !== "string" ||
        typeof expected !== "string"
        ? false
        : actual.startsWith(expected);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return missing ? false : orderedCompare(leaf.operator, actual, expected);
    default:
      return false;
  }
}

export function evaluateCondition(
  condition: WorkflowCondition,
  context: ConditionContext,
): boolean {
  if (condition.kind === "leaf") return evaluateLeaf(condition, context);
  if (!condition.conditions.length) return true;
  if (condition.kind === "all")
    return condition.conditions.every((child) =>
      evaluateCondition(child, context),
    );
  return condition.conditions.some((child) =>
    evaluateCondition(child, context),
  );
}

/**
 * Evaluates a workflow's condition gate. The gate passes only when every
 * top-level condition passes; the per-node detail is returned so a run can show
 * exactly which condition stopped it, and the reason text is bounded so it can be
 * stored without leaking context.
 */
export function evaluateConditions(
  conditions: WorkflowCondition[],
  context: ConditionContext,
): {
  passed: boolean;
  evaluated: { id: string; passed: boolean; reason: string }[];
} {
  const evaluated = conditions.map((condition) => {
    const passed = evaluateCondition(condition, context);
    const kind = condition.kind === "leaf" ? "leaf" : condition.kind;
    return {
      id: condition.id,
      passed,
      reason: passed
        ? `${kind} condition satisfied`
        : `${kind} condition not satisfied`,
    };
  });
  return { passed: evaluated.every((entry) => entry.passed), evaluated };
}
