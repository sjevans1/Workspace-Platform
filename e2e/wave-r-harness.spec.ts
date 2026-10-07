import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

const email = "browser@example.test";
const password = "browser-password-123";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  if (await page.getByRole("button", { name: "Sign in", exact: true }).isVisible()) {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Welcome back, Shane." }),
  ).toBeVisible();
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
