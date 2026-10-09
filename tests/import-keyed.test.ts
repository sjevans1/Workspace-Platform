import { test } from "node:test";
import assert from "node:assert/strict";
import type { Property } from "../packages/contracts/index.ts";
import { keyedImportDigest } from "../packages/imports/keys.ts";
import {
  keyedDecisionSet,
  planKeyedImport,
  type VisibleRecord,
} from "../packages/imports/keyed.ts";

const title: Property = { id: "name", name: "Name", type: "title" };
const code: Property = { id: "code", name: "Code", type: "text" };
const qty: Property = { id: "qty", name: "Qty", type: "number" };
const day: Property = { id: "day", name: "Day", type: "date" };
const properties = [title, code, qty, day];

function record(values: Record<string, unknown>, revision = 1): VisibleRecord {
  return { resource_id: "r-" + JSON.stringify(values), revision, values };
}

function countActions(plan: ReturnType<typeof planKeyedImport>) {
  return plan.rows.map((row) => row.action);
}

test("W09d append stays key-blind and unchanged", () => {
  const plan = planKeyedImport({
    mode: "append",
    rows: [{ code: "a" }, { code: "a" }, { code: "" }],
    targetProperties: properties,
    visible: [record({ code: "a" }, 4)],
  });
  assert.deepEqual(countActions(plan), ["insert", "insert", "insert"]);
  assert.equal(plan.key_property_id, null);
  assert.equal(plan.counts.insert, 3);
  assert.equal(plan.counts.conflict_restricted, 0);
  // Append never probes existing rows, so a key property makes no sense here.
  assert.throws(
    () =>
      planKeyedImport({
        mode: "append",
        rows: [{ code: "a" }],
        targetProperties: properties,
        visible: [],
        keyPropertyId: "code",
      }),
    /Append mode does not take a key property/,
  );
});

test("W09d authorized-update inserts unknown keys and updates a single visible match", () => {
  const plan = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "known" }, { code: "fresh" }],
    targetProperties: properties,
    visible: [record({ code: "known" }, 7)],
  });
  assert.equal(plan.rows[0].action, "update");
  assert.deepEqual(plan.rows[0], {
    index: 0,
    action: "update",
    key: "known",
    resource_id: "r-" + JSON.stringify({ code: "known" }),
    expected_revision: 7,
  });
  assert.equal(plan.rows[1].action, "insert");
  assert.deepEqual(plan.counts, {
    insert: 1,
    update: 1,
    skip: 0,
    conflict: 0,
    conflict_restricted: 0,
  });
});

test("W09d duplicate stored keys are ambiguous and never silently chosen", () => {
  const duplicated = [record({ code: "dup" }, 1), record({ code: "dup" }, 2)];
  // authorized-update must refuse rather than pick one row.
  const update = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "dup" }],
    targetProperties: properties,
    visible: duplicated,
  });
  assert.deepEqual(update.rows[0], {
    index: 0,
    action: "conflict",
    key: "dup",
    reason: "ambiguous_match",
  });
  // reject-on-existing also refuses.
  const reject = planKeyedImport({
    mode: "reject-on-existing",
    keyPropertyId: "code",
    rows: [{ code: "dup" }],
    targetProperties: properties,
    visible: duplicated,
  });
  assert.equal(reject.rows[0].action, "conflict");
});

test("W09d reject-on-existing and skip-existing classify existing and new keys", () => {
  const visible = [record({ code: "seen" }, 3)];
  const rows = [{ code: "seen" }, { code: "new" }];
  const reject = planKeyedImport({
    mode: "reject-on-existing",
    keyPropertyId: "code",
    rows,
    targetProperties: properties,
    visible,
  });
  assert.deepEqual(countActions(reject), ["conflict", "insert"]);
  assert.deepEqual(reject.rows[0], {
    index: 0,
    action: "conflict",
    key: "seen",
    reason: "existing_record",
  });
  const skip = planKeyedImport({
    mode: "skip-existing",
    keyPropertyId: "code",
    rows,
    targetProperties: properties,
    visible,
  });
  assert.deepEqual(countActions(skip), ["skip", "insert"]);
  assert.deepEqual(skip.rows[0], {
    index: 0,
    action: "skip",
    key: "seen",
    reason: "existing_record",
  });
});

test("W09d missing and malformed keys conflict instead of matching", () => {
  const plan = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "qty",
    rows: [{ qty: "" }, { qty: "twelve" }, { qty: null }, { qty: "5" }],
    targetProperties: properties,
    visible: [],
  });
  assert.deepEqual(countActions(plan), ["conflict", "conflict", "conflict", "insert"]);
  assert.equal((plan.rows[0] as any).reason, "missing_key");
  assert.equal((plan.rows[1] as any).reason, "malformed_key");
  assert.equal((plan.rows[2] as any).reason, "missing_key");
  // A malformed key never exposes the offending value.
  assert.equal((plan.rows[1] as any).key, null);
});

test("W09d duplicate keys inside the source conflict for every occurrence", () => {
  const plan = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "x" }, { code: "x" }, { code: "y" }],
    targetProperties: properties,
    visible: [],
  });
  // Two identical keys in one file cannot identify one record.
  assert.deepEqual(countActions(plan), ["conflict", "conflict", "insert"]);
  assert.equal((plan.rows[0] as any).reason, "duplicate_key_in_source");
  assert.equal((plan.rows[1] as any).reason, "duplicate_key_in_source");

  // Case and whitespace are both significant, so these are separate rows and
  // each is allowed to proceed on its own.
  const cased = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "x" }, { code: "X" }, { code: "x " }],
    targetProperties: properties,
    visible: [],
  });
  assert.deepEqual(countActions(cased), ["insert", "insert", "insert"]);
});

