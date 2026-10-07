import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

const email = "browser@example.test";
const password = "browser-password-123";

// This dedicated suite runs after the normal browser regression against the
// same deployed Caddy/IP limiter. Replenish the real window rather than
// disabling rate limits or misclassifying an HTTP 429 as authentication loss.
test.beforeEach(async ({ request }) => {
  test.setTimeout(240000);
  for (let attempt = 0; attempt < 26; attempt++) {
    const response = await request.get("/api/v1/auth/methods");
    const raw = response.headers()["x-ratelimit-remaining"];
    const remaining = raw === undefined ? NaN : Number(raw);
    if (response.ok() && Number.isFinite(remaining) && remaining >= 160)
      return;
    if (attempt === 25)
      throw new Error(
        `Wave R shared IP rate budget did not replenish: status=${response.status()} remaining=${raw ?? "missing"}`,
      );
    const hint = Number(response.headers()["retry-after"]);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Number.isFinite(hint) && hint >= 0
        ? Math.min(60000, (hint + 1) * 1000)
        : 5000),
    );
  }
});

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Welcome back, Shane." });
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  const retry = page.getByRole("button", { name: "Retry loading workspace" });

  for (let attempt = 0; attempt < 3; attempt++) {
    await expect.poll(async () =>
      (await heading.isVisible()) ||
      (await signIn.isVisible()) ||
      (await retry.isVisible()),
    ).toBe(true);

    if (await heading.isVisible()) return;
    if (await retry.isVisible()) {
      const notice = await page.getByRole("alert")
        .filter({ hasText: "Workspace connection interrupted" }).innerText();
      const match = notice.match(/retry after (\\d+) seconds?/i);
      const delay = match ? Number(match[1]) : 60;
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(60);
      await page.waitForTimeout((delay + 2) * 1000);
      await retry.click();
      continue;
    }
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await signIn.click();
    await expect(heading).toBeVisible();
    return;
  }
  throw new Error("Wave R login did not recover from shared deployment rate limit");
}

function compose(args: string[]) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForCollabHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const output = compose([
        "exec",
        "-T",
        "collab",
        "node",
        "-e",
        "fetch('http://127.0.0.1:1235/health').then(async r=>{const b=await r.text();if(!r.ok)process.exit(2);const j=JSON.parse(b);if(!j.healthy)process.exit(3);console.log(b)}).catch(()=>process.exit(4))",
      ]);
      const health = JSON.parse(output.trim());
      if (health.healthy) return health;
    } catch {
      // Container may be between stop/start or waiting for the DB writer lease.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Collaboration service did not become healthy after restart");
}

test("Wave R R0 fault harness: browser reconnect and collaboration writer restart", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.E2E_WAVE_R_HARNESS !== "1",
    "R0 fault injection runs only in the dedicated deployed acceptance step",
  );
  test.setTimeout(180000);

  await login(page);
  const meResponse = await page.request.get("/api/v1/me");
  expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
  const me = await meResponse.json();
  const headers = { "X-CSRF-Token": me.csrf };

  const rootsResponse = await page.request.get("/api/v1/resources");
  expect(rootsResponse.ok(), await rootsResponse.text()).toBeTruthy();
  const roots = await rootsResponse.json();

  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "Wave R R0 fault harness " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();

  const pageResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "Wave R reconnect evidence " + Date.now(),
    },
  });
  expect(pageResponse.ok(), await pageResponse.text()).toBeTruthy();
  const resource = await pageResponse.json();
  const contentUrl = "/api/v1/pages/" + resource.id + "/content";

  await page.goto("/?page=" + resource.id);
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();

  await editor.click();
  await page.keyboard.type("R0 baseline.");
  await expect.poll(async () => {
    const response = await page.request.get(contentUrl);
    if (!response.ok()) return "";
    return (await response.json()).plain_text;
  }).toContain("R0 baseline.");

  // Browser-network fault: this affects the actual page/WebSocket transport,
  // not APIRequestContext, so the control probe runs inside the page.
  await context.setOffline(true);
  await expect.poll(async () =>
    page.evaluate(async () => {
      try {
        await fetch("/api/v1/me", { cache: "no-store" });
        return "reachable";
      } catch {
        return "offline";
      }
    }),
  ).toBe("offline");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" queued-through-browser-network-fault");

  await context.setOffline(false);
  await expect.poll(async () =>
    page.evaluate(async () => {
      try {
        const response = await fetch("/api/v1/me", { cache: "no-store" });
        return response.status;
      } catch {
        return 0;
      }
    }),
  ).toBe(200);

  await expect.poll(async () => {
    const response = await page.request.get(contentUrl);
    if (!response.ok()) return "";
    return (await response.json()).plain_text;
  }, { timeout: 30000 }).toContain("queued-through-browser-network-fault");

  // Host-side writer fault: restart the real Compose collaboration service.
  // No runtime backdoor is added; the test process has the same Docker access
  // already used by deployment acceptance.
  compose(["restart", "collab"]);
  const health = await waitForCollabHealth();
  expect(health.healthy).toBe(true);

  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" persisted-after-writer-restart");

  await expect.poll(async () => {
    const response = await page.request.get(contentUrl);
    if (!response.ok()) return "";
    return (await response.json()).plain_text;
  }, { timeout: 45000 }).toContain("persisted-after-writer-restart");

  await expect(page.getByRole("status").filter({ hasText: "Saved" }))
    .toBeVisible();
});


