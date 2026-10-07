import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIntegrationClient } from "../packages/integration-client/index.ts";
import { integrationOpenApi } from "../packages/contracts/openapi.ts";

// W22: the generated typed client is the supported external consumption path.
// Prove it builds versioned /api/v1 requests, authenticates with a bearer
// token supplied by the caller (never an embedded credential) and surfaces the
// structured Workspace error envelope (status + request_id) instead of a bare
// failure.
test("W22 integration client builds versioned requests with bearer auth and typed errors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stubFetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1)
      return new Response(
        JSON.stringify([{ id: "res-1", kind: "page", title: "Example page" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response(
      JSON.stringify({ error: "Access revoked", request_id: "req-client-1" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new WorkspaceIntegrationClient({
    baseUrl: "https://workspace.example.test/",
    token: "integration-token-value",
    fetch: stubFetch,
  });

  const resources = await client.request("GET /resources", {
    query: { limit: 25, offset: 5 },
  });
  assert.equal(resources[0].title, "Example page");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(
    calls[0].url,
    "https://workspace.example.test/api/v1/resources?limit=25&offset=5",
  );
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer integration-token-value",
  );

  await assert.rejects(
    () =>
      client.request("GET /pages/:id/content", {
        params: { id: "page/id with spaces" },
      }),
    (error: any) => {
      assert.equal(error.message, "Access revoked");
      assert.equal(error.status, 403);
      assert.equal(error.requestId, "req-client-1");
      return true;
    },
  );
  assert.equal(
    calls[1].url,
    "https://workspace.example.test/api/v1/pages/page%2Fid%20with%20spaces/content",
  );
});

// The external client is generated from the published integration surface. Keep
// that surface explicit so a human/admin route cannot leak into the external
// contract unnoticed, and so widening it is a deliberate reviewed change.
test("W22 the external integration surface stays explicit and versioned", () => {
  assert.deepEqual(
    Object.keys(integrationOpenApi).sort(),
    [
      "DELETE /webhooks/:id/secret-rotation",
      "GET /events",
      "GET /events/cursor",
      "GET /events/reconcile",
      "GET /jobs/:id",
      "GET /pages/:id/content",
      "GET /resources",
      "GET /resources/:id/backlinks",
      "GET /resources/:id/permissions",
      "GET /resources/:id/permissions/check",
      "PATCH /pages/:id/content",
      "POST /imports",
      "POST /imports/preview",
      "POST /resource-links/reconcile",
      "POST /webhooks/:id/secret-rotation",
      "POST /webhooks/:id/secret-rotation/activate",
    ].sort(),
  );
});
