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
import { inspectFile } from "../packages/storage/index.ts";
import * as Y from "yjs";
import {
  HttpMetrics,
  renderPrometheusMetrics,
} from "../packages/operations/metrics.ts";
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


test("Prometheus metrics remain low-cardinality and aggregate status classes", () => {
  const http = new HttpMetrics();
  http.record("GET", 200, 125);
  http.record("GET", 204, 75);
  http.record("POST", 503, 250);
  const output = renderPrometheusMetrics({
    startedAt: Date.now() - 5000,
    dependencies: { database: true, storage: false },
    services: {
      api: { configured: true, healthy: true },
      collaboration: {
        configured: true,
        healthy: true,
        values: { connections: 3, documents: 2 },
      },
      worker: { configured: false },
    },
    http: http.snapshot(),
  });

  assert.match(output, /workspace_dependency_ready\{dependency="database"\} 1/);
  assert.match(output, /workspace_dependency_ready\{dependency="storage"\} 0/);
  assert.match(output, /workspace_service_healthy\{service="collaboration"\} 1/);
  assert.match(output, /workspace_service_configured\{service="worker"\} 0/);
  assert.match(output, /workspace_http_requests_total\{method="GET",status_class="2xx"\} 2/);
  assert.match(output, /workspace_http_requests_total\{method="POST",status_class="5xx"\} 1/);
  assert.doesNotMatch(output, /tenant|user_id|resource_id|document_id/);
});


test("attachment inspection rejects active or mismatched content", () => {
  assert.throws(
    () => inspectFile("payload.html", "text/html", Buffer.from("<script>alert(1)</script>")),
    /Unsupported file extension/,
  );
  assert.throws(
    () => inspectFile("fake.png", "image/png", Buffer.from("not-a-png")),
    /Invalid PNG/,
  );
  assert.throws(
    () => inspectFile("notes.txt", "image/png", Buffer.from("plain text")),
    /MIME type mismatch/,
  );
  assert.throws(
    () => inspectFile("fake.pdf", "application/pdf", Buffer.from("not a pdf")),
    /Invalid PDF/,
  );
});