test("W18 recovers only explicit device-local unacknowledged drafts", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.E2E_WAVE_R_HARNESS !== "1",
    "W18 recovery acceptance runs only in the deployed Wave R step",
  );
  test.setTimeout(180000);

  await login(page);
  const meResponse = await page.request.get("/api/v1/me");
  expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
  const me = await meResponse.json();
  const headers = { "X-CSRF-Token": me.csrf };

  const rootsResponse = await page.request.get("/api/v1/resources");
  expect(rootsResponse.ok(), await rootsResponse.text()).toBeTruthy();
  const roots = await rootsResponse.json();
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "W18 recovery acceptance " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const resourceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W18 interrupted edit " + Date.now(),
    },
  });
  expect(resourceResponse.ok(), await resourceResponse.text()).toBeTruthy();
  const resource = await resourceResponse.json();
  const url = "/?page=" + resource.id;
  const contentUrl = "/api/v1/pages/" + resource.id + "/content";

  await page.goto(url);
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("W18 acknowledged baseline.");
  await expect(page.getByRole("status").filter({ hasText: "Saved" }))
    .toBeVisible();

  const restoreToken = " W18-restore-" + Date.now();
  // Browser offline emulation does not drop an established WebSocket, so the
  // transport loss is injected host-side: stopping the collaboration service
  // closes the real socket. Wait for the provider to acknowledge the loss
  // before the offline write, so the draft stays device-local.
  compose(["stop", "collab"]);
  await expect(page.getByRole("status").filter({ hasText: "Offline" }))
    .toBeVisible({ timeout: 20000 });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(restoreToken);
  await expect.poll(() =>
    page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("workspace-recovery:v1:")).length,
    ),
  ).toBeGreaterThan(0);

  const beforeRestore = await page.request.get(contentUrl);
  expect(beforeRestore.ok(), await beforeRestore.text()).toBeTruthy();
  expect((await beforeRestore.json()).plain_text).not.toContain(restoreToken.trim());

  // Simulate loss of the renderer/tab before the provider can reconnect.
  await page.close();
  compose(["start", "collab"]);
  await waitForCollabHealth();

  const recovered = await context.newPage();
  await recovered.goto(url);
  await expect(
    recovered.getByText("Unsaved changes are available from this device.", {
      exact: true,
    }),
  ).toBeVisible();
  const canonicalBeforeRestore = await recovered.request.get(contentUrl);
  expect(canonicalBeforeRestore.ok(), await canonicalBeforeRestore.text()).toBeTruthy();
  expect((await canonicalBeforeRestore.json()).plain_text)
    .not.toContain(restoreToken.trim());

  await recovered.getByRole("button", { name: "Restore draft" }).click();
  await expect(recovered.locator(".bn-editor")).toContainText(restoreToken.trim());
  await expect.poll(async () => {
    const response = await recovered.request.get(contentUrl);
    if (!response.ok()) return "";
    return (await response.json()).plain_text;
  }, { timeout: 30000 }).toContain(restoreToken.trim());
  await expect(recovered.getByRole("status").filter({ hasText: "Saved" }))
    .toBeVisible();
  await expect.poll(() =>
    recovered.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("workspace-recovery:v1:")).length,
    ),
  ).toBe(0);

  // A later interrupted draft can be explicitly discarded and must never
  // reach canonical state. Browser offline emulation does not drop an
  // established WebSocket, so the transport loss is injected host-side like
  // the restore phase above; only a confirmed disconnect keeps the draft
  // device-local.
  const discardToken = " W18-discard-" + Date.now();
  compose(["stop", "collab"]);
  await expect(recovered.getByRole("status").filter({ hasText: "Offline" }))
    .toBeVisible({ timeout: 20000 });
  await recovered.locator(".bn-editor").click();
  await recovered.keyboard.press("ControlOrMeta+End");
  await recovered.keyboard.insertText(discardToken);
  await expect.poll(() =>
    recovered.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("workspace-recovery:v1:")).length,
    ),
  ).toBeGreaterThan(0);
  await recovered.close();
  compose(["start", "collab"]);
  await waitForCollabHealth();

  const discarded = await context.newPage();
  await discarded.goto(url);
  await expect(discarded.getByRole("button", { name: "Discard draft" }))
    .toBeVisible();
  await discarded.getByRole("button", { name: "Discard draft" }).click();
  await expect(
    discarded.getByText("Unsaved changes are available from this device.", {
      exact: true,
    }),
  ).toHaveCount(0);
  const afterDiscard = await discarded.request.get(contentUrl);
  expect(afterDiscard.ok(), await afterDiscard.text()).toBeTruthy();
  expect((await afterDiscard.json()).plain_text)
    .not.toContain(discardToken.trim());

  // Explicit logout removes any remaining recovery material for this
  // principal even when the affected page is no longer open. The transport
  // loss is injected host-side (browser offline emulation leaves an
  // established WebSocket alive).
  const logoutToken = " W18-logout-" + Date.now();
  compose(["stop", "collab"]);
  await expect(discarded.getByRole("status").filter({ hasText: "Offline" }))
    .toBeVisible({ timeout: 20000 });
  await discarded.locator(".bn-editor").click();
  await discarded.keyboard.press("ControlOrMeta+End");
  await discarded.keyboard.insertText(logoutToken);
  await expect.poll(() =>
    discarded.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("workspace-recovery:v1:")).length,
    ),
  ).toBeGreaterThan(0);
  await discarded.close();
  compose(["start", "collab"]);
  await waitForCollabHealth();

  const logoutPage = await context.newPage();
  await logoutPage.goto("/");
  await expect(logoutPage.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(await logoutPage.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("workspace-recovery:v1:")).length,
  )).toBeGreaterThan(0);
  await logoutPage.getByRole("button", { name: "Sign out" }).click();
  await expect(logoutPage.getByRole("button", { name: "Sign in", exact: true }))
    .toBeVisible();
  expect(await logoutPage.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("workspace-recovery:v1:")).length,
  )).toBe(0);
});


