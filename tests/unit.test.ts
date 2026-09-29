import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../packages/permissions/index.ts";
import {
  properties,
  validateValues,
  taskProperties,
} from "../packages/contracts/index.ts";
import { defaultBranding, brandingSchema } from "../packages/branding/index.ts";
import {
  passwordHash,
  verifyPassword,
  issueTicket,
  verifyTicket,
} from "../packages/auth/index.ts";
import { encrypt, decrypt, signature } from "../packages/events/index.ts";
import {
  blocksToState,
  project,
  validateBlocks,
} from "../packages/editor/server.ts";
import * as Y from "yjs";
process.env.ENCRYPTION_KEY = "b".repeat(64);
test("ancestor denial cannot be bypassed by a child grant", () => {
  const path = [
    { inherit_permissions: true, acl: [{ principal_id: "*", level: 0 }] },
    { inherit_permissions: true, acl: [{ principal_id: "u", level: 4 }] },
  ];
  assert.equal(evaluate({ role: "member", user_id: "u" }, path), 0);
  assert.equal(evaluate({ role: "owner", user_id: "u" }, path), 4);
  assert.equal(
    evaluate({ role: "owner", user_id: "u" }, [
      { ...path[0], deleted_at: new Date() },
    ]),
    0,
  );
});
test("guests require explicit root access; personal grants override everyone", () => {
  const root = { inherit_permissions: true, acl: [] };
  assert.equal(evaluate({ role: "guest", user_id: "u" }, [root]), 0);
  assert.equal(
    evaluate({ role: "member", user_id: "u" }, [
      {
        ...root,
        acl: [
          { principal_id: "*", level: 1 },
          { principal_id: "u", level: 2 },
        ],
      },
    ]),
    2,
  );
});
test("schema and typed values reject malformed data", () => {
  assert.throws(() =>
    properties.parse([{ id: "x", name: "No title", type: "text" }]),
  );
  assert.throws(() =>
    validateValues(taskProperties, { name: "Task", status: "Invented" }),
  );
  assert.throws(() =>
    validateValues(taskProperties, { name: "Task", due: "2026-02-30" }),
  );
  assert.throws(() =>
    validateValues(taskProperties, { name: "Task", unknown: true }),
  );
  assert.equal(
    validateValues(taskProperties, { name: "Task", due: "2026-09-29" }).due,
    "2026-09-29",
  );
});
test("branding has one configuration source and rejects script URLs", () => {
  assert.equal(defaultBranding({ PRODUCT_NAME: "Acme" }).productName, "Acme");
  assert.throws(() =>
    brandingSchema.parse({
      ...defaultBranding(),
      logoLight: "javascript:alert(1)",
    }),
  );
});
test("scrypt passwords, tamper-proof tickets, encrypted secrets", async () => {
  const h = await passwordHash("test-password-long");
  assert(await verifyPassword("test-password-long", h));
  assert(!(await verifyPassword("incorrect", h)));
  const t = issueTicket({
    tenant: "t",
    user: "u",
    resource: "r",
    epoch: 1,
    sessionHash: "h",
  });
  assert.equal(verifyTicket(t).resource, "r");
  assert.throws(() => verifyTicket(t + "x"));
  const v = encrypt("secret");
  assert.equal(decrypt(v), "secret");
  const parts = v.split(".");
  parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  assert.throws(() => decrypt(parts.join(".")));
  assert.equal(signature("key", "1", "body").length, 64);
});
test("canonical document survives Yjs round trip and unsafe links fail", () => {
  const d = new Y.Doc();
  Y.applyUpdate(
    d,
    blocksToState([{ type: "paragraph", content: "Canonical source" }]),
  );
  assert.equal(project(d).plain_text, "Canonical source");
  assert.throws(() =>
    validateBlocks([
      {
        type: "paragraph",
        content: [{ type: "link", href: "javascript:alert(1)" }],
      },
    ]),
  );
  d.destroy();
});
