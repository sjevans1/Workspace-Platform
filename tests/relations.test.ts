import test from "node:test";
import assert from "node:assert/strict";
import { properties, validateValues } from "../packages/contracts/index.ts";
import { indexedRecordText } from "../apps/api/src/relations.ts";

const target = "123e4567-e89b-42d3-a456-426614174000";
const candidate = "123e4567-e89b-42d3-a456-426614174001";
const schema = [
  { id: "name", name: "Name", type: "title" },
  { id: "client", name: "Client", type: "relation",
    target_database_id: target },
] as const;

test("W05 relation property requires explicit target database only for relation", () => {
  assert.equal(properties.parse(schema).length, 2);
  assert.throws(() => properties.parse([
    { id: "name", name: "Name", type: "title" },
    { id: "client", name: "Client", type: "relation" },
  ]));
  assert.throws(() => properties.parse([
    { id: "name", name: "Name", type: "title" },
    { id: "note", name: "Note", type: "text",
      target_database_id: target },
  ]));
  assert.throws(() => properties.parse([
    { id: "name", name: "Name", type: "title" },
    { id: "client", name: "Client", type: "relation",
      target_database_id: "not-a-uuid" },
  ]));
});

test("W05 relation values are bounded, valid record IDs, nonduplicate", () => {
  const fields = properties.parse(schema);
  const valid = validateValues(fields, {
    name: "Project Falcon", client: [candidate],
  });
  assert.deepEqual(valid.client, [candidate]);
  assert.deepEqual(validateValues(fields, {
    name: "Project Falcon", client: [],
  }).client, []);
  assert.throws(() => validateValues(fields, {
    name: "Project Falcon", client: [candidate, candidate],
  }));
  assert.throws(() => validateValues(fields, {
    name: "Project Falcon", client: ["untrusted-identifier"],
  }));
  assert.throws(() => validateValues(fields, {
    name: "Project Falcon", client: Array(21).fill(candidate),
  }));
});

test("W05 search text cannot expose relation identifiers", () => {
  const fields = properties.parse(schema);
  const text = indexedRecordText(fields, {
    name: "Project Falcon", client: [candidate],
  });
  assert.equal(text, "Project Falcon");
  assert.ok(!text.includes(candidate));
});