test("W19 writer lease remains single-owner and two live editors converge after restart", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_WAVE_R_HARNESS !== "1",
    "W19 writer restart acceptance runs only in the dedicated deployed Wave R step",
  );
  test.setTimeout(210000);

  await login(page);
  const meResponse = await page.request.get("/api/v1/me");
  expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
  const me = await meResponse.json();
  const headers = { "X-CSRF-Token": me.csrf };

  // The supported architecture is intentionally single-writer. A second
  // genuine collab process must fail to acquire the PostgreSQL advisory lease
  // while the deployed writer is healthy; no test-only lock path is used.
  let contenderRejected = false;
  try {
    compose(["run", "--rm", "--no-deps", "collab"]);
  } catch (error: any) {
    contenderRejected = true;
    const stderr = String(error?.stderr || error?.message || "");
    expect(stderr).toContain("Only one collaboration writer is supported");
  }
  expect(contenderRejected, "a competing collaboration writer must not start").toBe(true);
  const beforeRestart = await waitForCollabHealth();
  expect(beforeRestart.healthy).toBe(true);

  const rootsResponse = await page.request.get("/api/v1/resources");
  expect(rootsResponse.ok(), await rootsResponse.text()).toBeTruthy();
  const roots = await rootsResponse.json();
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "W19 writer restart " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const resourceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W19 two-editor restart convergence " + Date.now(),
    },
  });
  expect(resourceResponse.ok(), await resourceResponse.text()).toBeTruthy();
  const resource = await resourceResponse.json();
  const url = "/?page=" + resource.id;
  const contentUrl = "/api/v1/pages/" + resource.id + "/content";

  await page.goto(url);
  const firstEditor = page.locator(".bn-editor");
  await expect(firstEditor).toBeVisible();
  await firstEditor.click();
  await page.keyboard.insertText("W19 writer baseline.");
  await expect.poll(async () => {
    const response = await page.request.get(contentUrl);
    if (!response.ok()) return "";
    return (await response.json()).plain_text || "";
  }, { timeout: 30000 }).toContain("W19 writer baseline.");

  const secondContext = await browser.newContext();
  try {
    const peer = await secondContext.newPage();
    await login(peer);
    await peer.goto(url);
    const peerEditor = peer.locator(".bn-editor");
    await expect(peerEditor).toContainText("W19 writer baseline.");

    // Stop the real writer. Both established WebSockets must observe the
    // transport loss before either local mutation is made.
    compose(["stop", "collab"]);
    await expect(page.getByRole("status").filter({ hasText: "Offline" }))
      .toBeVisible({ timeout: 20000 });
    await expect(peer.getByRole("status").filter({ hasText: "Offline" }))
      .toBeVisible({ timeout: 20000 });

    const firstToken = " FIRST_OFFLINE_" + Date.now();
    const secondToken = " SECOND_OFFLINE_" + Date.now();
    await firstEditor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(firstToken);
    await peerEditor.click();
    await peer.keyboard.press("ControlOrMeta+End");
    await peer.keyboard.insertText(secondToken);

    // Neither disconnected edit may be represented as canonical before the
    // writer is available again.
    const duringOutage = await page.request.get(contentUrl);
    expect(duringOutage.ok(), await duringOutage.text()).toBeTruthy();
    const outageText = (await duringOutage.json()).plain_text || "";
    expect(outageText).not.toContain(firstToken.trim());
    expect(outageText).not.toContain(secondToken.trim());

    compose(["start", "collab"]);
    const afterRestart = await waitForCollabHealth();
    expect(afterRestart.healthy).toBe(true);

    // Both providers must reconnect to the one lease-owning writer and merge
    // their independent Yjs updates. Each token must appear exactly once in
    // both views and in canonical persisted state.
    for (const editor of [firstEditor, peerEditor]) {
      await expect(editor).toContainText(firstToken.trim(), { timeout: 45000 });
      await expect(editor).toContainText(secondToken.trim(), { timeout: 45000 });
    }
    await expect(page.getByRole("status").filter({ hasText: "Saved" }))
      .toBeVisible({ timeout: 45000 });
    await expect(peer.getByRole("status").filter({ hasText: "Saved" }))
      .toBeVisible({ timeout: 45000 });

    await expect.poll(async () => {
      const response = await page.request.get(contentUrl);
      if (!response.ok()) return "";
      return (await response.json()).plain_text || "";
    }, { timeout: 45000 }).toContain(firstToken.trim());

    const canonical = await (await page.request.get(contentUrl)).json();
    for (const token of [firstToken.trim(), secondToken.trim()])
      expect(canonical.plain_text.split(token).length - 1).toBe(1);

    // A fresh contender still cannot acquire the lease after recovery.
    let postRestartContenderRejected = false;
    try {
      compose(["run", "--rm", "--no-deps", "collab"]);
    } catch (error: any) {
      postRestartContenderRejected = true;
      const stderr = String(error?.stderr || error?.message || "");
      expect(stderr).toContain("Only one collaboration writer is supported");
    }
    expect(postRestartContenderRejected).toBe(true);
  } finally {
    // Leave the shared deployed acceptance stack healthy for subsequent gates.
    try { compose(["start", "collab"]); } catch {}
    await waitForCollabHealth();
    await secondContext.close();
  }
});


