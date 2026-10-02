import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  newDatabasePageCursor, encodeDatabasePageCursor,
  decodeDatabasePageCursor, databasePageFingerprint,
} from "../packages/database/page-cursor.ts";

test("W08b encrypted keyset cursors are scoped, tamper proof and expiring", () => {
  const old = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "e".repeat(64);
  try {
    const now = Math.floor(Date.now() / 1000);
    const tenant = randomUUID(), user = randomUUID(),
      database = randomUUID(), linked = randomUUID(), view = randomUUID();
    const fingerprint = databasePageFingerprint({
      type: "table", filters: [{ property: "name", op: "eq", value: "ok" }],
      sort: [],
    });
    const state = newDatabasePageCursor(tenant, user, "member", database,
      view, fingerprint, 50, 3.5, linked, now);
    const token = encodeDatabasePageCursor(state);
    const ctx = { tenant, principal: user, role: "member" as const,
      database, view,
      fingerprint, limit: 50 };
    assert.match(token, /^db-page-v1\./);
    assert.ok(!token.includes(linked));
    assert.ok(!token.includes(Buffer.from(linked).toString("base64url")));
    assert.deepEqual(decodeDatabasePageCursor(token, ctx, now), state);
    assert.notEqual(token, encodeDatabasePageCursor(state),
      "nonce must randomize identical cursor states");
    for (const change of [
      { tenant: randomUUID() }, { principal: randomUUID() },
      { database: randomUUID() }, { view: randomUUID() },
      { role: "admin" as const },
      { fingerprint: databasePageFingerprint({ type: "table", filters: [] }) },
      { limit: 20 },
    ])
      assert.throws(() => decodeDatabasePageCursor(token,
        { ...ctx, ...change }, now), /Invalid database page cursor/);
    assert.throws(() => decodeDatabasePageCursor(token, ctx, now + 1800),
      /Invalid database page cursor/);
    assert.throws(() => decodeDatabasePageCursor(token, ctx, now - 90),
      /Invalid database page cursor/);
    const parts = token.split(".");
    const bytes = Buffer.from(parts[1], "base64url");
    bytes[bytes.length - 1] ^= 1;
    assert.throws(() => decodeDatabasePageCursor(
      parts[0] + "." + bytes.toString("base64url"), ctx, now),
      /Invalid database page cursor/);
    for (const invalid of ["", token + "!", "event-v1.fake",
      "x".repeat(2050)])
      assert.throws(() => decodeDatabasePageCursor(invalid, ctx, now),
        /Invalid database page cursor/);
  } finally {
    if (old === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = old;
  }
});
