import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  beginReconcileCursor,
  encodeReconcileCursor,
  decodeReconcileCursor,
} from "../packages/events/reconcile-cursor.ts";

test("reconciliation cursors encrypt scan positions, bind tenant/principal and expire", () => {
  const oldKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "d".repeat(64);
  try {
    const now = Math.floor(Date.now() / 1000);
    const tenant = randomUUID();
    const principal = randomUUID();
    const hiddenResource = randomUUID();
    const start = beginReconcileCursor(tenant, principal, now);
    const cursor = encodeReconcileCursor({
      ...start, after: hiddenResource,
    });
    assert.match(cursor, /^reconcile-v1\./);
    assert.ok(!cursor.includes(hiddenResource));
    assert.ok(!cursor.includes(Buffer.from(hiddenResource).toString("base64url")));
    assert.deepEqual(decodeReconcileCursor(cursor, tenant, principal, now), {
      ...start, after: hiddenResource,
    });
    const another = encodeReconcileCursor({ ...start, after: hiddenResource });
    assert.notEqual(cursor, another, "a new authenticated nonce is used");

    assert.throws(
      () => decodeReconcileCursor(cursor, randomUUID(), principal, now),
      /Invalid reconciliation cursor/,
    );
    assert.throws(
      () => decodeReconcileCursor(cursor, tenant, randomUUID(), now),
      /Invalid reconciliation cursor/,
    );
    assert.throws(
      () => decodeReconcileCursor(cursor, tenant, principal, now + 3600),
      /Invalid reconciliation cursor/,
    );
    assert.throws(
      () => decodeReconcileCursor(cursor, tenant, principal, now - 60),
      /Invalid reconciliation cursor/,
    );
    const parts = cursor.split(".");
    const data = Buffer.from(parts[1], "base64url");
    data[data.length - 1] ^= 1;
    assert.throws(
      () => decodeReconcileCursor(parts[0] + "." + data.toString("base64url"),
        tenant, principal, now),
      /Invalid reconciliation cursor/,
    );
    assert.throws(
      () => decodeReconcileCursor("event-v1.fake.fake", tenant, principal),
      /Invalid reconciliation cursor/,
    );
    assert.throws(
      () => decodeReconcileCursor("x".repeat(2050), tenant, principal),
      /Invalid reconciliation cursor/,
    );
  } finally {
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = oldKey;
  }
});
