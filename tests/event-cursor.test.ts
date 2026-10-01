import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  beginEventCursor,
  encodeEventCursor,
  decodeEventCursor,
} from "../packages/events/cursor.ts";

test("event cursor is signed, tenant and principal bound, and retains microseconds", () => {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  const tenant = randomUUID(), principal = randomUUID();
  try {
    const value = beginEventCursor(tenant, principal);
    assert.equal(value.id, "00000000-0000-0000-0000-000000000000");
    assert.equal(value.at, "1970-01-01T00:00:00.000Z");
    const initial = encodeEventCursor(value);
    assert.deepEqual(decodeEventCursor(initial, tenant, principal), value);

    const advanced = {
      ...value,
      at: "2026-09-28T12:34:56.123456Z",
      id: randomUUID(),
    };
    const token = encodeEventCursor(advanced);
    assert.deepEqual(
      decodeEventCursor(token, tenant, principal),
      advanced,
      "microsecond precision must survive the cursor round-trip",
    );
    assert.throws(
      () => decodeEventCursor(token, randomUUID(), principal),
      /Invalid event cursor/,
    );
    assert.throws(
      () => decodeEventCursor(token, tenant, randomUUID()),
      /Invalid event cursor/,
    );
    assert.throws(
      () => decodeEventCursor(token.slice(0, -2) + "xx", tenant, principal),
      /Invalid event cursor/,
    );
    assert.throws(
      () => decodeEventCursor("malformed", tenant, principal),
      /Invalid event cursor/,
    );
    assert.throws(
      () => decodeEventCursor("x".repeat(2050), tenant, principal),
      /Invalid event cursor/,
    );
    const fromBoundary = beginEventCursor(
      tenant,
      principal,
      "2026-09-01T01:02:03.123Z",
    );
    assert.equal(fromBoundary.at, "2026-09-01T01:02:03.123Z");
    assert.throws(
      () => beginEventCursor(tenant, principal, "not-a-time"),
      /Invalid event start time/,
    );
    assert.throws(
      () => beginEventCursor(tenant, principal, "2030-01-01"),
      /Invalid event start time/,
    );
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
});
