import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  beginDatabasePage, decodeDatabasePage, encodeDatabasePage,
} from "../packages/database/page-cursor.ts";

const tenant = randomUUID(), principal = randomUUID(),
  database = randomUUID(), another = randomUUID();
const prior = process.env.ENCRYPTION_KEY;
process.env.ENCRYPTION_KEY ||= "a".repeat(64);
test("W08b cursor round-trip binds tenant, user, database, role, expiry and limit", () => {
  const beginning = beginDatabasePage(tenant, principal, database,
    "member", 13, 1000);
  const token = encodeDatabasePage(beginning);
  assert.ok(token.startsWith("db-page-v1."));
  assert.ok(!token.includes(principal) && !token.includes(database));
  assert.deepEqual(decodeDatabasePage(token, tenant, principal, database,
    "member", 1001), beginning);
  const next = encodeDatabasePage({
    ...beginning, after_pos: 12.5, after_id: randomUUID(),
  });
  const decoded = decodeDatabasePage(next, tenant, principal, database,
    "member", 1100);
  assert.equal(decoded.after_pos, 12.5);
  const failures: Array<() => unknown> = [
    () => decodeDatabasePage(token, another, principal, database, "member", 1001),
    () => decodeDatabasePage(token, tenant, another, database, "member", 1001),
    () => decodeDatabasePage(token, tenant, principal, another, "member", 1001),
    () => decodeDatabasePage(token, tenant, principal, database, "admin", 1001),
    () => decodeDatabasePage(token, tenant, principal, database, "member", 1900),
    () => decodeDatabasePage(token.slice(0, -3) + "abc",
      tenant, principal, database, "member", 1001),
    () => decodeDatabasePage("db-page-v1.invalid",
      tenant, principal, database, "member", 1001),
  ];
  for (const invalid of failures) assert.throws(invalid);
  assert.throws(() => beginDatabasePage(tenant, principal, database,
    "member", 201, 1000));
  assert.throws(() => encodeDatabasePage({ ...beginning, after_id: another }));
});
test.after(() => {
  if (prior === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = prior;
});