test("W19 deleted page fails closed for an offline draft instead of resurrecting content", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_WAVE_R_HARNESS !== "1",
    "W19 structural-delete acceptance runs only in the deployed Wave R step",
  );
  test.setTimeout(210000);

  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "W19 structural delete " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const resourceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W19 deleted during outage " + Date.now(),
    },
  });
  expect(resourceResponse.ok(), await resourceResponse.text()).toBeTruthy();
  const resource = await resourceResponse.json();
  const url = "/?page=" + resource.id;

  await page.goto(url);
  const ownerEditor = page.locator(".bn-editor");
  await expect(ownerEditor).toBeVisible();

  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await login(peer);
    await peer.goto(url);
    const peerEditor = peer.locator(".bn-editor");
    await expect(peerEditor).toBeVisible();

    // Confirmed transport loss before the offline mutation, as in W18.
    compose(["stop", "collab"]);
    await expect(
      page.getByRole("status").filter({ hasText: "Offline" }),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      peer.getByRole("status").filter({ hasText: "Offline" }),
    ).toBeVisible({ timeout: 20000 });

    const offlineToken = " OFFLINE_AFTER_DELETE_" + Date.now();
    await peerEditor.click();
    await peer.keyboard.press("ControlOrMeta+End");
    await peer.keyboard.insertText(offlineToken);
    await expect
      .poll(
        async () =>
          peer.evaluate(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("workspace-recovery:v1:"),
            ),
          ),
        { timeout: 10000 },
      )
      .toBe(true);

    // Structural deletion while the peer cannot receive live updates.
    const deleted = await page.request.delete(
      "/api/v1/resources/" + resource.id,
      {
        headers,
      },
    );
    expect(deleted.ok(), await deleted.text()).toBeTruthy();

    compose(["start", "collab"]);
    await waitForCollabHealth();

    // Reconnect must fail closed: the denied room ticket clears the recovery
    // draft, the stale editor is removed, and the deletion is never
    // resurrected by replayed collaboration state.
    await expect
      .poll(
        async () =>
          peer.evaluate(
            () =>
              Object.keys(localStorage).filter((key) =>
                key.startsWith("workspace-recovery:v1:"),
              ).length,
          ),
        { timeout: 30000 },
      )
      .toBe(0);
    await expect(peer.locator(".bn-editor")).toHaveCount(0, { timeout: 30000 });
    const check = await page.request.get("/api/v1/resources/" + resource.id);
    expect(check.status()).toBe(404);
    await expect(
      peer.getByText("Unsaved changes are available from this device.", {
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    try {
      compose(["start", "collab"]);
    } catch {}
    await waitForCollabHealth();
    await peerContext.close();
  }
});

