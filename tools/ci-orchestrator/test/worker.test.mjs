import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeBatch,
  handleWebhook,
  normalizeWorkflowRun,
  verifyGitHubSignature,
} from "../src/worker.mjs";

const secret = "test-webhook-secret";
const encoder = new TextEncoder();

async function signature(body) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );
  return "sha256=" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function payload(overrides = {}) {
  return {
    action: "completed",
    repository: { full_name: "sjevans1/Workspace-Platform" },
    workflow: { name: "Workspace verification", path: ".github/workflows/ci.yml" },
    workflow_run: {
      id: 123,
      workflow_id: 456,
      name: "Workspace verification",
      path: ".github/workflows/ci.yml",
      run_number: 77,
      run_attempt: 1,
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      head_sha: "a".repeat(40),
      head_branch: "feature/example",
      html_url: "https://github.com/example/run/123",
      pull_requests: [{ number: 131 }],
      ...overrides,
    },
  };
}

class FakeD1 {
  constructor() {
    this.ids = new Set();
  }
  prepare(sql) {
    if (sql.startsWith("DELETE")) {
      return {
        bind: (id) => ({
          run: async () => ({ meta: { changes: this.ids.delete(id) ? 1 : 0 } }),
        }),
      };
    }
    return {
      bind: (id) => ({
        run: async () => {
          const duplicate = this.ids.has(id);
          this.ids.add(id);
          return { meta: { changes: duplicate ? 0 : 1 } };
        },
      }),
    };
  }
}

function env() {
  const sent = [];
  return {
    GITHUB_WEBHOOK_SECRET: secret,
    ALLOWED_REPOSITORY: "sjevans1/Workspace-Platform",
    ALLOWED_WORKFLOWS: "Workspace verification,.github/workflows/ci.yml",
    DELIVERIES: new FakeD1(),
    CI_EVENTS: { send: async (event) => sent.push(event) },
    sent,
  };
}

async function requestFor(body, headers = {}) {
  return new Request("https://ci.example.test/github/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": await signature(body),
      ...headers,
    },
  });
}

test("valid workflow completion is normalized and queued once", async () => {
  const body = JSON.stringify(payload());
  const bindings = env();
  const response = await handleWebhook(await requestFor(body), bindings);
  assert.equal(response.status, 202);
  assert.equal(bindings.sent.length, 1);
  assert.equal(bindings.sent[0].kind, "ci.workflow.completed");
  assert.equal(bindings.sent[0].repository, "sjevans1/Workspace-Platform");
  assert.equal(bindings.sent[0].workflow.run_id, 123);
  assert.equal(bindings.sent[0].workflow.head_sha, "a".repeat(40));
  assert.deepEqual(bindings.sent[0].pull_requests, [131]);
  assert.equal(bindings.sent[0].next_action, "diagnose_failure");
});

test("tampered signature is rejected before queue or dedupe work", async () => {
  const body = JSON.stringify(payload());
  const bindings = env();
  const request = await requestFor(body, {
    "x-hub-signature-256": "sha256=" + "0".repeat(64),
  });
  const response = await handleWebhook(request, bindings);
  assert.equal(response.status, 401);
  assert.equal(bindings.sent.length, 0);
  assert.equal(bindings.DELIVERIES.ids.size, 0);
});

test("duplicate GitHub delivery is acknowledged but not requeued", async () => {
  const body = JSON.stringify(payload());
  const bindings = env();
  const first = await handleWebhook(await requestFor(body), bindings);
  const second = await handleWebhook(await requestFor(body), bindings);
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(bindings.sent.length, 1);
  assert.equal((await second.json()).duplicate, true);
});

test("queue failure releases the D1 claim so GitHub retry can enqueue", async () => {
  const body = JSON.stringify(payload());
  const bindings = env();
  let attempts = 0;
  bindings.CI_EVENTS.send = async (event) => {
    attempts++;
    if (attempts === 1) throw new Error("queue unavailable");
    bindings.sent.push(event);
  };

  await assert.rejects(
    handleWebhook(await requestFor(body), bindings),
    /queue unavailable/,
  );
  assert.equal(bindings.DELIVERIES.ids.size, 0);

  const retried = await handleWebhook(await requestFor(body), bindings);
  assert.equal(retried.status, 202);
  assert.equal(bindings.sent.length, 1);
  assert.equal(attempts, 2);
});

test("irrelevant workflow and repository events are ignored", async () => {
  const body = JSON.stringify(payload({ name: "Unrelated workflow", path: "other.yml" }));
  const bindings = env();
  const response = await handleWebhook(await requestFor(body), bindings);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).ignored, true);
  assert.equal(bindings.sent.length, 0);

  const foreign = JSON.stringify({
    ...payload(),
    repository: { full_name: "someone/else" },
  });
  const response2 = await handleWebhook(
    await requestFor(foreign, { "x-github-delivery": "delivery-2" }),
    bindings,
  );
  assert.equal(response2.status, 202);
  assert.equal(bindings.sent.length, 0);
});

test("success completion requests only the next permitted advancement", () => {
  const event = normalizeWorkflowRun(
    payload({ conclusion: "success" }),
    "delivery-success",
    "2026-10-06T00:00:00.000Z",
  );
  assert.equal(event.next_action, "advance_if_allowed");
  assert.equal(event.workflow.conclusion, "success");
});

test("signature verifier rejects malformed signatures", async () => {
  const bytes = encoder.encode("{}");
  assert.equal(await verifyGitHubSignature(secret, bytes, "sha1=abc"), false);
  assert.equal(await verifyGitHubSignature(secret, bytes, "sha256=xyz"), false);
});

test("queue consumer authenticates dispatch and acks success", async () => {
  const calls = [];
  let acked = 0, retried = 0;
  const event = normalizeWorkflowRun(payload(), "delivery-dispatch");
  await consumeBatch({
    messages: [{
      body: event,
      ack: () => acked++,
      retry: () => retried++,
    }],
  }, {
    AGENT_DISPATCH_URL: "https://agent.example.test/events",
    AGENT_DISPATCH_TOKEN: "dispatch-secret",
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response("ok", { status: 202 });
  });

  assert.equal(acked, 1);
  assert.equal(retried, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer dispatch-secret");
  assert.equal(calls[0].init.headers["x-ci-event-id"], "delivery-dispatch");
});

test("queue consumer retries downstream failure instead of dropping event", async () => {
  let acked = 0, retried = 0;
  const event = normalizeWorkflowRun(payload(), "delivery-failure");
  await consumeBatch({
    messages: [{
      body: event,
      ack: () => acked++,
      retry: () => retried++,
    }],
  }, {
    AGENT_DISPATCH_URL: "https://agent.example.test/events",
    AGENT_DISPATCH_TOKEN: "dispatch-secret",
  }, async () => new Response("unavailable", { status: 503 }));

  assert.equal(acked, 0);
  assert.equal(retried, 1);
});
