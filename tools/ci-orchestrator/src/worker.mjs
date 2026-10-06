const MAX_BODY_BYTES = 1_000_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requiredEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing required binding: ${name}`);
  return value.trim();
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hexBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function verifyGitHubSignature(secret, bodyBytes, signature) {
  if (!signature?.startsWith("sha256=")) return false;
  const supplied = hexBytes(signature.slice("sha256=".length));
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, supplied, bodyBytes);
}

export function normalizeWorkflowRun(payload, deliveryId, receivedAt = new Date().toISOString()) {
  const run = payload?.workflow_run;
  const repository = payload?.repository?.full_name;
  if (payload?.action !== "completed" || !run || !repository)
    throw new Error("Invalid workflow_run completion payload");

  return {
    version: 1,
    source: "github",
    kind: "ci.workflow.completed",
    delivery_id: deliveryId,
    received_at: receivedAt,
    repository,
    workflow: {
      id: run.workflow_id ?? null,
      name: run.name ?? payload?.workflow?.name ?? null,
      path: run.path ?? payload?.workflow?.path ?? null,
      run_id: run.id,
      run_number: run.run_number ?? null,
      run_attempt: run.run_attempt ?? null,
      event: run.event ?? null,
      status: run.status ?? "completed",
      conclusion: run.conclusion ?? null,
      head_sha: run.head_sha,
      head_branch: run.head_branch ?? null,
      html_url: run.html_url ?? null,
    },
    pull_requests: Array.isArray(run.pull_requests)
      ? run.pull_requests
          .map((pr) => pr?.number)
          .filter((number) => Number.isInteger(number))
      : [],
    next_action:
      run.conclusion === "success" ? "advance_if_allowed" : "diagnose_failure",
  };
}

export function shouldProcessWorkflow(payload, env) {
  if (payload?.action !== "completed") return false;
  const repository = payload?.repository?.full_name;
  if (!repository) return false;
  const allowedRepository = String(env.ALLOWED_REPOSITORY || "").trim();
  if (allowedRepository && repository !== allowedRepository) return false;

  const allowedWorkflows = csv(env.ALLOWED_WORKFLOWS);
  if (!allowedWorkflows.length) return true;
  const run = payload.workflow_run || {};
  return allowedWorkflows.includes(run.name) || allowedWorkflows.includes(run.path);
}

async function claimDelivery(env, event, deliveryId) {
  if (!env.DELIVERIES?.prepare)
    throw new Error("Missing required D1 binding: DELIVERIES");
  const result = await env.DELIVERIES.prepare(
    "INSERT OR IGNORE INTO github_deliveries" +
      " (delivery_id,event_type,repository,received_at)" +
      " VALUES (?1,?2,?3,?4)",
  )
    .bind(deliveryId, "workflow_run", event.repository, event.received_at)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function releaseDelivery(env, deliveryId) {
  await env.DELIVERIES.prepare(
    "DELETE FROM github_deliveries WHERE delivery_id = ?1",
  )
    .bind(deliveryId)
    .run();
}

async function enqueue(env, event) {
  if (!env.CI_EVENTS?.send)
    throw new Error("Missing required Queue binding: CI_EVENTS");
  await env.CI_EVENTS.send(event, {
    contentType: "json",
  });
}

export async function handleWebhook(request, env) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES)
    return jsonResponse({ error: "Payload too large" }, 413);

  const eventType = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const signature = request.headers.get("x-hub-signature-256");
  if (!eventType || !deliveryId || !signature)
    return jsonResponse({ error: "Missing GitHub webhook headers" }, 400);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES)
    return jsonResponse({ error: "Payload too large" }, 413);

  const valid = await verifyGitHubSignature(
    requiredEnv(env, "GITHUB_WEBHOOK_SECRET"),
    body,
    signature,
  );
  if (!valid) return jsonResponse({ error: "Invalid signature" }, 401);

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (eventType === "ping")
    return jsonResponse({ ok: true, event: "ping" });

  if (eventType !== "workflow_run" || !shouldProcessWorkflow(payload, env))
    return jsonResponse({ ok: true, ignored: true }, 202);

  let normalized;
  try {
    normalized = normalizeWorkflowRun(payload, deliveryId);
  } catch {
    return jsonResponse({ error: "Invalid workflow_run payload" }, 400);
  }

  if (!(await claimDelivery(env, normalized, deliveryId)))
    return jsonResponse({ ok: true, duplicate: true }, 200);

  try {
    await enqueue(env, normalized);
  } catch (error) {
    try {
      await releaseDelivery(env, deliveryId);
    } catch (releaseError) {
      console.error("Failed to release unqueued GitHub delivery claim", {
        delivery_id: deliveryId,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw error;
  }
  return jsonResponse({ ok: true, queued: true }, 202);
}

export async function dispatchEvent(event, env, fetchImpl = fetch) {
  const url = requiredEnv(env, "AGENT_DISPATCH_URL");
  const token = requiredEnv(env, "AGENT_DISPATCH_TOKEN");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-ci-event-id": event.delivery_id,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Agent dispatch failed with HTTP ${response.status}`);
}

export async function consumeBatch(batch, env, fetchImpl = fetch) {
  for (const message of batch.messages) {
    try {
      await dispatchEvent(message.body, env, fetchImpl);
      message.ack();
    } catch (error) {
      console.error("CI event dispatch failed", {
        delivery_id: message.body?.delivery_id,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz")
      return jsonResponse({ ok: true });
    if (request.method !== "POST" || url.pathname !== "/github/webhook")
      return jsonResponse({ error: "Not found" }, 404);
    try {
      return await handleWebhook(request, env);
    } catch (error) {
      console.error("Webhook receiver failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: "Internal error" }, 500);
    }
  },

  async queue(batch, env) {
    await consumeBatch(batch, env);
  },
};
