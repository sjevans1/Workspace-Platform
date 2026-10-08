import { test } from "node:test";
import assert from "node:assert/strict";
import type { Property } from "../packages/contracts/index.ts";
import {
  KEY_NORMALIZATION_VERSION,
  keyedImportDigest,
  modeWritesExisting,
  normalizeKeyValue,
  resolveKeyProperty,
  supportedKeyTypes,
} from "../packages/imports/keys.ts";

const text: Property = { id: "code", name: "Code", type: "text" };
const title: Property = { id: "name", name: "Name", type: "title" };
const number: Property = { id: "sku", name: "SKU", type: "number" };
const date: Property = { id: "day", name: "Day", type: "date" };
const select: Property = {
  id: "tier",
  name: "Tier",
  type: "select",
  options: ["Bronze", "Silver", "Gold"],
};

test("W09d keys normalize deterministically for the supported scalar types", () => {
  // Text and title keys ignore surrounding space and internal runs, are
  // compared in NFC, and keep their case.
  assert.equal(normalizeKeyValue(text, "  AC-1  "), "AC-1");
  assert.equal(normalizeKeyValue(text, "AC-1"), "AC-1");
  assert.equal(normalizeKeyValue(text, "AC  1\tB"), "AC 1 B");
  assert.equal(normalizeKeyValue(title, "Café"), normalizeKeyValue(text, "Cafe\u0301"));
  // Case is significant, so these are different keys rather than one.
  assert.notEqual(normalizeKeyValue(text, "AC-1"), normalizeKeyValue(text, "ac-1"));
  assert.notEqual(normalizeKeyValue(title, "Café"), normalizeKeyValue(title, "CAFÉ"));

  // Numbers canonicalize, including signed zero and exponent input.
  assert.equal(normalizeKeyValue(number, "1.0"), "1");
  assert.equal(normalizeKeyValue(number, "1"), "1");
  assert.equal(normalizeKeyValue(number, "1e3"), "1000");
  assert.equal(normalizeKeyValue(number, "1000"), "1000");
  assert.equal(normalizeKeyValue(number, "-0"), "0");
  assert.equal(normalizeKeyValue(number, " 42.50 "), "42.5");

  // Dates compare as calendar days only.
  assert.equal(normalizeKeyValue(date, "2026-10-08"), "2026-10-08");
  assert.equal(normalizeKeyValue(date, " 2026-10-08 "), "2026-10-08");

  // Select keys must be one of the declared options, compared exactly.
  assert.equal(normalizeKeyValue(select, "Gold"), "Gold");
  assert.throws(() => normalizeKeyValue(select, "gold"), /not one of the property options/);
  assert.throws(() => normalizeKeyValue(select, "Platinum"), /not one of the property options/);
});

test("W09d keys treat absent and blank values as missing, not as a match", () => {
  for (const value of [null, undefined, "", "   ", "\t\n"]) {
    assert.equal(normalizeKeyValue(text, value), null, `blank text key: ${JSON.stringify(value)}`);
    assert.equal(normalizeKeyValue(number, value), null, `blank number key: ${JSON.stringify(value)}`);
    assert.equal(normalizeKeyValue(date, value), null, `blank date key: ${JSON.stringify(value)}`);
    // null and undefined are interchangeable, so a sparse row cannot become a
    // key that matches another sparse row.
    assert.equal(normalizeKeyValue(text, null), normalizeKeyValue(text, undefined));
  }
});

test("W09d keys reject malformed values and non-finite numbers", () => {
  assert.throws(() => normalizeKeyValue(number, "twelve"), /not finite/);
  assert.throws(() => normalizeKeyValue(number, "Infinity"), /not finite/);
  assert.throws(() => normalizeKeyValue(date, "08/10/2026"), /must be YYYY-MM-DD/);
  assert.throws(() => normalizeKeyValue(date, "2026-02-30"), /must be YYYY-MM-DD/);
});

test("W09d only accepts key property types with settled comparison semantics", () => {
  assert.deepEqual([...supportedKeyTypes], ["title", "text", "number", "date", "select"]);

  const refused: Property[] = [
    { id: "rel", name: "Rel", type: "relation", target_database_id: "00000000-0000-0000-0000-000000000000" },
    { id: "f", name: "F", type: "formula", formula: "1" },
    { id: "r", name: "R", type: "rollup", rollup_relation_id: "rel", rollup_operation: "count" },
    { id: "ms", name: "MS", type: "multi_select", options: ["A", "B"] },
    { id: "cb", name: "CB", type: "checkbox" },
    { id: "st", name: "ST", type: "status", options: ["Open"] },
    { id: "u", name: "U", type: "url" },
    { id: "e", name: "E", type: "email" },
    { id: "p", name: "P", type: "person" },
  ];
  for (const property of refused) {
    assert.throws(
      () => resolveKeyProperty([property], property.id),
      /Import key must be one of title, text, number, date, select/,
      `refused key type: ${property.type}`,
    );
    assert.throws(() => normalizeKeyValue(property, "x"), /Import key must be one of/);
  }

  // A key that is not in the target schema is refused rather than guessed.
  assert.throws(() => resolveKeyProperty([text], "missing"), /not in the target schema/);

  // A select key without options cannot produce a total comparison rule.
  assert.throws(
    () => resolveKeyProperty([{ id: "s", name: "S", type: "select" }], "s"),
    /must define options/,
  );

  // Supported types resolve.
  for (const property of [title, text, number, date, select])
    assert.equal(resolveKeyProperty([property], property.id).id, property.id);
});

test("W09d keyed idempotency binds every input that could change the operation", () => {
  const base = {
    mode: "authorized-update" as const,
    key_property_id: "code",
    target_database_id: "11111111-1111-1111-1111-111111111111",
    schema_digest: "a".repeat(64),
    content_hash: "b".repeat(64),
    mapping: [{ source: "Code", id: "code", name: "Code", type: "text" }],
    decision_set: ["row:1:update:rev7", "row:2:insert"],
  };
  const digest = keyedImportDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(KEY_NORMALIZATION_VERSION, 2);

  // Changing any single bound input under the same idempotency key must be a
  // different operation.
  const mutations: Array<[string, any]> = [
    ["mode", { ...base, mode: "skip-existing" as const }],
    ["key property", { ...base, key_property_id: "other" }],
    ["target", { ...base, target_database_id: "22222222-2222-2222-2222-222222222222" }],
    ["schema digest", { ...base, schema_digest: "c".repeat(64) }],
    ["content hash", { ...base, content_hash: "d".repeat(64) }],
    ["mapping", { ...base, mapping: [{ source: "Code", id: "code", name: "Code", type: "title" }] }],
    ["decision set", { ...base, decision_set: ["row:1:update:rev8", "row:2:insert"] }],
  ];
  for (const [label, changed] of mutations)
    assert.notEqual(keyedImportDigest(changed), digest, `digest must change with ${label}`);

  // The decision set is a set, so ordering must not create a false conflict.
  assert.equal(
    keyedImportDigest({ ...base, decision_set: ["row:2:insert", "row:1:update:rev7"] }),
    digest,
  );

  // Only authorized-update may write to an existing row.
  assert.equal(modeWritesExisting("authorized-update"), true);
  for (const mode of ["append", "reject-on-existing", "skip-existing"] as const)
    assert.equal(modeWritesExisting(mode), false);
});