test("W19 history restore converges reconnecting clients and drafts stay room-scoped", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.E2E_WAVE_R_HARNESS !== "1",
    "W19 restore-during-reconnect acceptance runs only in the deployed Wave R step",
  );
  test.setTimeout(240000);

  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: roots[0].id,
      title: "W19 restore reconnect " + Date.now(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();

  const created = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W19 restore target " + Date.now(),
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const target = await created.json();
  const otherResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W19 unrelated room " + Date.now(),
    },
  });
  expect(otherResponse.ok(), await otherResponse.text()).toBeTruthy();
  const other = await otherResponse.json();
  const targetUrl = "/?page=" + target.id;
  const targetEndpoint = "/api/v1/pages/" + target.id + "/content";
  const v1Token = "W19-restore-v1-" + Date.now();
  const v2Token = " W19-restore-v2-" + Date.now();

  const peerContext = await browser.newContext();
  try {
    // Seed the restore target through the API so the version row exists
    // deterministically before any client opens the room.
    const seedBase = await (await page.request.get(targetEndpoint)).json();
    const seeded = await page.request.patch(targetEndpoint, {
      headers,
      data: {
        blocks: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            content: v1Token,
          },
        ],
        expected_revision: seedBase.revision,
      },
    });
    expect(seeded.ok(), await seeded.text()).toBeTruthy();

    // replaceDocument records the PRE-replace document as the version
    // snapshot (an undo point), so a second identical replacement is what
    // captures the v1 content as the newest restorable version.
    const seededAgain = await page.request.patch(targetEndpoint, {
      headers,
      data: {
        blocks: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            content: v1Token,
          },
        ],
        expected_revision: (await seeded.json()).revision,
      },
    });
    expect(seededAgain.ok(), await seededAgain.text()).toBeTruthy();

    await page.goto(targetUrl);
    const ownerEditor = page.locator(".bn-editor");
    await expect(ownerEditor).toBeVisible();
    const peer = await peerContext.newPage();
    await login(peer);
    await peer.goto(targetUrl);
    const peerEditor = peer.locator(".bn-editor");
    await expect(peerEditor).toBeVisible();

    await expect(ownerEditor).toContainText(v1Token);
    await expect(peerEditor).toContainText(v1Token);

    const stampedV2 = v2Token + " " + Date.now();
    await ownerEditor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(stampedV2);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(targetEndpoint);
          if (!response.ok()) return "";
          return (await response.json()).plain_text || "";
        },
        { timeout: 30000 },
      )
      .toContain(stampedV2.trim());
    await expect(peerEditor).toContainText(stampedV2.trim());

    // The recorded snapshot holding the v1 content is the pre-second-seed
    // replacement; the older row holds the pre-seed initial document.
    const secondRevision = (await seededAgain.json()).revision;
    const versions = await (
      await page.request.get("/api/v1/pages/" + target.id + "/versions")
    ).json();
    const v1 = versions.find(
      (candidate: any) => candidate.revision === secondRevision - 1,
    );
    expect(v1?.id).toBeTruthy();
    expect(versions).toHaveLength(2);
    const v1Snapshot = await (
      await page.request.get("/api/v1/pages/" + target.id + "/versions/" + v1.id)
    ).json();
    expect(JSON.stringify(v1Snapshot.blocks)).toContain(v1Token);

    // Cut the writer, then bring it back and restore the older version while
    // both clients are still re-establishing their sockets.
    compose(["stop", "collab"]);
    await expect(
      page.getByRole("status").filter({ hasText: "Offline" }),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      peer.getByRole("status").filter({ hasText: "Offline" }),
    ).toBeVisible({ timeout: 20000 });
    compose(["start", "collab"]);
    await waitForCollabHealth();

    const currentRevision = (
      await (await page.request.get(targetEndpoint)).json()
    ).revision;
    const restore = await page.request.post(
      "/api/v1/pages/" + target.id + "/versions/" + v1.id + "/restore",
      { headers, data: { expected_revision: currentRevision } },
    );
    expect(restore.ok(), await restore.text()).toBeTruthy();

    // Deterministic convergence on the restored canonical document: the v2
    // edit is superseded in every connected view, with no stale-authority
    // rewrite of the restored state.
    for (const editor of [ownerEditor, peerEditor]) {
      await expect(editor).toContainText(v1Token, { timeout: 45000 });
      await expect(editor).not.toContainText(v2Token.trim(), {
        timeout: 45000,
      });
    }
    const canonical = await (await page.request.get(targetEndpoint)).json();
    expect(canonical.plain_text).toContain(v1Token);
    expect(canonical.plain_text).not.toContain(v2Token.trim());

    // Room-scoped recovery: a draft left for the target page must surface
    // only there, never in the unrelated room, and is explicitly discarded.
    const draftToken = " W19-room-scoped-" + Date.now();
    compose(["stop", "collab"]);
    await expect(
      page.getByRole("status").filter({ hasText: "Offline" }),
    ).toBeVisible({ timeout: 20000 });
    await ownerEditor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(draftToken);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.startsWith("workspace-recovery:v1:"),
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    await page.close();
    await peer.close();
    compose(["start", "collab"]);
    await waitForCollabHealth();

    const unrelated = await peerContext.newPage();
    await unrelated.goto("/?page=" + other.id);
    const unrelatedEditor = unrelated.locator(".bn-editor");
    await expect(unrelatedEditor).toBeVisible({ timeout: 30000 });
    await expect(
      unrelated.getByText("Unsaved changes are available from this device.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(unrelatedEditor).not.toContainText(draftToken.trim());

    const back = await peerContext.newPage();
    await back.goto(targetUrl);
    await expect(
      back.getByText("Unsaved changes are available from this device.", {
        exact: true,
      }),
    ).toBeVisible();
    await back.getByRole("button", { name: "Discard draft" }).click();
    const afterDiscard = await back.request.get(targetEndpoint);
    expect((await afterDiscard.json()).plain_text).not.toContain(
      draftToken.trim(),
    );
  } finally {
    try {
      compose(["start", "collab"]);
    } catch {}
    await waitForCollabHealth();
    await peerContext.close();
  }
});