test("W09d a collision the caller cannot see is generic and non-enumerating", () => {
  const plan = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "hidden" }, { code: "visible" }],
    targetProperties: properties,
    visible: [record({ code: "visible" }, 1)],
    restrictedKeys: ["hidden"],
  });
  assert.deepEqual(countActions(plan), ["conflict_restricted", "update"]);
  // Nothing about the hidden record is revealed: no key, id, revision or reason.
  assert.deepEqual(plan.rows[0], { index: 0, action: "conflict_restricted", key: null });
  assert.equal(plan.counts.conflict_restricted, 1);
  // The decision set is stable and carries no hidden identifier either.
  const decisions = keyedDecisionSet(plan);
  assert.deepEqual(decisions[0], "row:0:conflict");
  assert.doesNotMatch(JSON.stringify(plan.rows[0]), /hidden/);
});

test("W09d stored keys normalize by the same contract as source keys", () => {
  // Only an exact NFC match updates a record.
  const plan = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "AC-1" }, { code: "2.50" }, { code: "2026-10-08" }],
    targetProperties: properties,
    visible: [
      record({ code: "AC-1" }, 2),
      record({ code: "2.5" }, 3),
      record({ code: "2026-10-08" }, 4),
    ],
  });
  // code is text, so "2.50" is not the same key as the stored "2.5" and must
  // insert rather than update a record the operator did not name.
  assert.deepEqual(countActions(plan), ["update", "insert", "update"]);
  assert.equal((plan.rows[0] as any).expected_revision, 2);
  assert.equal((plan.rows[2] as any).expected_revision, 4);

  // A stored key that differs by case or by surrounding whitespace is a
  // different key, so the row is inserted.
  const cased = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "code",
    rows: [{ code: "ac-1" }, { code: " AC-1" }],
    targetProperties: properties,
    visible: [record({ code: "AC-1" }, 2)],
  });
  assert.deepEqual(countActions(cased), ["insert", "insert"]);

  // With number and date key properties the canonicalization still applies.
  const numeric = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "qty",
    rows: [{ qty: "2.50" }],
    targetProperties: properties,
    visible: [record({ qty: 2.5 }, 9)],
  });
  assert.equal((numeric.rows[0] as any).expected_revision, 9);
  const dated = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "day",
    rows: [{ day: "2026-10-08" }],
    targetProperties: properties,
    visible: [record({ day: "2026-10-08" }, 11)],
  });
  assert.equal((dated.rows[0] as any).expected_revision, 11);

  // A stored value that cannot be normalized is not matched loosely.
  const dirty = planKeyedImport({
    mode: "authorized-update",
    keyPropertyId: "qty",
    rows: [{ qty: "5" }],
    targetProperties: properties,
    visible: [record({ qty: "not a number" }, 1)],
  });
  assert.equal(dirty.rows[0].action, "insert");
});

test("W09d a keyed operation is bound to its decisions for idempotent replay", () => {
  const input = {
    mode: "authorized-update" as const,
    keyPropertyId: "code",
    rows: [{ code: "known" }],
    targetProperties: properties,
    visible: [record({ code: "known" }, 5)],
  };
  const plan = planKeyedImport(input);
  const binding = {
    mode: plan.mode,
    key_property_id: plan.key_property_id!,
    target_database_id: "11111111-1111-1111-1111-111111111111",
    schema_digest: "a".repeat(64),
    content_hash: "b".repeat(64),
    mapping: [{ source: "Code", id: "code", name: "Code", type: "text" }],
    decision_set: keyedDecisionSet(plan),
  };
  const digest = keyedImportDigest(binding);
  assert.equal(digest, keyedImportDigest(binding));

  // A record that moved revision after preview produces a different decision
  // set, so the same idempotency key cannot silently apply stale decisions.
  const moved = planKeyedImport({ ...input, visible: [record({ code: "known" }, 6)] });
  assert.notEqual(
    keyedImportDigest({ ...binding, decision_set: keyedDecisionSet(moved) }),
    digest,
  );
  // A record that disappeared after preview also changes the operation.
  const gone = planKeyedImport({ ...input, visible: [] });
  assert.notEqual(
    keyedImportDigest({ ...binding, decision_set: keyedDecisionSet(gone) }),
    digest,
  );
});

test("W09d keyed modes refuse a key property that is absent or unsuitable", () => {
  assert.throws(
    () =>
      planKeyedImport({
        mode: "skip-existing",
        rows: [],
        targetProperties: properties,
        visible: [],
      }),
    /require a key property/,
  );
  assert.throws(
    () =>
      planKeyedImport({
        mode: "skip-existing",
        keyPropertyId: "missing",
        rows: [],
        targetProperties: properties,
        visible: [],
      }),
    /not in the target schema/,
  );
  assert.throws(
    () =>
      planKeyedImport({
        mode: "skip-existing",
        keyPropertyId: "rel",
        rows: [],
        visible: [],
        targetProperties: [
          ...properties,
          { id: "rel", name: "Rel", type: "relation", target_database_id: "00000000-0000-0000-0000-000000000000" },
        ],
      }),
    /Import key must be one of/,
  );
});
