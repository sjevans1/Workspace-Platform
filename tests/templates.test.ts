import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCatalog,
  TEMPLATE_CATEGORIES,
  type TemplateDefinition,
} from "../packages/templates/schema.ts";
import { catalog, templatesById, templateSummaries } from "../packages/templates/index.ts";

const base = (over: Partial<TemplateDefinition> = {}): TemplateDefinition => ({
  id: "sample",
  version: 1,
  level: "page",
  category: "Knowledge",
  title: "Sample",
  description: "A sample template.",
  icon: "✧",
  resource: { key: "root", kind: "page", title: "Sample", blocks: [] },
  ...over,
});

test("W25-T built-in catalog loads and validates", () => {
  assert.deepEqual(validateCatalog(catalog), []);
  assert.ok(catalog.length >= 20, `expected at least 20 templates, saw ${catalog.length}`);
  // Every required category is represented.
  const categories = new Set(catalog.map((definition) => definition.category));
  for (const category of TEMPLATE_CATEGORIES)
    assert.ok(categories.has(category), `category not represented: ${category}`);
  // All three levels are represented.
  const levels = new Set(catalog.map((definition) => definition.level));
  for (const level of ["page", "database", "space"] as const)
    assert.ok(levels.has(level), `level not represented: ${level}`);
  // Every definition resolves through the registry.
  for (const definition of catalog)
    assert.equal(templatesById[definition.id]?.id, definition.id);
});

test("W25-T catalog is deterministic and category-ordered", () => {
  const first = JSON.stringify(templateSummaries());
  const second = JSON.stringify(templateSummaries());
  assert.equal(first, second, "summaries must be deterministic");
  const summaries = templateSummaries();
  const order = summaries.map((s) => `${s.category}\u0000${s.title}`);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a.localeCompare(b)),
    "summaries must be category-ordered",
  );
  assert.equal(JSON.stringify(catalog), JSON.stringify(catalog));
});

test("W25-T rejects duplicate template ids", () => {
  const problems = validateCatalog([base(), base()]);
  assert.ok(problems.some((problem) => /duplicate template id/.test(problem)), problems.join("\n"));
});

test("W25-T rejects non-positive and non-integer versions", () => {
  for (const version of [0, -1, 1.5]) {
    const problems = validateCatalog([base({ version })]);
    assert.ok(
      problems.some((problem) => /version must be a positive integer/.test(problem)),
      `version ${version} was accepted`,
    );
  }
});

test("W25-T rejects unknown categories and mismatched level/kind", () => {
  const badCategory = validateCatalog([
    base({ category: "Nonsense" as any }),
  ]);
  assert.ok(badCategory.some((problem) => /unknown category/.test(problem)));
  const mismatched = validateCatalog([
    base({ level: "space", resource: { key: "root", kind: "page", title: "x" } }),
  ]);
  assert.ok(
    mismatched.some((problem) => /root resource kind must equal template level/.test(problem)),
  );
});

test("W25-T rejects raw internal ids in keys", () => {
  const uuid = "2f1c9a54-6f2e-4f2b-9a1d-8f0f4c2b7d31";
  const problems = validateCatalog([
    base({ resource: { key: "root", kind: "page", title: "x", children: [
      { key: uuid, kind: "page", title: "child" },
    ] } }),
  ]);
  assert.ok(
    problems.some((problem) => /raw internal id used as a resource key/.test(problem)),
    problems.join("\n"),
  );
  const propertyProblems = validateCatalog([
    base({
      level: "database",
      resource: {
        key: "root",
        kind: "database",
        title: "x",
        properties: [{ id: uuid, name: "Bad", type: "text" }],
      },
    }),
  ]);
  assert.ok(
    propertyProblems.some((problem) => /raw internal id used as a property id/.test(problem)),
  );
});

test("W25-T rejects duplicate local keys", () => {
  const duplicateProperty = validateCatalog([
    base({
      level: "database",
      resource: {
        key: "root",
        kind: "database",
        title: "x",
        properties: [
          { id: "name", name: "Name", type: "title" },
          { id: "name", name: "Again", type: "text" },
        ],
      },
    }),
  ]);
  assert.ok(duplicateProperty.some((problem) => /duplicate property id/.test(problem)));
  const duplicateRecord = validateCatalog([
    base({
      level: "database",
      resource: {
        key: "root",
        kind: "database",
        title: "x",
        properties: [{ id: "name", name: "Name", type: "title" }],
        records: [
          { key: "example", values: { name: "a" } },
          { key: "example", values: { name: "b" } },
        ],
      },
    }),
  ]);
  assert.ok(duplicateRecord.some((problem) => /duplicate record key/.test(problem)));
});

test("W25-T rejects unresolved symbolic references", () => {
  const relation = validateCatalog([
    base({
      level: "database",
      resource: {
        key: "root",
        kind: "database",
        title: "x",
        properties: [
          { id: "name", name: "Name", type: "title" },
          { id: "link", name: "Link", type: "relation", target: "resources.missing" },
        ],
      },
    }),
  ]);
  assert.ok(relation.some((problem) => /does not resolve/.test(problem)), relation.join("\n"));

  const record = validateCatalog([
    base({
      level: "database",
      resource: {
        key: "root",
        kind: "database",
        title: "x",
        properties: [{ id: "name", name: "Name", type: "title" }],
        records: [
          { key: "example", values: { name: "a" }, refs: { other: ["records.nope"] } },
        ],
      },
    }),
  ]);
  assert.ok(record.some((problem) => /references unknown record/.test(problem)), record.join("\n"));
});

test("W25-T rejects unsupported view types", () => {
  const problems = validateCatalog([
    base({
      level: "database",
      resource: {
        key: "root",
        kind: "database",
        title: "x",
        properties: [{ id: "name", name: "Name", type: "title" }],
        views: [{ name: "Bad", config: { type: "gantt" } }],
      },
    }),
  ]);
  assert.ok(problems.some((problem) => /unsupported type/.test(problem)));
});

test("W25-T rejects a malformed definition (missing title/description)", () => {
  const problems = validateCatalog([base({ title: "   ", description: "" })]);
  assert.ok(problems.some((problem) => /title and description are required/.test(problem)));
});
