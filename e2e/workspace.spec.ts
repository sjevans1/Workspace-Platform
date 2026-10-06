import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const email = "browser@example.test",
  password = "browser-password-123";
// Subsequent sequential tests reuse the genuine authenticated session instead
// of exhausting the production per-IP login budget in a disposable CI host.
let cachedAuthCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

// Deployed tests share a single source IP behind Caddy. This is an
// acceptance isolation guard, NOT a rate-limit bypass: wait for the actual
// server budget to recover before opening another multi-user browser test.
// Production API limits and login-specific caps remain unchanged.
test.beforeEach(async ({ request }) => {
  test.setTimeout(240000);
  for (let attempt = 0; attempt < 26; attempt++) {
    const response = await request.get("/api/v1/auth/methods");
    const raw = response.headers()["x-ratelimit-remaining"];
    const remaining = raw === undefined ? NaN : Number(raw);
    if (response.ok() && Number.isFinite(remaining) && remaining >= 260) return;
    if (attempt === 25)
      throw new Error("Shared test rate-limit window did not replenish");
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
  }
});

async function ensurePrincipalReadBudget(
  page: Page,
  minimum = 160,
) {
  // Authenticated GETs are limited by tenant+principal, not by the shared
  // Caddy/IP bucket checked in beforeEach. The owner session is intentionally
  // reused across this long sequential suite, so heavy multi-principal tests
  // must wait for that real principal budget rather than misreading a 429 as
  // missing collaboration state.
  for (let attempt = 0; attempt < 26; attempt++) {
    const response = await page.request.get("/api/v1/me");
    const raw = response.headers()["x-ratelimit-remaining"];
    const remaining = raw === undefined ? NaN : Number(raw);
    if (response.ok() && Number.isFinite(remaining) && remaining >= minimum)
      return;
    if (attempt === 25) {
      throw new Error(
        `Authenticated principal rate-limit budget did not replenish; status=${response.status()} remaining=${raw ?? "missing"}`,
      );
    }
    const retryAfter = Number(response.headers()["retry-after"]);
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(60, retryAfter + 1)
      : 5;
    await page.waitForTimeout(delay * 1000);
  }
}

async function login(page: Page, reuseSession = true) {
  if (reuseSession && cachedAuthCookies.length)
    await page.context().addCookies(cachedAuthCookies);
  await page.goto("/");
  // Deployed browser tests intentionally retain production request limits.
  // An exhausted shared CI-IP limit may temporarily show the new recovery
  // notice instead of a sign-in/Workspace heading. Respect Retry-After rather
  // than disabling security or mistaking a 429 for invalid credentials.
  const heading = page.locator("h1");
  const retry = page.getByRole("button", { name: "Retry loading workspace" });
  await expect.poll(async () =>
    (await heading.isVisible()) || (await retry.isVisible())
  ).toBe(true);
  for (let attempt = 0; attempt < 2 && await retry.isVisible(); attempt++) {
    const notice = await page.getByRole("alert")
      .filter({ hasText: "Workspace connection interrupted" }).innerText();
    const explicit = notice.match(/retry after (\d+) seconds?/i);
    const delay = explicit ? Number(explicit[1]) : 60;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(60);
    await page.waitForTimeout((delay + 2) * 1000);
    await retry.click();
    await expect.poll(async () =>
      (await heading.isVisible()) || (await retry.isVisible())
    ).toBe(true);
  }
  await expect(heading).toBeVisible();
  if (
    await page
      .getByRole("heading", { name: "Make yourself at home." })
      .isVisible()
  ) {
    await page
      .getByLabel("Setup token", { exact: true })
      .fill(process.env.E2E_SETUP_TOKEN || "e2e-setup-token");
    await page.getByLabel("Organisation", { exact: true }).fill("OpenJM");
    await page.getByLabel("Workspace", { exact: true }).fill("Team workspace");
    await page.getByLabel("Your name", { exact: true }).fill("Shane Evans");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
  } else if (
    await page.getByRole("button", { name: "Sign in", exact: true }).isVisible()
  ) {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Welcome back, Shane." }),
  ).toBeVisible();
  if (reuseSession)
    cachedAuthCookies = (await page.context().cookies())
      .filter((cookie) => cookie.name === "workspace_session");
}
// Distinct Chromium pages have independent DOM selections, but a click in
// another page can blur a ProseMirror editor before keyboard input is sent.
// For collaboration *engine* races, explicitly anchor each browser's caret
// to the intended quote immediately before that browser types. UI pointer
// behavior has separate browser tests; this helper does not suppress any
// unexpected data movement and canonical block identity is still asserted.
async function typeAtQuoteEdge(page: Page, edge: "start" | "end", token: string) {
  const quote=page.locator(".bn-editor blockquote");
  await expect(quote).toBeVisible();
  await quote.evaluate((node,where)=>{
    const element=node as HTMLElement;
    const root=element.closest<HTMLElement>(".bn-editor");
    if (!root) throw new Error("Quote is not inside the editor");
    root.focus();
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    const texts:Text[]=[];
    while(walker.nextNode())texts.push(walker.currentNode as Text);
    if(!texts.length)throw new Error("Quote has no text node");
    const text=where==="start"?texts[0]:texts[texts.length-1];
    const offset=where==="start"?0:text.length;
    const range=document.createRange();
    range.setStart(text,offset);
    range.collapse(true);
    const selection=window.getSelection();
    if(!selection)throw new Error("Selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    const anchor=selection.anchorNode;
    const host=anchor instanceof Element ? anchor : anchor?.parentElement;
    if(!host?.closest(".bn-editor blockquote"))
      throw new Error("Cannot anchor the caret to the intended quote");
  },edge);
  await page.keyboard.insertText(token);
}

// Anchor a rich-block caret immediately before typing to avoid Yjs awareness
// rebasing the ProseMirror selection between separate click/End calls.
async function typeAtRichBlockEnd(page: Page, selector: string, token: string) {
  const target=page.locator(selector);
  await expect(target).toBeVisible();
  await target.evaluate((node)=>{
    const element=node as HTMLElement;
    const root=element.closest<HTMLElement>(".bn-editor");
    if(!root)throw Error("Block is outside editor");
    root.focus();
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    const texts:Text[]=[];
    while(walker.nextNode()){
      const t=walker.currentNode as Text;
      if(t.textContent?.trim())texts.push(t);
    }
    if(!texts.length)throw Error("Rich block has no text");
    const last=texts[texts.length-1],range=document.createRange();
    range.setStart(last,last.length);
    range.collapse(true);
    const selection=window.getSelection();
    if(!selection)throw Error("Selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    if(!element.contains(selection.anchorNode))
      throw Error("Caret escaped intended rich block");
  });
  await page.keyboard.insertText(token);
}

test("Caddy strips spoofed forwarding headers before API rate limiting", async ({ request }) => {
  const first = await request.get("/api/v1/auth/methods", {
    headers: { "X-Forwarded-For": "203.0.113.17",
      "X-Real-IP": "203.0.113.17" },
  });
  const second = await request.get("/api/v1/auth/methods", {
    headers: { "X-Forwarded-For": "198.51.100.99",
      "X-Real-IP": "198.51.100.99" },
  });
  expect(first.ok()).toBeTruthy();
  expect(second.ok()).toBeTruthy();
  const before = Number(first.headers()["x-ratelimit-remaining"]);
  const after = Number(second.headers()["x-ratelimit-remaining"]);
  expect(Number.isFinite(before) && Number.isFinite(after)).toBeTruthy();
  expect(after).toBe(before - 1);
});

test("browser workflow: setup, live editing in two sessions, table/board, discussion, history, export and mobile", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/screenshots/home.png", fullPage: true });
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create something new" });
  const title = `Browser acceptance ${Date.now()}`;
  await dialog.getByLabel("Name", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
    title,
  );
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("Shared context survives a reload.");
  await expect(editor).toContainText("Shared context survives a reload.");
  await expect(
    page
      .getByRole("status", { name: "", exact: true })
      .filter({ hasText: "Saved" }),
  ).toBeVisible();
  const url = page.url();
  const id = new URL(url).searchParams.get("page");
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/pages/${id}/content`);
      expect(response.ok()).toBeTruthy();
      return (await response.json()).plain_text;
    })
    .toContain("Shared context survives a reload.");

  const second = await browser.newContext();
  const other = await second.newPage();
  await login(other, false);
  await other.goto(url);
  await expect(other.locator(".bn-editor")).toContainText(
    "Shared context survives a reload.",
  );
  await other.locator(".bn-editor").click();
  await other.keyboard.press("ControlOrMeta+End");
  await other.keyboard.type(" Both editors can contribute.");
  await expect(editor).toContainText("Both editors can contribute.");
  await expect(
    other.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/editor.png",
    fullPage: true,
  });
  await second.close();
  await page.reload();
  await expect(page.locator(".bn-editor")).toContainText(
    "Both editors can contribute.",
  );
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const discussion = page.getByRole("dialog", { name: "Discussion" });
  await discussion
    .getByPlaceholder("Add a thoughtful comment…")
    .fill("Reviewed in the browser.");
  await discussion
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(
    discussion.getByText("Reviewed in the browser.", { exact: true }),
  ).toBeVisible();
  await discussion.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Page actions" }).click();
  await page
    .getByRole("button", { name: "Version history", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Version history" })
      .getByText("Revision 1", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  const exported = await page.request.get(
    `/api/v1/resources/${id}/export?format=markdown`,
  );
  expect(exported.ok()).toBeTruthy();
  expect(await exported.text()).toContain("Both editors can contribute.");
  await page.getByRole("button", { name: "Search anything" }).click();
  const search = page.getByRole("dialog", { name: "Search your workspace" });
  await search
    .getByPlaceholder("Find pages, projects, or files…")
    .fill("Team tasks");
  await search.getByRole("option").filter({ hasText: "Team tasks" }).click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
    "Team tasks",
  );
  await expect(page.getByRole("table")).toBeVisible();
  const newTask = `Browser task ${Date.now()}`;
  await page
    .getByRole("button", { name: "New record", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill(newTask);
  await page.getByRole("button", { name: "Create record" }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.locator(`input[value="${newTask}"]`) });
  await row.getByLabel("Status", { exact: true }).selectOption("In progress");
  await expect(row.getByLabel("Status", { exact: true })).toHaveValue(
    "In progress",
  );
  await page.screenshot({ path: "docs/screenshots/table.png", fullPage: true });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(
    page.locator(".board-card").filter({ hasText: newTask }),
  ).toBeVisible();
  await page
    .locator(".board-card")
    .filter({ hasText: newTask })
    .getByLabel("Status", { exact: true })
    .selectOption("Done");
  await expect(
    page
      .locator(".board-column")
      .filter({ has: page.locator("header strong", { hasText: "Done" }) })
      .getByText(newTask, { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/board.png", fullPage: true });
  // Calendar view shares the same saved permissions and database record model.
  const browserNow = new Date();
  const dateInMonth =
    browserNow.getFullYear() + "-" +
    String(browserNow.getMonth() + 1).padStart(2, "0") + "-15";
  const taskCard = page.locator(".board-card").filter({ hasText: newTask });
  await taskCard.getByLabel("Due date", { exact: true }).fill(dateInMonth);
  await taskCard.getByLabel("Due date", { exact: true }).press("Tab");
  await expect(taskCard.getByLabel("Due date", { exact: true })).toHaveValue(dateInMonth);
  // Board inputs persist on blur. Confirm the authoritative database value,
  // not merely the input's optimistic DOM value, before switching views.
  const calendarDatabaseId = new URL(page.url()).searchParams.get("page");
  expect(calendarDatabaseId).toBeTruthy();
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/v1/databases/${calendarDatabaseId}/records?limit=100`,
    );
    if (!response.ok()) return "not-yet-saved";
    const entries = (await response.json()) as Array<{
      title: string;
      values: Record<string, unknown>;
    }>;
    return String(entries.find((row) => row.title === newTask)?.values.due || "");
  }, { timeout: 20000 }).toBe(dateInMonth);
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  const calendarEvent = page.locator(".calendar-event").filter({ hasText: newTask });
  await expect(calendarEvent).toBeVisible();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(calendarEvent).toHaveCount(0);
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(calendarEvent).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/calendar.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const closeSidebar = page.getByRole("button", {
    name: "Close sidebar",
    exact: true,
  });
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back, Shane." }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test("admin can create and revoke a SCIM connector from Settings", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Settings & members", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Settings & members", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Directory provisioning (SCIM 2.0)",
      exact: true,
    }),
  ).toBeVisible();

  const label = `Browser SCIM ${Date.now()}`;
  await page
    .getByRole("button", { name: "Create SCIM connector", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Create SCIM connector" });
  await create.getByLabel("Name", { exact: true }).fill(label);
  await create.getByLabel("Default provisioned role").selectOption("guest");
  await create.getByRole("button", { name: "Create scim", exact: true }).click();

  const secret = page.getByRole("dialog", { name: "Keep this somewhere safe" });
  const value = await secret
    .getByLabel("Created credential or invitation")
    .inputValue();
  expect(value).toContain("SCIM base URL:");
  expect(value).toContain("Default role: guest");
  const token = value.match(/Bearer token: (scim_[A-Za-z0-9_-]+)/)?.[1];
  expect(token).toBeTruthy();

  const discovery = await page.request.get("/scim/v2/ServiceProviderConfig", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(discovery.ok()).toBeTruthy();
  expect(discovery.headers()["content-type"]).toContain("application/scim+json");

  const directoryEmail = `browser-directory-${randomUUID()}@example.test`;
  const createdUserResponse = await page.request.post("/scim/v2/Users", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/scim+json",
    },
    data: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: directoryEmail,
      displayName: "Browser Directory User",
      emails: [{ value: directoryEmail, primary: true }],
      active: true,
    },
  });
  expect(createdUserResponse.status()).toBe(201);
  const directoryUser = await createdUserResponse.json();

  const groupName = `Browser Directory Group ${randomUUID().slice(0, 8)}`;
  const createdGroupResponse = await page.request.post("/scim/v2/Groups", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/scim+json",
    },
    data: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: groupName,
      members: [{ value: directoryUser.id }],
    },
  });
  expect(createdGroupResponse.status()).toBe(201);

  await secret.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Settings & members", exact: true })
    .click();
  await page.getByRole("button", { name: "Integrations", exact: true }).click();

  const groupRole = page.getByLabel(`Role mapping for ${groupName}`, {
    exact: true,
  });
  await expect(groupRole).toHaveValue("");
  await groupRole.selectOption("member");
  await expect(groupRole).toHaveValue("member");
  let directoryMembers = await (
    await page.request.get("/api/v1/members")
  ).json();
  expect(
    directoryMembers.find((item: any) => item.email === directoryEmail)?.role,
  ).toBe("member");

  await groupRole.selectOption("");
  await expect(groupRole).toHaveValue("");
  directoryMembers = await (await page.request.get("/api/v1/members")).json();
  expect(
    directoryMembers.find((item: any) => item.email === directoryEmail)?.role,
  ).toBe("guest");

  const row = page.locator(".integration-row").filter({ hasText: label });
  await expect(row).toContainText("Default role: guest");
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row).toContainText("Revoked");

  const rejected = await page.request.get("/scim/v2/ServiceProviderConfig", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(rejected.status()).toBe(401);
});

test("owner registers and revokes an inert tenant IdP through Settings without leaking the secret", async ({
  page,
}) => {
  await login(page);
  const previousMethods = await (await page.request.get("/api/v1/auth/methods")).json();

  await page.getByRole("button", { name: "Settings & members", exact: true }).click();
  await page.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Single sign-on provider registrations" }),
  ).toBeVisible();

  const label = "Browser IdP " + randomUUID().slice(0, 8);
  const clientSecret = "ci-test-oidc-secret-" + randomUUID();
  const registration = page.getByRole("button", { name: "Register identity provider" });
  await registration.click();
  const modal = page.getByRole("dialog", { name: "Register identity provider" });
  await modal.getByLabel("Name", { exact: true }).fill(label);
  await modal.getByLabel("Issuer URL (HTTPS)").fill("https://login.example.test/realm-e2e");
  await modal.getByLabel("Client ID", { exact: true }).fill("workspace-browser-client");
  await modal.getByLabel("Token endpoint authentication").selectOption("client_secret_post");
  await modal.getByLabel("Client secret (stored encrypted)").fill(clientSecret);
  await modal.getByRole("button", { name: "Register provider" }).click();
  await expect(modal).toBeHidden();

  const row = page.locator(".integration-row").filter({ hasText: label });
  await expect(row).toContainText("Registered — sign-in disabled");
  await expect(row).toContainText("client_secret_post");
  expect(await page.locator("body").innerText()).not.toContain(clientSecret);
  const apiResponse = await page.request.get("/api/v1/identity/providers");
  expect(apiResponse.status()).toBe(200);
  const raw = await apiResponse.text();
  expect(raw).not.toContain("client_secret_encrypted");
  expect(raw).not.toContain(clientSecret);
  const providers = JSON.parse(raw);
  const idp = providers.find((p: any) => p.label === label);
  expect(idp.enabled).toBe(false);
  expect(idp.client_id).toBe("workspace-browser-client");
  expect(idp.revoked_at).toBeNull();

  await row.getByRole("button", { name: "Revoke identity provider " + label }).click();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke identity provider " + label })).toHaveCount(0);
  const after = await (await page.request.get("/api/v1/identity/providers")).json();
  expect(after.find((p: any) => p.id === idp.id).revoked_at).toBeTruthy();
  expect(await (await page.request.get("/api/v1/auth/methods")).json()).toEqual(previousMethods);
});

test("admin can requeue only a dead delivery on an active webhook in Settings", async ({
  page,
}) => {
  await login(page);
  const subscriptionId = randomUUID();
  const pausedSubscriptionId = randomUUID();
  const deliveryId = randomUUID();
  const pausedDeliveryId = randomUUID();
  const deliveredId = randomUUID();
  const eventId = randomUUID();
  let status = "dead";
  let replayRequests = 0;
  let csrfPresent = false;

  await page.route("**/api/v1/webhooks/deliveries/*/replay", async (route) => {
    replayRequests++;
    csrfPresent = Boolean(route.request().headers()["x-csrf-token"]);
    expect(route.request().method()).toBe("POST");
    expect(route.request().url()).toContain(deliveryId);
    status = "pending";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, id: deliveryId, status }),
    });
  });
  await page.route("**/api/v1/webhooks", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subscriptions: [
          { id: subscriptionId, url: "https://events.example.test/inbox", active: true, events: ["page.updated"] },
          { id: pausedSubscriptionId, url: "https://events.example.test/paused", active: false, events: ["page.updated"] },
        ],
        deliveries: [
          { id: deliveryId, event_id: eventId, subscription_id: subscriptionId, status, attempts: status === "dead" ? 8 : 0, last_error: status === "dead" ? "HTTP 503" : null },
          { id: pausedDeliveryId, event_id: randomUUID(), subscription_id: pausedSubscriptionId, status: "dead", attempts: 8, last_error: "HTTP 502" },
          { id: deliveredId, event_id: randomUUID(), subscription_id: subscriptionId, status: "delivered", attempts: 1, last_error: null },
        ],
      }),
    });
  });
  await page.getByRole("button", { name: "Settings & members", exact: true }).click();
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const replay = page.getByRole("button", { name: "Replay delivery " + deliveryId });
  await expect(replay).toBeVisible();
  await expect(page.getByText("Subscription paused")).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay delivery " + pausedDeliveryId })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replay delivery " + deliveredId })).toHaveCount(0);
  await replay.click();
  await expect(replay).toHaveCount(0);
  expect(replayRequests).toBe(1);
  expect(csrfPresent).toBe(true);
});

test("owner prepares, activates and discards webhook signing secrets through deployed Settings", async ({
  page,
}) => {
  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const url = "https://events.example.test/rotation-" + randomUUID();
  const created = await page.request.post("/api/v1/webhooks", {
    headers,
    data: { url, events: ["integration.rotation_probe"] },
  });
  expect(created.status()).toBe(200);
  const subscription = await created.json();
  await page
    .getByRole("button", { name: "Settings & members", exact: true })
    .click();
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const row = page.locator(".integration-row").filter({ hasText: url });
  const prepare = row.getByRole("button", {
    name: "Prepare signing secret for " + url,
  });
  await prepare.click();
  const secretModal = page.getByRole("dialog", {
    name: "Keep this somewhere safe",
  });
  const credential = await secretModal
    .getByRole("textbox", { name: "Created credential or invitation" })
    .inputValue();
  const secret = credential.match(/Prepared signing secret: (\S+)/)?.[1];
  expect(secret).toBeTruthy();
  expect(secret).not.toBe(subscription.secret);
  await secretModal.getByRole("button", { name: "Close dialog" }).click();
  await expect(row).toContainText("New signing secret prepared");
  expect(await page.locator("body").innerText()).not.toContain(secret!);
  const list = await page.request.get("/api/v1/webhooks");
  const listing = await list.text();
  expect(listing).not.toContain(secret!);
  expect(listing).not.toContain(subscription.secret);
  expect(listing).not.toContain("secret_encrypted");
  expect(
    JSON.parse(listing).subscriptions.find((h: any) => h.id === subscription.id)
      .signing_revision,
  ).toBe(2);
  await row
    .getByRole("button", { name: "Activate signing secret for " + url })
    .click();
  const activation = page.getByRole("dialog", {
    name: "Activate webhook signing secret",
  });
  await expect(activation).toContainText("after configuring your receiver");
  await activation
    .getByRole("button", { name: "Receiver ready — activate secret" })
    .click();
  await expect(activation).toBeHidden();
  await expect(row).toContainText("Current signing secret active");
  let state = await (await page.request.get("/api/v1/webhooks")).json();
  expect(
    state.subscriptions.find((h: any) => h.id === subscription.id)
      .signing_revision,
  ).toBe(3);
  await prepare.click();
  await expect(secretModal).toBeVisible();
  await secretModal.getByRole("button", { name: "Close dialog" }).click();
  await row
    .getByRole("button", { name: "Discard prepared secret for " + url })
    .click();
  await expect(row).toContainText("Current signing secret active");
  state = await (await page.request.get("/api/v1/webhooks")).json();
  expect(
    state.subscriptions.find((h: any) => h.id === subscription.id)
      .signing_revision,
  ).toBe(5);
  await row.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
});

test("distinct users: invitation, live view-only access, revocation and recovery", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const owner = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": owner.csrf };
  const invitation = await page.request.post("/api/v1/members/invite", {
    headers,
    data: {
      name: "Browser Teammate",
      email: `teammate-${randomUUID()}@example.test`,
      role: "member",
    },
  });
  expect(invitation.ok()).toBeTruthy();
  const context = await browser.newContext();
  try {
    const teammate = await context.newPage();
    teammate.on("pageerror", (error) => errors.push(error.message));
    await teammate.goto((await invitation.json()).url);
    await expect(
      teammate.getByRole("heading", { name: "Join your team." }),
    ).toBeVisible();
    await expect
      .poll(() => new URL(teammate.url()).search)
      .toBe("");
    await teammate
      .getByLabel("Password", { exact: true })
      .fill("teammate-password-123");
    await teammate
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(
      teammate.getByRole("heading", { name: "Welcome back, Browser." }),
    ).toBeVisible();
    const member = await (await teammate.request.get("/api/v1/me")).json();
    expect(member.user.id).not.toBe(owner.user.id);
    expect(member.user.role).toBe("member");

    const roots = await (await page.request.get("/api/v1/resources")).json();
    const spaceResponse = await page.request.post("/api/v1/resources", {
      headers,
      data: {
        kind: "space",
        title: "Access evaluation",
        parent_id: roots[0].id,
      },
    });
    expect(spaceResponse.ok()).toBeTruthy();
    const space = await spaceResponse.json();
    const title = `Access evidence ${randomUUID()}`;
    const documentResponse = await page.request.post("/api/v1/resources", {
      headers,
      data: { kind: "page", title, parent_id: space.id },
    });
    expect(documentResponse.ok()).toBeTruthy();
    const document = await documentResponse.json();
    const url = `/?page=${document.id}`;
    await page.goto(url);
    const editor = page.locator(".bn-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("Shared access evidence.");
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/v1/pages/${document.id}/content`)
            ).json()
          ).plain_text,
      )
      .toContain("Shared access evidence.");
    await teammate.goto(url);
    const otherEditor = teammate.locator(".bn-editor");
    await expect(otherEditor).toContainText("Shared access evidence.");
    await otherEditor.click();
    await teammate.keyboard.press("ControlOrMeta+End");
    await teammate.keyboard.type(" Teammate contribution.");
    await expect(editor).toContainText("Teammate contribution.");
    await expect(
      teammate.getByRole("status").filter({ hasText: "Saved" }),
    ).toBeVisible();

    const upload = await page.request.post(
      `/api/v1/resources/${document.id}/files`,
      {
        headers,
        multipart: {
          file: {
            name: "private-evidence.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Private attachment evidence"),
          },
        },
      },
    );
    expect(upload.ok()).toBeTruthy();
    const file = await upload.json();

    const beforeMalware = await (
      await page.request.get(`/api/v1/resources/${document.id}/files`)
    ).json();
    const eicar = [
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EI",
      "CAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    ].join("");
    const blockedUpload = await page.request.post(
      `/api/v1/resources/${document.id}/files`,
      {
        headers,
        multipart: {
          file: {
            name: "eicar.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(eicar),
          },
        },
      },
    );
    expect(blockedUpload.status()).toBe(422);
    expect(await blockedUpload.json()).toMatchObject({
      error: "File rejected by malware scanner",
    });
    const afterMalware = await (
      await page.request.get(`/api/v1/resources/${document.id}/files`)
    ).json();
    expect(afterMalware).toHaveLength(beforeMalware.length);
    expect(afterMalware.some((item: any) => item.name === "eicar.txt")).toBe(
      false,
    );

    const readable = await teammate.request.get(file.url);
    expect(readable.ok()).toBeTruthy();
    expect(await readable.text()).toBe("Private attachment evidence");
    expect(readable.headers()["cache-control"]).toBe("no-store");

    // Change access in the owner UI while the teammate's editor is still open.
    await page.getByRole("button", { name: "Page actions" }).click();
    await page
      .getByRole("button", { name: "Manage access", exact: true })
      .click();
    const access = page.getByRole("dialog", { name: "Manage access" });
    await expect(
      access.getByText("Your access: 4.", { exact: false }),
    ).toBeVisible();
    await access
      .getByRole("button", { name: "Add person or integration" })
      .click();
    await access
      .getByLabel("Principal", { exact: true })
      .selectOption(member.user.id);
    await access.getByLabel("Access level", { exact: true }).selectOption("1");
    await access
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(access).toBeHidden();
    await expect(otherEditor).toHaveAttribute("contenteditable", "false");
    await expect(teammate.getByRole("toolbar",{name:"Formatting"}))
      .toHaveCount(0);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Owner update remains visible.");
    await expect(otherEditor).toContainText("Owner update remains visible.");
    const deniedEdit = await teammate.request.post(
      `/api/v1/resources/${document.id}/comments`,
      {
        headers: { "X-CSRF-Token": member.csrf },
        data: { body: "Viewers cannot comment" },
      },
    );
    expect(deniedEdit.status()).toBe(403);

    await page.getByRole("button", { name: "Page actions" }).click();
    await page
      .getByRole("button", { name: "Manage access", exact: true })
      .click();
    await expect(
      access.getByLabel("Access level", { exact: true }),
    ).toHaveValue("1");
    await access.getByLabel("Access level", { exact: true }).selectOption("3");
    await access
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(access).toBeHidden();
    await expect(otherEditor).toHaveAttribute("contenteditable", "true");
    await expect(teammate.getByRole("toolbar",{name:"Formatting"}))
      .toBeVisible();

    await page.getByRole("button", { name: "Page actions" }).click();
    await page
      .getByRole("button", { name: "Manage access", exact: true })
      .click();
    await expect(
      access.getByLabel("Access level", { exact: true }),
    ).toHaveValue("3");
    await access.getByRole("button", { name: "Remove grant" }).click();
    await access.getByLabel("Inherit access from parent").uncheck();
    await access
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(access).toBeHidden();
    await expect(otherEditor).toHaveCount(0);
    await expect(
      teammate.getByText("Teammate contribution.", { exact: false }),
    ).toHaveCount(0);
    await expect(
      teammate.getByRole("status").filter({ hasText: "Unable to connect" }),
    ).toBeVisible();
    for (const route of [
      `/resources/${document.id}`,
      `/pages/${document.id}/content`,
      `/pages/${document.id}/versions`,
    ]) {
      expect((await teammate.request.get(`/api/v1${route}`)).status()).toBe(
        404,
      );
    }
    expect((await teammate.request.get(file.url)).status()).toBe(404);
    const hiddenSearch = await teammate.request.get("/api/v1/search", {
      params: { q: title },
    });
    expect(hiddenSearch.ok()).toBeTruthy();
    expect(await hiddenSearch.json()).toEqual([]);
    const ticket = await teammate.request.post(
      `/api/v1/pages/${document.id}/collab`,
      { headers: { "X-CSRF-Token": member.csrf }, data: {} },
    );
    expect(ticket.status()).toBe(404);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Owner-only update after revocation.");
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/v1/pages/${document.id}/content`)
            ).json()
          ).plain_text,
      )
      .toContain("Owner-only update after revocation.");
    await expect(
      teammate.getByText("Owner-only update after revocation.", {
        exact: false,
      }),
    ).toHaveCount(0);

    const recoveryPolicy = await (
      await page.request.get(
        `/api/v1/resources/${document.id}/permissions`,
      )
    ).json();
    const restored = await page.request.patch(
      `/api/v1/resources/${document.id}/permissions`,
      {
        headers,
        data: {
          inherit: true,
          grants: [],
          expected_revision: recoveryPolicy.revision,
        },
      },
    );
    expect(restored.ok()).toBeTruthy();
    await teammate.reload();
    await expect(otherEditor).toContainText(
      "Owner-only update after revocation.",
    );
    await expect(otherEditor).toHaveAttribute("contenteditable", "true");
    let download = await teammate.request.get(file.url);
    if (download.status() === 429) {
      const hint = Number(download.headers()["retry-after"] || 60);
      expect(hint).toBeGreaterThanOrEqual(0);
      expect(hint).toBeLessThanOrEqual(60);
      await page.waitForTimeout((hint + 2) * 1000);
      download = await teammate.request.get(file.url);
    }
    expect(download.ok(), `Attachment status: ${download.status()}`).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});


test("recoverable 429 and 503 bootstrap errors preserve authentication and allow manual recovery", async ({
  page,
}) => {
  test.setTimeout(180000);
  await login(page);
  // Capture the true /me answer independently of the temporarily blocked
  // resource list. This is not a signed-out or invalid-session scenario.
  await page.route("**/api/v1/resources", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: { "Retry-After": "4" },
      body: JSON.stringify({ error: "Too many requests" }),
    }),
  );
  const authenticated = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/me",
  );
  await page.reload();
  expect((await authenticated).status()).toBe(200);
  const failure = page.getByRole("alert").filter({
    hasText: "Workspace connection interrupted",
  });
  await expect(failure).toContainText("too many requests");
  await expect(failure).toContainText("4 seconds");
  await expect(page.getByRole("button", { name: "Settings & members" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);

  await page.unroute("**/api/v1/resources");
  await page.getByRole("button", { name: "Retry loading workspace" }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Welcome back, Shane." })).toBeVisible();

  // /me itself can temporarily fail, but this is not evidence of 401/403.
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporarily unavailable" }),
    }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({
    hasText: "Workspace connection interrupted",
  })).toContainText("Your session has not been signed out");
  await page.unroute("**/api/v1/me");
  await page.getByRole("button", { name: "Retry loading workspace" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back, Shane." })).toBeVisible();
});


test("standalone appearance: dark/light/system persists and editor remains mounted", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Settings & members", exact: true }).click();
  const preference = page.getByRole("combobox", { name: "Colour theme" });
  await expect(preference).toBeVisible();

  await preference.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  )).toBe("rgb(20, 32, 25)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Settings & members", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Colour theme" }))
    .toHaveValue("dark");

  await page.getByRole("button", { name: "New page", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create something new" });
  await dialog.getByLabel("Name", { exact: true })
    .fill("Appearance acceptance " + Date.now());
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveCSS("color", "rgb(227, 239, 232)");
  await editor.click();
  await page.keyboard.type("Theme switching preserves my document.");
  await expect(editor).toContainText("Theme switching preserves my document.");
  await expect(page.getByRole("status").filter({ hasText: "Saved" }))
    .toBeVisible();

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(editor).toContainText("Theme switching preserves my document.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".bn-editor"))
    .toContainText("Theme switching preserves my document.");

  await page.getByRole("button", { name: "Settings & members", exact: true }).click();
  await page.getByRole("combobox", { name: "Colour theme" })
    .selectOption("system");
  const preferredDark = await page.evaluate(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  await expect(page.locator("html"))
    .toHaveAttribute("data-theme", preferredDark ? "dark" : "light");
  await page.reload();
  await page.getByRole("button", { name: "Settings & members", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Colour theme" }))
    .toHaveValue("system");
});


test("users can link a page from the editor and follow its accessible backlink", async ({ page }) => {
  await login(page);
  async function makePage(title: string) {
    await page.getByRole("button", { name: "New page", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create something new" });
    await dialog.getByLabel("Name", { exact: true }).fill(title);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(title);
    const id = new URL(page.url()).searchParams.get("page");
    expect(id).toBeTruthy();
    return id!;
  }
  const suffix = Date.now();
  const targetName = "Linked destination " + suffix;
  const sourceName = "Linking source " + suffix;
  const targetId = await makePage(targetName);
  const sourceId = await makePage(sourceName);
  const editor = page.locator(".bn-editor");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.getByRole("button", { name: "Link to page" }).click();
  await page.getByRole("textbox", { name: "Find a page to link" }).fill(targetName);
  await page.locator("#page-link-picker").getByRole("button", { name: "Find" }).click();
  const result = page.locator(".page-link-results")
    .getByRole("button", { name: targetName, exact: true });
  await expect(result).toBeVisible();
  await result.click();
  await expect(editor).toContainText(targetName);
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/resources/" + targetId + "/backlinks");
    if (!response.ok()) return false;
    return (await response.json()).items.some((v: any) => v.id === sourceId);
  }, { timeout: 12000 }).toBe(true);
  await page.goto("/?page=" + targetId);
  await expect(page.getByRole("heading", { name: "Linked from", exact: true }))
    .toBeVisible();
  const backlink = page.locator(".backlink-items")
    .getByRole("button", { name: sourceName, exact: true });
  await expect(backlink).toBeVisible();
  // Simulate an authorization failure after the page has already displayed
  // a backlink. Focus-based refresh must remove the old private title.
  const deniedBacklinks="**/api/v1/resources/"+targetId+"/backlinks*";
  await page.route(deniedBacklinks,route=>route.fulfill({
    status:403,contentType:"application/json",
    body:JSON.stringify({error:"Access revoked"}),
  }));
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await expect(backlink).toHaveCount(0);
  await expect(page.getByText("Unable to load backlinks. Try refreshing.", { exact: true })).toBeVisible();
  await page.unroute(deniedBacklinks);
  await page.getByRole("button",{name:"Refresh links"}).click();
  await expect(backlink).toBeVisible();
  await backlink.click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(sourceName);
  const sourceEditor=page.locator(".bn-editor");
  await sourceEditor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  // Wait for the deletion itself to reach canonical persisted content. The
  // generic Saved indicator may still reflect the preceding edit.
  await expect.poll(async()=>{
    const response=await page.request.get("/api/v1/pages/"+sourceId+"/content");
    if(!response.ok())return false;
    return !JSON.stringify(await response.json()).includes(targetId);
  },{timeout:12000}).toBe(true);
  await expect.poll(async()=>{
    const response=await page.request.get(
      "/api/v1/resources/"+targetId+"/backlinks?limit=20",
    );
    if(!response.ok())return false;
    return !(await response.json()).items.some((v:any)=>v.id===sourceId);
  },{timeout:30000}).toBe(true);
});


test("W13c browser paginates backlinks and clears them on continuation failure", async ({ page }) => {
  await login(page);
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const workspace = roots.find((item:any)=>item.kind==="workspace") || roots[0];
  const headers = {
    "X-CSRF-Token": (await (await page.request.get("/api/v1/me")).json()).csrf,
  };
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "space",
      parent_id: workspace.id,
      title: "W13c pagination space " + randomUUID(),
    },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const targetResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: {
      kind: "page",
      parent_id: space.id,
      title: "W13c pagination target " + randomUUID(),
    },
  });
  expect(targetResponse.ok(), await targetResponse.text()).toBeTruthy();
  const target = await targetResponse.json();
  const firstId=randomUUID(), secondId=randomUUID();
  const routePattern="**/api/v1/resources/"+target.id+"/backlinks*";
  await page.route(routePattern,route=>{
    const url=new URL(route.request().url());
    const cursor=url.searchParams.get("cursor");
    if(!cursor)
      return route.fulfill({
        status:200,contentType:"application/json",
        body:JSON.stringify({
          items:[{
            id:firstId,title:"Paged backlink first",kind:"page",
            updated_at:new Date().toISOString(),
          }],
          next_cursor:"opaque-test-cursor",has_more:true,
        }),
      });
    return route.fulfill({
      status:200,contentType:"application/json",
      body:JSON.stringify({
        items:[{
          id:secondId,title:"Paged backlink second",kind:"page",
          updated_at:new Date().toISOString(),
        }],
        next_cursor:null,has_more:false,
      }),
    });
  });
  await page.goto("/?page="+target.id);
  await expect(page.getByRole("button",{name:"Paged backlink first",exact:true}))
    .toBeVisible();
  await page.getByRole("button",{name:"Load more links",exact:true}).click();
  await expect(page.getByRole("button",{name:"Paged backlink second",exact:true}))
    .toBeVisible();
  await expect(page.getByRole("button",{name:"Load more links",exact:true}))
    .toHaveCount(0);

  await page.unroute(routePattern);
  await page.route(routePattern,route=>route.fulfill({
    status:403,contentType:"application/json",
    body:JSON.stringify({error:"Access revoked"}),
  }));
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button",{name:"Paged backlink first",exact:true}))
    .toHaveCount(0);
  await expect(page.getByRole("button",{name:"Paged backlink second",exact:true}))
    .toHaveCount(0);
  await expect(page.getByText("Unable to load backlinks. Try refreshing.",{
    exact:true,
  })).toBeVisible();
  await page.unroute(routePattern);
});


test("Recent shows pages the signed-in user opened, not just modified pages", async ({ page }) => {
  await login(page);
  const name = "Personal recent browser " + Date.now();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create something new" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(name);
  // The open page records its own visit only after a successful resource load.
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/resources?recent=true");
    if (!response.ok()) return false;
    return (await response.json()).some((item: any) =>
      item.title === name && Boolean(item.viewed_at));
  }).toBe(true);
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recently viewed", level: 1 })).toBeVisible();
  await expect(page.locator(".page-card").filter({ hasText: name })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Recent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await expect(page.locator(".page-card").filter({ hasText: name })).toBeVisible();
});


test("W05 browser: configure relation, search permitted record, persist, navigate and remove", async ({ page }) => {
  await login(page);
  const self = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": self.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const create = async (kind: "space" | "database", parent_id: string, title: string) => {
    const response = await page.request.post("/api/v1/resources", {
      headers, data: { kind, parent_id, title },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const stamp = Date.now();
  const folder = await create("space", roots[0].id, "W05 relations " + stamp);
  const clients = await create("database", folder.id, "W05 Clients " + stamp);
  const projects = await create("database", folder.id, "W05 Projects " + stamp);
  const clientResponse = await page.request.post(
    `/api/v1/databases/${clients.id}/records`, {
      headers, data: { values: { name: "Island Foods Client " + stamp } },
    });
  expect(clientResponse.ok(), await clientResponse.text()).toBeTruthy();
  const client = await clientResponse.json();

  await page.goto("/?page=" + projects.id);
  await page.getByRole("button", { name: "Configure properties" }).click();
  const schema = page.getByRole("dialog", { name: "Properties & columns" });
  await expect(schema).toBeVisible();
  await schema.getByRole("button", { name: "Add property" }).click();
  await schema.getByRole("textbox", { name: "Property name" }).nth(1).fill("Client");
  await schema.getByRole("combobox", { name: "Property type" })
    .nth(1).selectOption("relation");
  await schema.getByRole("textbox", { name: "Search target databases" })
    .fill("W05 Clients " + stamp);
  const targetSelector = schema.getByRole("combobox", {
    name: "Related database for Client",
  });
  await expect(targetSelector.locator(`option[value="${clients.id}"]`)).toBeAttached();
  await targetSelector.selectOption(clients.id);
  await schema.getByRole("button", { name: "Save properties" }).click();
  await expect(schema).toBeHidden();

  const projectResponse = await page.request.post(
    `/api/v1/databases/${projects.id}/records`, {
      headers, data: { values: { name: "Falcon Project " + stamp } },
    });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json();
  await page.reload();
  const relation = page.getByRole("group", { name: "Client" });
  await expect(relation).toBeVisible();
  await relation.getByRole("button", { name: "Add related record for Client" }).click();
  await relation.getByRole("textbox", {
    name: "Search related records for Client",
  }).fill("Island Foods Client " + stamp);
  await relation.getByRole("button", {
    name: "Link record Island Foods Client " + stamp,
  }).click();
  const relationProperty = (await (await page.request.get(
    `/api/v1/databases/${projects.id}`)).json()).properties
    .find((p: any) => p.type === "relation");
  expect(relationProperty).toBeTruthy();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/records/${project.id}`);
    return (await response.json()).values[relationProperty.id];
  }).toEqual([client.id]);
  await page.reload();
  await page.getByRole("group", { name: "Client" })
    .getByRole("button", { name: "Open related record Island Foods Client " + stamp })
    .click();
  await expect(page.getByLabel("Page title", { exact: true }))
    .toHaveValue("Island Foods Client " + stamp);
  await page.goto("/?page=" + projects.id);
  await page.getByRole("group", { name: "Client" })
    .getByRole("button", { name: "Remove related record Island Foods Client " + stamp })
    .click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/records/${project.id}`);
    return (await response.json()).values[relationProperty.id];
  }).toEqual([]);
});


test("W06 browser: configure numeric formula, render computed result and recompute", async ({ page }) => {
  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  // Workspace resources permit databases inside spaces, not at the root.
  const folderResponse = await page.request.post("/api/v1/resources", {
    headers, data: { kind: "space", parent_id: roots[0].id,
      title: "W06 Formulas container " + Date.now() },
  });
  expect(folderResponse.ok(), await folderResponse.text()).toBeTruthy();
  const folder = await folderResponse.json();
  const create = await page.request.post("/api/v1/resources", {
    headers, data: { kind: "database", parent_id: folder.id,
      title: "W06 Formula " + Date.now() },
  });
  expect(create.ok(), await create.text()).toBeTruthy();
  const data = await create.json();
  const route = "/api/v1/databases/" + data.id;
  const numericFields = [
    { id: "name", name: "Name", type: "title" },
    { id: "units", name: "Units", type: "number" },
    { id: "price", name: "Price", type: "number" },
  ];
  const configured = await page.request.patch(route, {
    headers, data: { properties: numericFields },
  });
  expect(configured.ok(), await configured.text()).toBeTruthy();
  await page.goto("/?page=" + data.id);
  await page.getByRole("button", { name: "Configure properties" }).click();
  const dialog = page.getByRole("dialog", { name: "Properties & columns" });
  await dialog.getByRole("button", { name: "Add property" }).click();
  await dialog.getByRole("textbox", { name: "Property name" }).nth(3)
    .fill("Gross");
  await dialog.getByRole("combobox", { name: "Property type" }).nth(3)
    .selectOption("formula");
  const expression = dialog.getByRole("textbox",
    { name: "Gross formula expression" });
  await expression.fill("");
  await dialog.getByRole("button", { name: "Insert number field Units" }).click();
  await expect(expression).toHaveValue("[units]");
  await expression.fill("[units] * ");
  await dialog.getByRole("button", { name: "Insert number field Price" }).click();
  await expect(expression).toHaveValue("[units] * [price]");
  await expression.fill("[units] * [price] + 2");
  await dialog.getByRole("button", { name: "Save properties" }).click();
  await expect(dialog).toBeHidden();

  const createRecord = await page.request.post(route + "/records", {
    headers, data: { values: { name: "W06 Order", units: 3, price: 7 } },
  });
  expect(createRecord.ok(), await createRecord.text()).toBeTruthy();
  const row = await createRecord.json();
  const definition = await (await page.request.get(route)).json();
  const formula = definition.properties.find((p: any) => p.type === "formula");
  expect(formula.formula).toBe("[units] * [price] + 2");
  expect(row.values[formula.id]).toBe(23);
  await page.reload();
  await expect(page.locator("output.formula-result").first()).toHaveText("23");

  const patched = await page.request.patch("/api/v1/records/" + row.id, {
    headers, data: { expected_revision: row.revision, values: { price: 9 } },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  expect((await patched.json()).values[formula.id]).toBe(29);
  await page.reload();
  await expect(page.locator("output.formula-result").first()).toHaveText("29");
});


test("W07 browser: configure sum Rollup and recompute linked Number values", async ({ page }) => {
  await login(page);
  const actor = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": actor.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const create = async (kind: "space" | "database", parent: string, title: string) => {
    const response = await page.request.post("/api/v1/resources", {
      headers, data: { kind, parent_id: parent, title },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const stamp = Date.now();
  const folder = await create("space", roots[0].id, "W07 Rollups " + stamp);
  const clients = await create("database", folder.id, "W07 Clients " + stamp);
  const projects = await create("database", folder.id, "W07 Projects " + stamp);
  const targetPath = "/api/v1/databases/" + clients.id;
  const sourcePath = "/api/v1/databases/" + projects.id;
  const clientsSchema = await page.request.patch(targetPath, { headers, data: {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "revenue", name: "Revenue", type: "number" },
    ],
  } });
  expect(clientsSchema.ok(), await clientsSchema.text()).toBeTruthy();
  const clientResponse = await page.request.post(targetPath + "/records", {
    headers, data: { values: { name: "W07 Client " + stamp, revenue: 40 } },
  });
  expect(clientResponse.ok(), await clientResponse.text()).toBeTruthy();
  const client = await clientResponse.json();
  const initialSchema = await page.request.patch(sourcePath, { headers, data: {
    properties: [
      { id: "name", name: "Name", type: "title" },
      { id: "clients", name: "Clients", type: "relation",
        target_database_id: clients.id },
    ],
  } });
  expect(initialSchema.ok(), await initialSchema.text()).toBeTruthy();
  await page.goto("/?page=" + projects.id);
  await page.getByRole("button", { name: "Configure properties" }).click();
  const dialog = page.getByRole("dialog", { name: "Properties & columns" });
  await dialog.getByRole("button", { name: "Add property" }).click();
  await dialog.getByRole("textbox", { name: "Property name" }).nth(2)
    .fill("Linked revenue");
  await dialog.getByRole("combobox", { name: "Property type" }).nth(2)
    .selectOption("rollup");
  await dialog.getByRole("combobox",
    { name: "Rollup source relation for Linked revenue" })
    .selectOption("clients");
  await dialog.getByRole("combobox",
    { name: "Rollup operation for Linked revenue" })
    .selectOption("sum");
  const numeric = dialog.getByRole("combobox",
    { name: "Rollup numeric field for Linked revenue" });
  await expect(numeric.locator('option[value="revenue"]')).toBeAttached();
  await numeric.selectOption("revenue");
  await dialog.getByRole("button", { name: "Save properties" }).click();
  await expect(dialog).toBeHidden();
  const itemResponse = await page.request.post(sourcePath + "/records", {
    headers, data: {
      values: { name: "W07 Project " + stamp, clients: [client.id] },
    },
  });
  expect(itemResponse.ok(), await itemResponse.text()).toBeTruthy();
  const item = await itemResponse.json();
  const property = (await (await page.request.get(sourcePath)).json())
    .properties.find((p: any) => p.type === "rollup");
  expect(property).toBeTruthy();
  expect(item.values[property.id]).toBe(40);
  await page.reload();
  await expect(page.locator("output.rollup-result").first()).toHaveText("40");
  const change = await page.request.patch("/api/v1/records/" + client.id, {
    headers, data: {
      values: { revenue: 60 }, expected_revision: client.revision,
    },
  });
  expect(change.ok(), await change.text()).toBeTruthy();
  await page.reload();
  await expect(page.locator("output.rollup-result").first()).toHaveText("60");
});


test("W08 deployed browser: accessible database pages and ordered Relation candidate pages", async ({ page }) => {
  await login(page);
  const actor = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": actor.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const stamp = Date.now();
  const make = async (kind: "space" | "database", parent_id: string,
    title: string) => {
    const r = await page.request.post("/api/v1/resources", {
      headers, data: { kind, parent_id, title },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const folder = await make("space", roots[0].id, "W08 Browser " + stamp);
  const clients = await make("database", folder.id, "W08 Clients " + stamp);
  const projects = await make("database", folder.id, "W08 Projects " + stamp);
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await page.request.post(
      "/api/v1/databases/" + clients.id + "/records", {
        headers, data: { values: {
          name: "W08 Record " + String(i).padStart(2, "0") + " " + stamp,
        } },
      });
    expect(r.ok(), await r.text()).toBeTruthy();
    ids.push((await r.json()).id);
  }
  const props = await page.request.patch(
    "/api/v1/databases/" + projects.id, {
      headers, data: { properties: [
        { id: "name", name: "Name", type: "title" },
        { id: "clients", name: "Clients", type: "relation",
          target_database_id: clients.id },
      ] },
    });
  expect(props.ok(), await props.text()).toBeTruthy();

  const base = "/api/v1/databases/" + clients.id + "/records?limit=3";
  const first = await page.request.get(base + "&offset=0");
  const second = await page.request.get(base + "&offset=3");
  expect(first.ok() && second.ok()).toBeTruthy();
  expect((await first.json()).map((r: any) => r.id)).toEqual(ids.slice(0, 3));
  expect((await second.json()).map((r: any) => r.id)).toEqual(ids.slice(3, 6));

  const candidates = "/api/v1/databases/" + projects.id +
    "/relation-candidates?property=clients&limit=3";
  const p1 = await page.request.get(candidates + "&offset=0");
  const p2 = await page.request.get(candidates + "&offset=3");
  expect(p1.ok() && p2.ok()).toBeTruthy();
  const c1 = await p1.json(), c2 = await p2.json();
  expect(c1.items.map((r: any) => r.id)).toEqual(ids.slice(0, 3));
  expect(c1.has_more).toBe(true);
  expect(c2.items.map((r: any) => r.id)).toEqual(ids.slice(3, 6));
  expect(c2.has_more).toBe(true);
  const last = await page.request.get(candidates + "&offset=6");
  expect((await last.json()).items.map((r: any) => r.id)).toEqual(ids.slice(6));
  expect((await last.json()).has_more).toBe(false);

  await page.goto("/?page=" + clients.id);
  await expect(page.getByRole("button", {
    name: "Open record W08 Record 06 " + stamp,
  })).toBeVisible();
});


test("W08b deployed browser: encrypted cursor paging and Next/Previous round trip", async ({ page }) => {
  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const stamp = Date.now();
  const folderRequest = await page.request.post("/api/v1/resources", {
    headers, data: { kind: "space", parent_id: roots[0].id,
      title: "W08b Cursor " + stamp },
  });
  expect(folderRequest.ok(), await folderRequest.text()).toBeTruthy();
  const folder = await folderRequest.json();
  const dbRequest = await page.request.post("/api/v1/resources", {
    headers, data: { kind: "database", parent_id: folder.id,
      title: "W08b Paging " + stamp },
  });
  expect(dbRequest.ok(), await dbRequest.text()).toBeTruthy();
  const dataset = await dbRequest.json();
  const base = "/api/v1/databases/" + dataset.id + "/records";
  for (let i = 0; i < 102; i++) {
    const res = await page.request.post(base, {
      headers, data: { values: {
        name: "W08b Item " + String(i).padStart(3, "0") },
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const cursorPage = base + "/page?limit=2";
  const first = await page.request.get(cursorPage);
  expect(first.ok()).toBeTruthy();
  const a = await first.json();
  expect(a.items).toHaveLength(2);
  expect(a.has_more).toBe(true);
  expect(a.next_cursor).toMatch(/^db-page-v1\./);
  const next = await page.request.get(cursorPage +
    "&cursor=" + encodeURIComponent(a.next_cursor));
  expect(next.ok()).toBeTruthy();
  const b = await next.json();
  expect(b.items).toHaveLength(2);
  expect(b.items[0].id).not.toBe(a.items[1].id);
  const tampered = await page.request.get(cursorPage +
    "&cursor=" + encodeURIComponent(a.next_cursor + "!"));
  expect(tampered.status()).toBe(400);

  await page.goto("/?page=" + dataset.id);
  const table = page.locator(".record-table tbody tr");
  await expect(table).toHaveCount(100);
  const forward = page.getByRole("button", { name: "Next", exact: true });
  const backward = page.getByRole("button", { name: "Previous", exact: true });
  await expect(forward).toBeEnabled();
  await expect(backward).toBeDisabled();
  await forward.click();
  await expect(table).toHaveCount(2);
  await expect(backward).toBeEnabled();
  await expect(forward).toBeDisabled();
  await backward.click();
  await expect(table).toHaveCount(100);
  await expect(forward).toBeEnabled();

  // Reuse the real 102-row deployment fixture to verify that a saved
  // descending scalar sort uses keyset navigation rather than raw OFFSET.
  const sortedResponse = await page.request.post(
    "/api/v1/databases/" + dataset.id + "/views", {
      headers, data: {
        name: "Descending title W08c",
        config: { type: "table", filters: [], sort: [
          { property: "name", direction: "desc" },
        ] },
      },
    });
  expect(sortedResponse.ok(), await sortedResponse.text()).toBeTruthy();
  const savedSort = await sortedResponse.json();
  await page.reload();
  await page.getByRole("combobox", { name: "Saved view" })
    .selectOption(savedSort.id);
  await expect(table).toHaveCount(100);
  await expect(table.first().locator('input[aria-label="Name"]'))
    .toHaveValue("W08b Item 101");
  await forward.click();
  await expect(table).toHaveCount(2);
  await expect(table.first().locator('input[aria-label="Name"]'))
    .toHaveValue("W08b Item 001");
  await expect(table.last().locator('input[aria-label="Name"]'))
    .toHaveValue("W08b Item 000");
  await backward.click();
  await expect(table).toHaveCount(100);
  await expect(table.first().locator('input[aria-label="Name"]'))
    .toHaveValue("W08b Item 101");

  await expect(page.getByLabel("Live page consistency"))
    .toContainText("Live results may shift");
  await forward.click();
  await expect(table).toHaveCount(2);
  await page.getByRole("button", { name: "Refresh results" }).click();
  await expect(table).toHaveCount(100);
  await expect(backward).toBeDisabled();
  await expect(table.first().locator('input[aria-label="Name"]'))
    .toHaveValue("W08b Item 101");
});


test("W09 deployed browser: CSV preview suggests types, maps fields, and requires approval", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /Import your work/ }).click();
  const dialog = page.getByRole("dialog", { name: "Import your work" });
  await expect(dialog).toBeVisible();
  const content = "Name,Units,Due,Done,Notes\n" +
    'First,12,2026-10-01,true,"=HYPERLINK(1,2)"\n' +
    "Second,0,2026-10-02,false,ordinary\n";
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "preview.csv", mimeType: "text/csv",
    buffer: Buffer.from(content, "utf8"),
  });
  const commit = dialog.getByRole("button", { name: "Import", exact: true });
  await expect(commit).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview CSV columns" }).click();
  await expect(dialog.getByText(/2 data rows/)).toBeVisible();
  await expect(dialog.getByLabel("Type for Name")).toHaveValue("title");
  await expect(dialog.getByLabel("Type for Units")).toHaveValue("number");
  await expect(dialog.getByLabel("Type for Due")).toHaveValue("date");
  await expect(dialog.getByLabel("Type for Done")).toHaveValue("checkbox");
  await expect(dialog.getByText(/=HYPERLINK\(1,2\)/)).toBeVisible();
  await dialog.getByLabel("Import column Notes").uncheck();
  await dialog.getByLabel("Column name for Units").fill("Quantity");
  await expect(commit).toBeEnabled();
  // Changing destination invalidates the old permission-scoped preview.
  // The "Import" button is never enabled merely by uploading a file.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
});

test("W09b deployed browser requires explicit append-only target confirmation", async ({page}) => {
  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = {"X-CSRF-Token":me.csrf};
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const stamp=Date.now();
  const spaceRequest=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W09b CSV space "+stamp},
  });
  expect(spaceRequest.ok(),await spaceRequest.text()).toBeTruthy();
  const space=await spaceRequest.json();
  const dbRequest=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"database",parent_id:space.id,
      title:"W09b Existing Target "+stamp},
  });
  expect(dbRequest.ok(),await dbRequest.text()).toBeTruthy();
  const database=await dbRequest.json();
  await page.getByRole("button",{name:/Import your work/}).click();
  const dialog=page.getByRole("dialog",{name:"Import your work"});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Create in").selectOption(space.id);
  await dialog.locator('input[type="file"]').setInputFiles({
    name:"mapped-append.csv",mimeType:"text/csv",
    buffer:Buffer.from(["Name", "New item"].join(String.fromCharCode(10))),
  });
  const destination=dialog.getByLabel("Import destination mode");
  await expect(destination.locator(`option[value="${database.id}"]`)).toHaveCount(1);
  await destination.selectOption(database.id);
  const action=dialog.getByRole("button",{name:"Import",exact:true});
  await expect(action).toBeDisabled();
  await dialog.getByRole("button",{name:"Preview CSV columns"}).click();
  await expect(dialog.getByText(/1 data rows/)).toBeVisible();
  await expect(dialog.getByLabel("Target property for Name")).toHaveValue("name");
  await expect(action).toBeDisabled();
  await dialog.getByLabel("Confirm append-only import").check();
  await expect(action).toBeEnabled();
  // Exercise the complete deployed path: confirmed UI submission, queued
  // worker job, committed rows and navigation back to the existing target.
  await action.click();
  await expect(dialog).not.toBeVisible({ timeout: 90000 });
  const rowsResponse = await page.request.get(
    `/api/v1/databases/${database.id}/records`);
  expect(rowsResponse.ok(), await rowsResponse.text()).toBeTruthy();
  const rows = await rowsResponse.json();
  expect(rows).toHaveLength(1);
  expect(rows[0].values.name).toBe("New item");

  // W09c: the deployed HTTP endpoint returns the same durable job when an
  // acknowledgement is lost or a completed CSV request is retried.
  const csv = "Name\nRetry once\n";
  const previewResponse = await page.request.post("/api/v1/imports/preview",{
    headers,data:{parent_id:space.id,target_database_id:database.id,content:csv},
  });
  expect(previewResponse.ok(),await previewResponse.text()).toBeTruthy();
  const proposal = await previewResponse.json();
  const importBody = {
    parent_id:space.id,target_database_id:database.id,
    content:csv,format:"csv",name:"Browser replay job",
    mapping:proposal.mapping,
    expected_schema_digest:proposal.target.schema_digest,
    existing_mode:"append",idempotency_key:crypto.randomUUID(),
  };
  const send = async () => {
    const response=await page.request.post("/api/v1/imports",{
      headers,data:importBody,
    });
    expect(response.ok(),await response.text()).toBeTruthy();
    return response.json();
  };
  const first=await send();
  const duplicate=await send();
  expect(duplicate.id).toBe(first.id);
  await expect.poll(async () => {
    const res=await page.request.get("/api/v1/jobs/"+first.id);
    if (!res.ok()) return "unavailable";
    return (await res.json()).status;
  },{timeout:30000}).toBe("completed");
  const afterCompletion=await send();
  expect(afterCompletion).toEqual({id:first.id,status:"completed"});
  const afterRows=await page.request.get(
    `/api/v1/databases/${database.id}/records`);
  expect(afterRows.ok(),await afterRows.text()).toBeTruthy();
  expect((await afterRows.json())).toHaveLength(2);
});


test("W10a formatting toolbar creates persistent Core heading", async ({page}) => {
  await login(page);
  await page.getByRole("button",{name:"New page",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Create something new"});
  await dialog.getByLabel("Name",{exact:true}).fill("W10a rich editor");
  await dialog.getByRole("button",{name:"Create",exact:true}).click();
  // Creating a page is asynchronous; wait for the committed navigation
  // rather than reading the URL in the same browser turn as the click.
  await expect(page.getByLabel("Page title",{exact:true}))
    .toHaveValue("W10a rich editor");
  await expect.poll(() => new URL(page.url()).searchParams.get("page"))
    .not.toBeNull();
  const id=new URL(page.url()).searchParams.get("page");
  expect(id).toBeTruthy();
  const editable=page.locator(".bn-editor");
  await expect(editable).toBeVisible();
  const toolbar=page.getByRole("toolbar",{name:"Formatting"});
  await expect(toolbar.getByRole("button",{name:"Bold selection"})).toBeVisible();
  await expect(toolbar.getByRole("button",{name:"Italic selection"})).toBeVisible();
  await editable.click();
  await page.keyboard.type("W10a heading persists");
  await toolbar.getByRole("button",{name:"Heading 2"}).click();
  await expect.poll(async()=>{
    const res=await page.request.get(`/api/v1/pages/${id}/content`);
    if(!res.ok())return "not-ready";
    const content=await res.json();
    return content.blocks?.find((b:any)=>b.type==="heading")?.props?.level === 2
      ? "heading-2" : "pending";
  },{timeout:20000}).toBe("heading-2");
  await page.reload();
  await expect(page.getByRole("toolbar",{name:"Formatting"})).toBeVisible();
  await expect(page.locator(".bn-editor")).toContainText("W10a heading persists");
  await expect(page.locator(".bn-editor h2")).toContainText("W10a heading persists");
});


test("W10b callout and divider sync across two users and survive reload", async ({page,browser}) => {
  test.setTimeout(90000);
  await login(page);
  await page.getByRole("button",{name:"New page",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Create something new"});
  await dialog.getByLabel("Name",{exact:true}).fill("W10b shared custom blocks");
  await dialog.getByRole("button",{name:"Create",exact:true}).click();
  await expect(page.getByLabel("Page title",{exact:true}))
    .toHaveValue("W10b shared custom blocks");
  await expect.poll(() => new URL(page.url()).searchParams.get("page"))
    .not.toBeNull();
  const docId=new URL(page.url()).searchParams.get("page");
  expect(docId).toBeTruthy();
  const toolbar=page.getByRole("toolbar",{name:"Formatting"});
  await expect(page.locator(".bn-editor")).toBeVisible();
  await page.locator(".bn-editor").click();
  await page.keyboard.type("Before special blocks");
  await toolbar.getByRole("button",{name:"Insert callout"}).click();
  await expect(page.locator(".workspace-callout")).toBeVisible();
  await toolbar.getByRole("button",{name:"Insert divider"}).click();
  const dividerRule=page.locator(".workspace-divider hr");
  await expect(dividerRule).toBeVisible();
  const ruleBox=await dividerRule.boundingBox();
  expect(ruleBox?.width, "Divider must span a meaningful editor width")
    .toBeGreaterThan(100);
  expect(ruleBox?.height, "Divider must not collapse to zero height")
    .toBeGreaterThanOrEqual(1);
  await expect.poll(async()=>{
    const response=await page.request.get(`/api/v1/pages/${docId}/content`);
    if(!response.ok())return [];
    const v=await response.json();
    return v.blocks?.filter((b:any)=>["callout","divider"].includes(b.type))
      .map((b:any)=>b.type) || [];
  },{timeout:30000}).toEqual(["callout","divider"]);

  const session=await browser.newContext();
  try{
    const other=await session.newPage();
    await login(other,false);
    await other.goto(page.url());
    await expect(other.locator(".workspace-callout")).toContainText(
      "Add a note for your team.");
    await expect(other.locator(".workspace-divider hr")).toBeVisible();
  }finally{await session.close();}
  await page.reload();
  await expect(page.locator(".workspace-callout")).toContainText(
    "Add a note for your team.");
  await expect(page.locator(".workspace-divider hr")).toBeVisible();
});


test("W10c1 accessible formatting, local undo/redo and phone-sized editor", async ({page}) => {
  await login(page);
  await page.getByRole("button",{name:"New page",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Create something new"});
  const title="W10c1 editor acceptance";
  await dialog.getByLabel("Name",{exact:true}).fill(title);
  await dialog.getByRole("button",{name:"Create",exact:true}).click();
  await expect(page.getByLabel("Page title",{exact:true})).toHaveValue(title);
  await expect.poll(() => new URL(page.url()).searchParams.get("page"))
    .not.toBeNull();
  const id=new URL(page.url()).searchParams.get("page");
  const editable=page.locator(".bn-editor");
  await expect(editable).toBeVisible();
  const tools=page.getByRole("toolbar",{name:"Formatting"});
  for(const name of ["Heading 1","Heading 2","Heading 3",
    "Checklist","Underline selection","Undo last edit","Redo last edit"]){
    await expect(tools.getByRole("button",{name})).toBeVisible();
  }
  await editable.click();
  // insertText is one native input transaction, so undo cannot depend
  // on per-keypress history grouping or wall-clock timers.
  await page.keyboard.insertText("W10c1 undo proof");
  await expect(editable).toContainText("W10c1 undo proof");
  await tools.getByRole("button",{name:"Undo last edit"}).click();
  await expect(editable).not.toContainText("W10c1 undo proof");
  await tools.getByRole("button",{name:"Redo last edit"}).click();
  await expect(editable).toContainText("W10c1 undo proof");

  await tools.getByRole("button",{name:"Heading 1"}).click();
  await expect(page.locator(".bn-editor h1")).toContainText("W10c1 undo proof");
  await tools.getByRole("button",{name:"Heading 3"}).click();
  await expect(page.locator(".bn-editor h3")).toContainText("W10c1 undo proof");
  await tools.getByRole("button",{name:"Checklist"}).click();
  await expect.poll(async()=>{
    const res=await page.request.get(`/api/v1/pages/${id}/content`);
    if(!res.ok()) return "";
    const blocks=(await res.json()).blocks||[];
    return blocks.find((b:any)=>b.type==="checkListItem")?.content
      ? "checklist" : "pending";
  },{timeout:30000}).toBe("checklist");
  await page.setViewportSize({width:390,height:844});
  await expect(tools.getByRole("button",{name:"Checklist"})).toBeVisible();
  await expect(tools.getByRole("button",{name:"Undo last edit"})).toBeVisible();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator(".bn-editor")).toContainText("W10c1 undo proof");
  await expect(page.getByRole("toolbar",{name:"Formatting"})).toBeVisible();
});


test("W10c2 version restore preserves custom rich blocks, marks and identity", async ({page,browser}) => {
  test.setTimeout(120000);
  await login(page);
  await ensurePrincipalReadBudget(page);
  const meResponse=await page.request.get("/api/v1/me");
  expect(meResponse.ok(),await meResponse.text()).toBeTruthy();
  const me=await meResponse.json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const stamp=randomUUID();
  const createdSpace=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,title:"W10c2 rich restore "+stamp},
  });
  expect(createdSpace.ok(),await createdSpace.text()).toBeTruthy();
  const space=await createdSpace.json();
  const createdPage=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,title:"Restore proof "+stamp},
  });
  expect(createdPage.ok(),await createdPage.text()).toBeTruthy();
  const resource=await createdPage.json();
  const endpoint="/api/v1/pages/"+resource.id;
  const initialResponse=await page.request.get(endpoint+"/content");
  expect(initialResponse.ok()).toBeTruthy();
  const initial=await initialResponse.json();
  const storedBlocks=[
    {id:randomUUID(),type:"heading",props:{level:3},content:"Retained section"},
    {id:randomUUID(),type:"callout",props:{variant:"warning"},content:[
      {type:"text",text:"Retained important",styles:{bold:true}},
      {type:"text",text:" evidence",styles:{underline:true}},
    ]},
    {id:randomUUID(),type:"divider"},
    {id:randomUUID(),type:"checkListItem",props:{checked:true},content:"Completed review"},
  ];
  const first=await page.request.patch(endpoint+"/content",{
    headers,data:{blocks:storedBlocks,expected_revision:initial.revision},
  });
  expect(first.ok(),await first.text()).toBeTruthy();
  const rich=await first.json();
  expect(rich.revision).toBe(initial.revision+1);
  const savedResponse=await page.request.get(endpoint+"/content");
  expect(savedResponse.ok()).toBeTruthy();
  const saved=await savedResponse.json();
  expect(saved.blocks).toEqual(storedBlocks);
  // A subsequent replacement records the rich document as the version
  // to restore. Stale preconditions must not mutate the live document.
  const second=await page.request.patch(endpoint+"/content",{
    headers,data:{
      blocks:[{type:"paragraph",content:"Temporary replacement"}],
      expected_revision:rich.revision,
    },
  });
  expect(second.ok(),await second.text()).toBeTruthy();
  const changed=await second.json();
  const revisions=await page.request.get(endpoint+"/versions");
  expect(revisions.ok()).toBeTruthy();
  const history=await revisions.json();
  const version=history.find((v:any)=>v.revision===rich.revision);
  expect(version?.id).toBeTruthy();
  const versionResponse=await page.request.get(endpoint+"/versions/"+version.id);
  expect(versionResponse.ok()).toBeTruthy();
  const snapshot=await versionResponse.json();
  expect(snapshot.blocks).toEqual(storedBlocks);
  const stale=await page.request.post(
    endpoint+"/versions/"+version.id+"/restore",{
      headers,data:{expected_revision:rich.revision},
    });
  expect(stale.status()).toBe(409);
  const unchanged=await (await page.request.get(endpoint+"/content")).json();
  expect(unchanged.blocks[0].content).toBe("Temporary replacement");
  expect(unchanged.revision).toBe(changed.revision);
  const restore=await page.request.post(
    endpoint+"/versions/"+version.id+"/restore",{
      headers,data:{expected_revision:changed.revision},
    });
  expect(restore.ok(),await restore.text()).toBeTruthy();
  const restoredVersion=await restore.json();
  expect(restoredVersion.revision).toBe(changed.revision+1);
  expect(restoredVersion.epoch).toBeGreaterThan(changed.epoch);
  const restored=await (await page.request.get(endpoint+"/content")).json();
  expect(restored.blocks).toEqual(snapshot.blocks);
  expect(restored.blocks.map((b:any)=>b.id))
    .toEqual(storedBlocks.map(b=>b.id));
  expect(JSON.stringify(restored.blocks)).toContain('"bold":true');
  expect(JSON.stringify(restored.blocks)).toContain('"underline":true');
  // Three hostile input shapes must be rejected without any mutation.
  for(const bad of [
    {type:"paragraph",content:[
      {type:"link",href:"javascript:alert(1)",content:"unsafe"}]},
    {type:"callout",props:{variant:"unsafe"},content:"invalid variant"},
    {type:"divider",content:"non-empty divider"},
  ]){
    const invalid=await page.request.patch(endpoint+"/content",{
      headers,data:{blocks:[bad],expected_revision:restoredVersion.revision},
    });
    expect(invalid.status()).toBe(400);
  }
  const still=await (await page.request.get(endpoint+"/content")).json();
  expect(still.revision).toBe(restoredVersion.revision);
  expect(still.blocks).toEqual(storedBlocks);
  const afterHistory=await (await page.request.get(endpoint+"/versions")).json();
  expect(afterHistory.some((v:any)=>v.id===version.id)).toBe(true);
  await page.goto("/?page="+resource.id);
  await expect(page.locator(".workspace-callout")).toContainText(
    "Retained important evidence");
  await expect(page.locator(".workspace-callout"))
    .toHaveAttribute("data-workspace-callout","warning");
  await expect(page.locator(".workspace-divider hr")).toBeVisible();
  await expect(page.locator(".bn-editor")).toContainText("Completed review");
  const secondContext=await browser.newContext();
  try {
    const other=await secondContext.newPage();
    await login(other,false);
    await other.goto(page.url());
    await expect(other.locator(".workspace-callout")).toContainText(
      "Retained important evidence");
    await expect(other.locator(".workspace-divider hr")).toBeVisible();
  } finally {
    await secondContext.close();
  }
});


test("W10c3a browser HTML paste preserves benign text without executable markup", async ({page}) => {
  test.setTimeout(120000);
  await login(page);
  await page.getByRole("button",{name:"New page",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Create something new"});
  const title="W10c3a paste safety "+randomUUID();
  await dialog.getByLabel("Name",{exact:true}).fill(title);
  await dialog.getByRole("button",{name:"Create",exact:true}).click();
  await expect(page.getByLabel("Page title",{exact:true})).toHaveValue(title);
  await expect.poll(()=>new URL(page.url()).searchParams.get("page"))
    .not.toBeNull();
  const id=new URL(page.url()).searchParams.get("page");
  expect(id).toBeTruthy();
  const content=page.locator(".bn-editor");
  await expect(content).toBeVisible();
  const html=[
    "<h3>Trusted pasted heading</h3>",
    "<p><strong>Approved bold</strong> and ",
    '<a href="https://example.org/reference">Trusted reference</a> ',
    '<a href="javascript:alert(12345)">Dangerous link text</a></p>',
    '<img src="x-broken" onerror="window.__workspacePasteExecuted=true">',
    '<svg onload="window.__workspacePasteExecuted=true"></svg>',
    "<script>window.__workspacePasteExecuted=true</script>",
  ].join("");
  const plain="Trusted pasted heading\nApproved bold and Trusted reference Dangerous link text";
  await page.evaluate(() => { (window as any).__workspacePasteExecuted=false; });
  // Use an actual Chromium clipboard and keyboard paste, not an untrusted
  // synthetic DOM paste event that ProseMirror might ignore.
  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  await page.evaluate(async ({html,plain})=>{
    const item=new ClipboardItem({
      "text/html":new Blob([html],{type:"text/html"}),
      "text/plain":new Blob([plain],{type:"text/plain"}),
    });
    await navigator.clipboard.write([item]);
  },{html,plain});
  await content.click();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(content).toContainText("Trusted pasted heading");
  await expect(content).toContainText("Approved bold");
  await expect(content).toContainText("Trusted reference");
  await expect.poll(async()=>{
    const res=await page.request.get("/api/v1/pages/"+id+"/content");
    if(!res.ok())return "";
    return (await res.json()).plain_text||"";
  },{timeout:30000}).toContain("Approved bold");
  expect(await page.evaluate(()=>(window as any).__workspacePasteExecuted))
    .toBe(false);
  await expect(content.locator("script")).toHaveCount(0);
  await expect(content.locator("[onerror],[onload]")).toHaveCount(0);
  await expect(content.locator('a[href^="javascript:"],a[href^="data:"]'))
    .toHaveCount(0);
  const persisted=await (await page.request.get(
    "/api/v1/pages/"+id+"/content")).json();
  const serialized=JSON.stringify(persisted.blocks);
  expect(serialized).not.toContain("javascript:alert");
  expect(serialized).not.toContain("__workspacePasteExecuted");
  await page.reload();
  await expect(page.locator(".bn-editor"))
    .toContainText("Trusted pasted heading");
  await expect(page.locator(".bn-editor"))
    .toContainText("Approved bold");
  await expect(page.locator(".bn-editor [onerror],.bn-editor [onload]"))
    .toHaveCount(0);
});


test("W10c3b quote, code and table are visible in two editors and indexed", async ({page,browser}) => {
  test.setTimeout(120000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",title:"W10c3b supported Core",
      parent_id:roots[0].id},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const name="W10c3b reference "+randomUUID();
  const created=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",title:name,parent_id:space.id},
  });
  expect(created.ok(),await created.text()).toBeTruthy();
  const document=await created.json();
  const endpoint="/api/v1/pages/"+document.id+"/content";
  const initial=await (await page.request.get(endpoint)).json();
  const blocks=[
    {type:"quote",content:"Audit statements are preserved"},
    {type:"codeBlock",props:{language:"javascript"},
      content:"const retained = true;"},
    {type:"table",content:{type:"tableContent",rows:[
      {cells:["Product","Quantity"]},
      {cells:["Blue Mountain","24"]},
    ]}},
  ];
  const saved=await page.request.patch(endpoint,{
    headers,data:{blocks,expected_revision:initial.revision},
  });
  expect(saved.ok(),await saved.text()).toBeTruthy();
  await expect.poll(async()=>{
    const result=await page.request.get(endpoint);
    if(!result.ok())return "";
    const data=await result.json();
    if(data.blocks.map((b:any)=>b.type).join(",")!=="quote,codeBlock,table")
      return "wrong-structure";
    return data.plain_text||"";
  },{timeout:30000}).toContain("Blue Mountain");
  await page.goto("/?page="+document.id);
  const editor=page.locator(".bn-editor");
  await expect(editor).toContainText("Audit statements are preserved");
  await expect(editor).toContainText("const retained = true;");
  await expect(editor.locator("table")).toContainText("Blue Mountain");
  const otherContext=await browser.newContext();
  try {
    const other=await otherContext.newPage();
    await login(other,false);
    await other.goto(page.url());
    await expect(other.locator(".bn-editor")).toContainText(
      "Audit statements are preserved");
    await expect(other.locator(".bn-editor")).toContainText(
      "const retained = true;");
    await expect(other.locator(".bn-editor table"))
      .toContainText("Blue Mountain");
  }finally {await otherContext.close();}
  await page.reload();
  await expect(page.locator(".bn-editor table")).toContainText("Blue Mountain");
  // Search indexing must include permitted text in tables, rather than only
  // headings and conventional paragraph nodes.
  const found=await page.request.get("/api/v1/search",{params:{q:"Blue Mountain"}});
  expect(found.ok(),await found.text()).toBeTruthy();
  expect((await found.json()).some((r:any)=>r.id===document.id)).toBe(true);
});


test("W10c4a live two-editor restore reissues rooms without manual reload", async ({page,browser}) => {
  test.setTimeout(150000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c4a live restore "+randomUUID()},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const pageResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"W10c4a live recovery"},
  });
  expect(pageResponse.ok(),await pageResponse.text()).toBeTruthy();
  const resource=await pageResponse.json();
  const endpoint="/api/v1/pages/"+resource.id;
  const initial=await (await page.request.get(endpoint+"/content")).json();
  const stableBlocks=[
    {id:randomUUID(),type:"heading",props:{level:2},
      content:"Restored collaborative state"},
    {id:randomUUID(),type:"callout",props:{variant:"warning"},
      content:[{type:"text",text:"Recovered evidence",styles:{bold:true}}]},
    {id:randomUUID(),type:"divider"},
    {id:randomUUID(),type:"paragraph",content:"Restored notes"},
  ];
  const first=await page.request.patch(endpoint+"/content",{
    headers,data:{blocks:stableBlocks,expected_revision:initial.revision},
  });
  expect(first.ok(),await first.text()).toBeTruthy();
  const rich=await first.json();
  const second=await page.request.patch(endpoint+"/content",{
    headers,data:{blocks:[{type:"paragraph",content:"Discarded temporary draft"}],
      expected_revision:rich.revision},
  });
  expect(second.ok(),await second.text()).toBeTruthy();
  const changed=await second.json();
  const versions=await (await page.request.get(endpoint+"/versions")).json();
  const snapshot=versions.find((v:any)=>v.revision===rich.revision);
  expect(snapshot?.id).toBeTruthy();

  const url="/?page="+resource.id;
  await page.goto(url);
  await expect(page.locator(".bn-editor"))
    .toContainText("Discarded temporary draft");
  const secondSession=await browser.newContext();
  try {
    const other=await secondSession.newPage();
    await login(other,false);
    await other.goto(url);
    await expect(other.locator(".bn-editor"))
      .toContainText("Discarded temporary draft");
    // Both browsers are connected to the old epoch before this REST
    // version restore. Neither browser is reloaded after the operation.
    const priorTicket=await page.request.post(endpoint+"/collab",{
      headers,data:{},
    });
    expect(priorTicket.ok(),await priorTicket.text()).toBeTruthy();
    const before=await priorTicket.json();
    expect(before.name).toContain(resource.id);

    const restored=await page.request.post(
      endpoint+"/versions/"+snapshot.id+"/restore",{
        headers,data:{expected_revision:changed.revision},
      });
    expect(restored.ok(),await restored.text()).toBeTruthy();
    const result=await restored.json();
    expect(result.epoch).toBeGreaterThan(changed.epoch);
    const freshTicket=await page.request.post(endpoint+"/collab",{
      headers,data:{},
    });
    expect(freshTicket.ok(),await freshTicket.text()).toBeTruthy();
    const after=await freshTicket.json();
    expect(after.name).not.toBe(before.name);
    expect(after.name).toContain(resource.id);

    for(const client of [page,other]) {
      await expect(client.locator(".bn-editor"),"must auto-reset the old Yjs epoch")
        .toContainText("Restored collaborative state",{timeout:30000});
      await expect(client.locator(".workspace-callout"))
        .toContainText("Recovered evidence");
      await expect(client.locator(".workspace-divider hr")).toBeVisible();
      await expect(client.locator(".bn-editor"))
        .not.toContainText("Discarded temporary draft");
    }
    const afterRestore=await (await page.request.get(endpoint+"/content")).json();
    expect(afterRestore.blocks.map((b:any)=>b.id))
      .toEqual(stableBlocks.map(b=>b.id));
    expect(afterRestore.blocks[1].props.variant).toBe("warning");

    // Confirm an editor reconnected to the new epoch can write and the
    // stale old-room content never reappears after its autosave debounce.
    await other.locator(".bn-editor").click();
    await other.keyboard.press("ControlOrMeta+End");
    await other.keyboard.insertText(" Fresh after reset.");
    await expect.poll(async()=>{
      const response=await page.request.get(endpoint+"/content");
      if(!response.ok())return "";
      return (await response.json()).plain_text||"";
    },{timeout:30000}).toContain("Fresh after reset.");
    await expect(page.locator(".bn-editor"))
      .toContainText("Fresh after reset.");
    const canonical=await (await page.request.get(endpoint+"/content")).json();
    expect(canonical.plain_text).not.toContain("Discarded temporary draft");
    expect(canonical.blocks.some((b:any)=>b.type==="callout")).toBe(true);
  } finally {await secondSession.close();}
});


test("W10c4b two live editors merge rich edits and isolate local undo/redo", async ({page,browser}) => {
  test.setTimeout(150000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c4b simultaneous editors "+randomUUID()},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const pageResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"Concurrent rich edit "+randomUUID()},
  });
  expect(pageResponse.ok(),await pageResponse.text()).toBeTruthy();
  const resource=await pageResponse.json();
  const endpoint="/api/v1/pages/"+resource.id+"/content";
  const initial=await (await page.request.get(endpoint)).json();
  const stableBlocks=[
    {id:randomUUID(),type:"heading",props:{level:2},
      content:"Concurrent editor evidence"},
    {id:randomUUID(),type:"callout",props:{variant:"warning"},
      content:"Alpha baseline"},
    {id:randomUUID(),type:"quote",content:"Beta baseline"},
    {id:randomUUID(),type:"divider"},
    {id:randomUUID(),type:"paragraph",content:"Untouched evidence"},
  ];
  const seed=await page.request.patch(endpoint,{
    headers,data:{blocks:stableBlocks,expected_revision:initial.revision},
  });
  expect(seed.ok(),await seed.text()).toBeTruthy();

  const url="/?page="+resource.id;
  await page.goto(url);
  await expect(page.locator(".workspace-callout")).toContainText("Alpha baseline");
  await expect(page.locator(".bn-editor")).toContainText("Beta baseline");
  const secondContext=await browser.newContext();
  try {
    const other=await secondContext.newPage();
    await login(other,false);
    await other.goto(url);
    await expect(other.locator(".workspace-callout"))
      .toContainText("Alpha baseline");
    await expect(other.locator(".bn-editor")).toContainText("Beta baseline");
    const alphaEdit=" Alpha from editor one";
    const betaEdit=" Beta from editor two";
    // Place each caret at the exact named block edge directly before its
    // concurrent input, not before an intervening cross-window focus event.
    // Keep all canonical block identity and scoped undo checks unchanged.
    await Promise.all([
      typeAtRichBlockEnd(page,".workspace-callout-content",alphaEdit),
      typeAtQuoteEdge(other,"end",betaEdit),
    ]);
    for(const client of [page,other]) {
      await expect(client.locator(".workspace-callout"))
        .toContainText("Alpha baseline"+alphaEdit);
      await expect(client.locator(".bn-editor"))
        .toContainText("Beta baseline"+betaEdit);
    }
    const canonical=async()=>{
      const response=await page.request.get(endpoint);
      expect(response.ok(),await response.text()).toBeTruthy();
      return await response.json();
    };
    await expect.poll(async()=>{
      const doc=await canonical();
      return doc.blocks.map((b:any)=>b.type+":"+JSON.stringify(b.content)).join("|");
    },{timeout:30000}).toContain(betaEdit);
    let persisted=await canonical();
    expect(persisted.plain_text).toContain(alphaEdit);
    expect(persisted.plain_text).toContain(betaEdit);
    expect(persisted.blocks.map((b:any)=>b.id))
      .toEqual(stableBlocks.map(b=>b.id));
    expect(persisted.blocks.map((b:any)=>b.type))
      .toEqual(stableBlocks.map(b=>b.type));
    expect(persisted.blocks[1].props.variant).toBe("warning");

    // This local editor's undo may erase only its own change, never a
    // different session's committed quote edit or the other rich blocks.
    await page.getByRole("toolbar",{name:"Formatting"})
      .getByRole("button",{name:"Undo last edit"}).click();
    for(const client of [page,other]){
      await expect(client.locator(".workspace-callout"))
        .not.toContainText(alphaEdit);
      await expect(client.locator(".bn-editor"))
        .toContainText("Beta baseline"+betaEdit);
    }
    await expect.poll(async()=>{
      const doc=await canonical();
      return doc.plain_text.includes(alphaEdit)
        ? "alpha-still-there"
        : doc.plain_text.includes(betaEdit) ? "peer-survived" : "peer-missing";
    },{timeout:30000}).toBe("peer-survived");
    await page.getByRole("toolbar",{name:"Formatting"})
      .getByRole("button",{name:"Redo last edit"}).click();
    for(const client of [page,other]){
      await expect(client.locator(".workspace-callout"))
        .toContainText("Alpha baseline"+alphaEdit);
      await expect(client.locator(".bn-editor"))
        .toContainText("Beta baseline"+betaEdit);
    }
    await expect.poll(async()=>{
      const doc=await canonical();
      return doc.plain_text.includes(alphaEdit) &&
        doc.plain_text.includes(betaEdit);
    },{timeout:30000}).toBe(true);
    persisted=await canonical();
    expect(persisted.blocks.map((b:any)=>b.id))
      .toEqual(stableBlocks.map(b=>b.id));
    await page.reload();
    await other.reload();
    for(const client of [page,other]){
      await expect(client.locator(".workspace-callout"))
        .toContainText("Alpha baseline"+alphaEdit);
      await expect(client.locator(".bn-editor"))
        .toContainText("Beta baseline"+betaEdit);
      await expect(client.locator(".workspace-divider hr")).toBeVisible();
    }
  }finally{await secondContext.close();}
});


test("W10c5a private PNG upload renders in two editors and revokes on delete", async ({page,browser}) => {
  test.setTimeout(150000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c5a local image "+randomUUID()},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const created=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"Local image proof "+randomUUID()},
  });
  expect(created.ok(),await created.text()).toBeTruthy();
  const resource=await created.json();
  const endpoint="/api/v1/pages/"+resource.id+"/content";
  // A decodable 1x1 PNG fixture: no third-party network, hotlink or
  // client-inaccessible external CDN is involved.
  const png=Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRwwAAAAASUVORK5CYII=",
    "base64");
  expect(png.subarray(0,8).toString("hex"))
    .toBe("89504e470d0a1a0a");
  const beforeFiles=await page.request.get(
    "/api/v1/resources/"+resource.id+"/files");
  expect(beforeFiles.ok()).toBeTruthy();
  const initialFiles=await beforeFiles.json();
  // Wrong magic bytes must be rejected *before* object persistence even
  // if the filename and caller-provided MIME both claim image/png.
  const invalid=await page.request.post(
    "/api/v1/resources/"+resource.id+"/files",{
      headers,multipart:{file:{
        name:"fake.png",mimeType:"image/png",
        buffer:Buffer.from("This is not image bytes."),
      }},
    });
  expect(invalid.status(),await invalid.text()).toBe(400);
  const afterInvalid=await (await page.request.get(
    "/api/v1/resources/"+resource.id+"/files")).json();
  expect(afterInvalid.length).toBe(initialFiles.length);

  const upload=await page.request.post(
    "/api/v1/resources/"+resource.id+"/files",{
      headers,multipart:{file:{
        name:"private-1x1.png",mimeType:"image/png",buffer:png,
      }},
    });
  expect(upload.ok(),await upload.text()).toBeTruthy();
  const file=await upload.json();
  expect(file.url).toMatch(/^\/api\/v1\/files\/[a-f0-9-]+\/content$/);
  const fetched=await page.request.get(file.url);
  expect(fetched.ok(),await fetched.text()).toBeTruthy();
  expect(fetched.headers()["content-type"]).toContain("image/png");
  expect(fetched.headers()["content-disposition"]).toContain("inline");
  expect(fetched.headers()["x-content-type-options"]).toBe("nosniff");
  expect(Buffer.from(await fetched.body())).toEqual(png);

  const initial=await (await page.request.get(endpoint)).json();
  const storedBlocks=[
    {id:randomUUID(),type:"heading",props:{level:2},
      content:"Local, permissioned image evidence"},
    {id:randomUUID(),type:"image",props:{
      url:file.url,caption:"Local proof",name:"private-1x1.png",
    }},
    {id:randomUUID(),type:"callout",props:{variant:"info"},
      content:"No remote image host"},
  ];
  const seed=await page.request.patch(endpoint,{
    headers,data:{blocks:storedBlocks,expected_revision:initial.revision},
  });
  expect(seed.ok(),await seed.text()).toBeTruthy();
  const doc=await (await page.request.get(endpoint)).json();
  expect(doc.blocks.map((b:any)=>b.type))
    .toEqual(["heading","image","callout"]);
  expect(doc.blocks[1].props.url).toBe(file.url);

  const url="/?page="+resource.id;
  await page.goto(url);
  const naturalWidth=async(client:typeof page)=>
    await client.locator(".bn-editor img").first().evaluate(
      (element)=> (element as HTMLImageElement).naturalWidth);
  await expect.poll(()=>naturalWidth(page),{timeout:30000}).toBe(1);
  const second=await browser.newContext();
  try {
    const other=await second.newPage();
    await login(other,false);
    await other.goto(url);
    await expect(other.locator(".workspace-callout"))
      .toContainText("No remote image host");
    await expect.poll(()=>naturalWidth(other),{timeout:30000}).toBe(1);
    const otherBytes=await other.request.get(file.url);
    expect(otherBytes.ok(),await otherBytes.text()).toBeTruthy();
    expect(Buffer.from(await otherBytes.body())).toEqual(png);
    await page.reload();
    await other.reload();
    for(const client of [page,other]){
      await expect.poll(()=>naturalWidth(client),{timeout:30000}).toBe(1);
      await expect(client.locator(".workspace-callout"))
        .toContainText("No remote image host");
    }
  }finally{await second.close();}

  const deleted=await page.request.delete("/api/v1/files/"+file.id,{headers});
  expect(deleted.ok(),await deleted.text()).toBeTruthy();
  expect((await page.request.get(file.url)).status()).toBe(404);
  const finalFiles=await (await page.request.get(
    "/api/v1/resources/"+resource.id+"/files")).json();
  expect(finalFiles.some((f:any)=>f.id===file.id)).toBe(false);
});


test("W10c5b private text attachment uses Core file block without inline execution", async ({page,browser}) => {
  test.setTimeout(150000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c5b local attachment "+randomUUID()},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const created=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"Private text file block "+randomUUID()},
  });
  expect(created.ok(),await created.text()).toBeTruthy();
  const resource=await created.json();
  const endpoint="/api/v1/pages/"+resource.id+"/content";
  const filename="local-audit-"+randomUUID()+".txt";
  const evidence=Buffer.from("Private W10c5b attachment bytes, never inline script.\n");
  const uploaded=await page.request.post(
    "/api/v1/resources/"+resource.id+"/files",{
      headers,multipart:{file:{
        name:filename,mimeType:"text/plain",buffer:evidence,
      }},
    });
  expect(uploaded.ok(),await uploaded.text()).toBeTruthy();
  const file=await uploaded.json();
  expect(file.url).toMatch(/^\/api\/v1\/files\/[a-f0-9-]+\/content$/);
  const read=await page.request.get(file.url);
  expect(read.ok(),await read.text()).toBeTruthy();
  expect(Buffer.from(await read.body())).toEqual(evidence);
  expect(read.headers()["content-type"]).toContain("text/plain");
  expect(read.headers()["content-disposition"]).toContain("attachment");
  expect(read.headers()["x-content-type-options"]).toBe("nosniff");
  expect(read.headers()["cache-control"]).toBe("no-store");

  const before=await (await page.request.get(endpoint)).json();
  const blocks=[
    {id:randomUUID(),type:"heading",props:{level:2},
      content:"Private downloadable source"},
    {id:randomUUID(),type:"file",props:{name:filename,url:file.url}},
    {id:randomUUID(),type:"paragraph",
      content:"The attachment is permission-checked at download."},
  ];
  const saved=await page.request.patch(endpoint,{
    headers,data:{blocks,expected_revision:before.revision},
  });
  expect(saved.ok(),await saved.text()).toBeTruthy();
  const canonical=await (await page.request.get(endpoint)).json();
  expect(canonical.blocks.map((b:any)=>b.type))
    .toEqual(["heading","file","paragraph"]);
  expect(canonical.blocks[1].props.url).toBe(file.url);
  expect(canonical.blocks[1].props.name).toBe(filename);
  // The file name is document metadata, not a remote fetch, and the
  // private file bytes must not be indexed as document text.
  expect(canonical.plain_text).not.toContain("Private W10c5b attachment bytes");

  await page.goto("/?page="+resource.id);
  await expect(page.locator(".bn-editor")).toContainText(
    "Private downloadable source");
  await expect(page.locator(".bn-editor")).toContainText(filename);
  const secondContext=await browser.newContext();
  try {
    const other=await secondContext.newPage();
    await login(other,false);
    await other.goto(page.url());
    await expect(other.locator(".bn-editor")).toContainText(filename);
    const otherRead=await other.request.get(file.url);
    expect(otherRead.ok(),await otherRead.text()).toBeTruthy();
    expect(otherRead.headers()["content-disposition"])
      .toContain("attachment");
    expect(Buffer.from(await otherRead.body())).toEqual(evidence);
    await page.reload();
    await other.reload();
    for(const client of [page,other])
      await expect(client.locator(".bn-editor")).toContainText(filename);
  }finally{await secondContext.close();}
  const after=await (await page.request.get(endpoint)).json();
  expect(after.blocks.map((b:any)=>b.id))
    .toEqual(blocks.map(b=>b.id));
  expect(after.blocks[1].props.url).toBe(file.url);
  const deleted=await page.request.delete("/api/v1/files/"+file.id,{headers});
  expect(deleted.ok(),await deleted.text()).toBeTruthy();
  expect((await page.request.get(file.url)).status()).toBe(404);
  // Deletion revokes bytes even if historical block metadata retains URL:
  // old state must not make the attachment accessible again.
  expect((await page.request.get(endpoint)).ok()).toBe(true);
});


test("W10c5c emulated touch edits rich blocks at phone and tablet widths", async ({page,browser}) => {
  test.setTimeout(150000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c5c touch acceptance "+randomUUID()},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const create=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"Mobile touch edit "+randomUUID()},
  });
  expect(create.ok(),await create.text()).toBeTruthy();
  const resource=await create.json();
  const endpoint="/api/v1/pages/"+resource.id+"/content";
  const initial=await (await page.request.get(endpoint)).json();
  const seeded=[
    {id:randomUUID(),type:"paragraph",content:"Touch paragraph"},
    {id:randomUUID(),type:"callout",props:{variant:"warning"},
      content:"Touch callout"},
    {id:randomUUID(),type:"divider"},
  ];
  const seed=await page.request.patch(endpoint,{
    headers,data:{blocks:seeded,expected_revision:initial.revision},
  });
  expect(seed.ok(),await seed.text()).toBeTruthy();
  // Real Chromium device emulation (hasTouch/isMobile) rather than merely
  // resizing a desktop Playwright page to 390px. The actual editor and its
  // toolbar are activated through touch-driven locator.tap().
  const phoneContext=await browser.newContext({
    viewport:{width:390,height:844},isMobile:true,
    hasTouch:true,deviceScaleFactor:2,
  });
  const tabletContext=await browser.newContext({
    viewport:{width:820,height:1180},isMobile:true,
    hasTouch:true,deviceScaleFactor:2,
  });
  try {
    // Copy the genuine login session. Don't flood the production auth
    // limiter with two redundant logins for one three-device test.
    const cookies=await page.context().cookies();
    await phoneContext.addCookies(cookies);
    await tabletContext.addCookies(cookies);
    const phone=await phoneContext.newPage();
    const tablet=await tabletContext.newPage();
    const url="/?page="+resource.id;
    await phone.goto(url);
    await expect(phone.locator(".bn-editor")).toContainText("Touch paragraph");
    await expect(phone.locator(".workspace-callout"))
      .toContainText("Touch callout");
    const phoneTools=phone.getByRole("toolbar",{name:"Formatting"});
    await expect(phoneTools.getByRole("button",{name:"Heading 3"})).toBeVisible();
    await expect(phoneTools.getByRole("button",{name:"Insert divider"}))
      .toBeVisible();
    await phone.locator(".bn-editor")
      .getByText("Touch paragraph",{exact:true}).tap();
    await phone.keyboard.press("End");
    await phone.keyboard.insertText(" edited by phone");
    await expect(phone.locator(".bn-editor"))
      .toContainText("Touch paragraph edited by phone");
    // Direct touch of the actual formatting control must preserve the
    // cursor's block and update the canonical schema.
    await phoneTools.getByRole("button",{name:"Heading 3"}).tap();
    await expect(phone.locator(".bn-editor h3"))
      .toContainText("Touch paragraph edited by phone");
    await expect.poll(async()=>{
      const r=await page.request.get(endpoint);
      if(!r.ok())return "";
      const doc=await r.json();
      return doc.blocks[0]?.type+":"+doc.blocks[0]?.props?.level;
    },{timeout:30000}).toBe("heading:3");

    await tablet.goto(url);
    await expect(tablet.locator(".bn-editor h3"))
      .toContainText("Touch paragraph edited by phone");
    await expect(tablet.locator(".workspace-callout"))
      .toContainText("Touch callout");
    await tablet.locator(".workspace-callout-content").tap();
    await tablet.keyboard.press("End");
    await tablet.keyboard.insertText(" edited by tablet");
    for(const client of [phone,tablet]){
      await expect(client.locator(".workspace-callout"))
        .toContainText("Touch callout edited by tablet");
      await expect(client.locator(".bn-editor h3"))
        .toContainText("Touch paragraph edited by phone");
    }

    // Touch-activate a structural insert after rich content, and confirm
    // both clients converge without losing the original divider or IDs.
    await tablet.getByRole("toolbar",{name:"Formatting"})
      .getByRole("button",{name:"Insert divider"}).tap();
    await expect(tablet.locator(".workspace-divider hr")).toHaveCount(2);
    await expect(phone.locator(".workspace-divider hr")).toHaveCount(2);
    await expect.poll(async()=>{
      const response=await page.request.get(endpoint);
      if(!response.ok())return "";
      const doc=await response.json();
      return [doc.plain_text.includes("edited by phone"),
        doc.plain_text.includes("edited by tablet"),
        doc.blocks.filter((b:any)=>b.type==="divider").length].join(":");
    },{timeout:30000}).toBe("true:true:2");
    const canonical=await (await page.request.get(endpoint)).json();
    for(const seedBlock of seeded)
      expect(canonical.blocks.filter((b:any)=>b.id===seedBlock.id))
        .toHaveLength(1);
    expect(canonical.blocks.find((b:any)=>b.id===seeded[1].id)?.props.variant)
      .toBe("warning");
    for(const device of [phone,tablet]){
      expect(await device.evaluate(()=>
        document.documentElement.scrollWidth<=window.innerWidth))
        .toBe(true);
      await device.reload();
      await expect(device.locator(".bn-editor h3"))
        .toContainText("Touch paragraph edited by phone");
      await expect(device.locator(".workspace-callout"))
        .toContainText("Touch callout edited by tablet");
      await expect(device.locator(".workspace-divider hr")).toHaveCount(2);
    }
  } finally {
    await phoneContext.close();
    await tabletContext.close();
  }
});


test("W10c4c overlapping edits to the same quote converge with scoped undo", async ({page,browser}) => {
  test.setTimeout(150000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const createdSpace=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c4c same-block merge "+randomUUID()},
  });
  expect(createdSpace.ok(),await createdSpace.text()).toBeTruthy();
  const space=await createdSpace.json();
  const created=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"Concurrent quote "+randomUUID()},
  });
  expect(created.ok(),await created.text()).toBeTruthy();
  const resource=await created.json();
  const endpoint="/api/v1/pages/"+resource.id+"/content";
  const initial=await (await page.request.get(endpoint)).json();
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  const original=[
    {id:ids[0],type:"heading",props:{level:2},content:"Concurrent quote proof"},
    {id:ids[1],type:"quote",content:"Shared quote baseline"},
    {id:ids[2],type:"callout",props:{variant:"warning"},
      content:"Unaffected evidence"},
  ];
  const seed=await page.request.patch(endpoint,{
    headers,data:{blocks:original,expected_revision:initial.revision},
  });
  expect(seed.ok(),await seed.text()).toBeTruthy();
  const url="/?page="+resource.id;
  await page.goto(url);
  const peerContext=await browser.newContext();
  try {
    const peer=await peerContext.newPage();
    await login(peer,false);
    await peer.goto(url);
    const quote=(client:typeof page)=>client.locator(".bn-editor")
      .getByText("Shared quote baseline",{exact:true});
    await expect(quote(page)).toBeVisible();
    await expect(quote(peer)).toBeVisible();
    // Both users edit the *same quote*, not whichever heading or adjacent
    // block happens to inherit a blurred browser tab's DOM selection.
    const fromOne="ONE_BEGIN ";
    const fromTwo=" TWO_END";
    await Promise.all([
      typeAtQuoteEdge(page,"start",fromOne),
      typeAtQuoteEdge(peer,"end",fromTwo),
    ]);
    const canonical=async()=>{
      const response=await page.request.get(endpoint);
      expect(response.ok(),await response.text()).toBeTruthy();
      return response.json();
    };
    for(const client of [page,peer]){
      await expect(client.locator(".bn-editor")).toContainText(fromOne);
      await expect(client.locator(".bn-editor")).toContainText(fromTwo);
      await expect(client.locator(".workspace-callout")).toContainText(
        "Unaffected evidence");
    }
    await expect.poll(async()=>{
      const c=await canonical();
      return c.plain_text.includes(fromOne)&&c.plain_text.includes(fromTwo);
    },{timeout:30000}).toBe(true);
    const merged=await canonical();
    expect(merged.blocks.map((b:any)=>b.id)).toEqual(ids);
    expect(merged.blocks[1].type).toBe("quote");
    const mergedText=JSON.stringify(merged.blocks[1].content);
    expect(mergedText).toContain(fromOne.trim());
    expect(mergedText).toContain(fromTwo.trim());
    expect(mergedText.split("ONE_BEGIN").length-1).toBe(1);
    expect(mergedText.split("TWO_END").length-1).toBe(1);
    // Undo is origin-scoped: removing editor one's insertion must *never*
    // rewind the other browser's concurrent contribution to this block.
    await page.getByRole("toolbar",{name:"Formatting"})
      .getByRole("button",{name:"Undo last edit"}).click();
    for(const client of [page,peer]){
      await expect(client.locator(".bn-editor")).not.toContainText(fromOne);
      await expect(client.locator(".bn-editor")).toContainText(fromTwo);
    }
    await expect.poll(async()=>{
      const c=await canonical();
      return !c.plain_text.includes(fromOne)&&c.plain_text.includes(fromTwo);
    },{timeout:30000}).toBe(true);
    await page.getByRole("toolbar",{name:"Formatting"})
      .getByRole("button",{name:"Redo last edit"}).click();
    for(const client of [page,peer]){
      await expect(client.locator(".bn-editor")).toContainText(fromOne);
      await expect(client.locator(".bn-editor")).toContainText(fromTwo);
    }
    await expect.poll(async()=>{
      const c=await canonical();
      return c.plain_text.includes(fromOne)&&c.plain_text.includes(fromTwo);
    },{timeout:30000}).toBe(true);
    await page.reload();
    await peer.reload();
    for(const client of [page,peer]){
      await expect(client.locator(".bn-editor")).toContainText(fromOne);
      await expect(client.locator(".bn-editor")).toContainText(fromTwo);
      await expect(client.locator(".workspace-callout")).toContainText(
        "Unaffected evidence");
    }
    const reloaded=await canonical();
    expect(reloaded.blocks.map((b:any)=>b.id)).toEqual(ids);
    expect(reloaded.blocks.map((b:any)=>b.type))
      .toEqual(["heading","quote","callout"]);
  } finally {
    await peerContext.close();
  }
});


test("W10c4d distinct principals merge same quote and honor live ACL changes",async ({page,browser})=>{
  test.setTimeout(180000);
  await login(page);
  const owner=await (await page.request.get("/api/v1/me")).json();
  const ownerHeaders={"X-CSRF-Token":owner.csrf};
  const invitation=await page.request.post("/api/v1/members/invite",{
    headers:ownerHeaders,
    data:{name:"Concurrency Partner",
      email:"collab-"+randomUUID()+"@example.test",role:"member"},
  });
  expect(invitation.ok(),await invitation.text()).toBeTruthy();

  const partnerContext=await browser.newContext();
  try {
    const partner=await partnerContext.newPage();
    await partner.goto((await invitation.json()).url);
    await expect(partner.getByRole("heading",{name:"Join your team."})).toBeVisible();
    await expect.poll(()=>new URL(partner.url()).search).toBe("");
    await partner.getByLabel("Password",{exact:true})
      .fill("partner-test-password-123");
    await partner.getByRole("button",{name:"Accept invitation",exact:true}).click();
    await expect(partner.getByRole("heading",{name:"Welcome back, Concurrency."}))
      .toBeVisible();
    const member=await (await partner.request.get("/api/v1/me")).json();
    expect(member.user.id).not.toBe(owner.user.id);
    expect(member.user.role).toBe("member");

    const roots=await (await page.request.get("/api/v1/resources")).json();
    const createdSpace=await page.request.post("/api/v1/resources",{
      headers:ownerHeaders,
      data:{kind:"space",parent_id:roots[0].id,
        title:"Cross-principal collaboration "+randomUUID()},
    });
    expect(createdSpace.ok(),await createdSpace.text()).toBeTruthy();
    const space=await createdSpace.json();
    const created=await page.request.post("/api/v1/resources",{
      headers:ownerHeaders,
      data:{kind:"page",parent_id:space.id,
        title:"Cross-principal quote "+randomUUID()},
    });
    expect(created.ok(),await created.text()).toBeTruthy();
    const document=await created.json();
    const endpoint="/api/v1/pages/"+document.id+"/content";
    const baseline=await (await page.request.get(endpoint)).json();
    const ids=[randomUUID(),randomUUID(),randomUUID()];
    const blocks=[
      {id:ids[0],type:"heading",props:{level:2},
        content:"Private collaborative evidence"},
      {id:ids[1],type:"quote",content:"Shared quote baseline"},
      {id:ids[2],type:"callout",props:{variant:"warning"},
        content:"Intact access boundary"},
    ];
    const seeded=await page.request.patch(endpoint,{
      headers:ownerHeaders,
      data:{blocks,expected_revision:baseline.revision},
    });
    expect(seeded.ok(),await seeded.text()).toBeTruthy();

    const url="/?page="+document.id;
    await page.goto(url);
    await partner.goto(url);
    const ownerEditor=page.locator(".bn-editor"),
      memberEditor=partner.locator(".bn-editor");
    const quote=(p:typeof page)=>p.locator(".bn-editor")
      .getByText("Shared quote baseline",{exact:true});
    await expect(quote(page)).toBeVisible();
    await expect(quote(partner)).toBeVisible();
    const fromOwner="OWNER_BEGIN ";
    const fromMember=" MEMBER_END";
    await Promise.all([
      typeAtQuoteEdge(page,"start",fromOwner),
      typeAtQuoteEdge(partner,"end",fromMember),
    ]);
    const canonical=async()=>{
      const res=await page.request.get(endpoint);
      expect(res.ok(),await res.text()).toBeTruthy();
      return res.json();
    };
    for(const editor of [ownerEditor,memberEditor]){
      await expect(editor).toContainText(fromOwner);
      await expect(editor).toContainText(fromMember);
      await expect(editor).toContainText("Intact access boundary");
    }
    await expect.poll(async()=>{
      const c=await canonical();
      return c.plain_text.includes(fromOwner)&&c.plain_text.includes(fromMember);
    },{timeout:30000}).toBe(true);
    const merged=await canonical();
    expect(merged.blocks.map((b:any)=>b.id)).toEqual(ids);
    const text=JSON.stringify(merged.blocks[1].content);
    expect(text.split("OWNER_BEGIN").length-1).toBe(1);
    expect(text.split("MEMBER_END").length-1).toBe(1);
    expect(merged.blocks[2].props.variant).toBe("warning");

    // Use the actual owner Manage access UI while both Yjs rooms remain open.
    await page.getByRole("button",{name:"Page actions"}).click();
    await page.getByRole("button",{name:"Manage access",exact:true}).click();
    const access=page.getByRole("dialog",{name:"Manage access"});
    await access.getByRole("button",{name:"Add person or integration"}).click();
    await access.getByLabel("Principal",{exact:true}).selectOption(member.user.id);
    await access.getByLabel("Access level",{exact:true}).selectOption("1");
    await access.getByRole("button",{name:"Save access",exact:true}).click();
    await expect(access).toBeHidden();
    await expect(memberEditor).toHaveAttribute("contenteditable","false");
    await expect(partner.getByRole("toolbar",{name:"Formatting"})).toHaveCount(0);
    // The downgraded user cannot mutate the canonical document via typing.
    await memberEditor.click();
    await partner.keyboard.insertText("FORBIDDEN_AFTER_DOWNGRADE");
    await expect(memberEditor).not.toContainText("FORBIDDEN_AFTER_DOWNGRADE");
    expect((await canonical()).plain_text).not.toContain("FORBIDDEN_AFTER_DOWNGRADE");

    // Continue inside an existing block rather than clicking the editor's
    // blank trailing area, which creates a legitimate fourth paragraph.
    await page.locator(".workspace-callout")
      .getByText("Intact access boundary",{exact:true}).click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" OWNER_CONTINUES");
    await expect(memberEditor).toContainText("OWNER_CONTINUES");
    await expect.poll(async()=>(await canonical()).plain_text.includes("OWNER_CONTINUES"),
      {timeout:30000}).toBe(true);

    await page.getByRole("button",{name:"Page actions"}).click();
    await page.getByRole("button",{name:"Manage access",exact:true}).click();
    await expect(access.getByLabel("Access level",{exact:true})).toHaveValue("1");
    await access.getByRole("button",{name:"Remove grant"}).click();
    await access.getByLabel("Inherit access from parent").uncheck();
    await access.getByRole("button",{name:"Save access",exact:true}).click();
    await expect(access).toBeHidden();
    await expect(memberEditor).toHaveCount(0);
    await expect(partner.getByText("Private collaborative evidence",
      {exact:false})).toHaveCount(0);
    await expect(partner.getByText("OWNER_CONTINUES",
      {exact:false})).toHaveCount(0);
    await expect(partner.getByRole("toolbar",{name:"Formatting"})).toHaveCount(0);
    for(const route of [
      "/resources/"+document.id,
      "/pages/"+document.id+"/content",
      "/pages/"+document.id+"/versions",
    ]){
      expect((await partner.request.get("/api/v1"+route)).status()).toBe(404);
    }
    const staleTicket=await partner.request.post(
      "/api/v1/pages/"+document.id+"/collab",{
        headers:{"X-CSRF-Token":member.csrf},data:{},
      });
    expect(staleTicket.status()).toBe(404);
    const surviving=await canonical();
    expect(surviving.blocks.map((b:any)=>b.id)).toEqual(ids);
    expect(surviving.plain_text).toContain("OWNER_CONTINUES");
    expect(surviving.plain_text).not.toContain("FORBIDDEN_AFTER_DOWNGRADE");
  }finally{
    await partnerContext.close();
  }
});


test("W10c4e structural move/delete and peer edit converge with scoped history", async ({page,browser})=>{
  test.setTimeout(180000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceRes=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W10c4e structural collaboration "+randomUUID()},
  });
  expect(spaceRes.ok(),await spaceRes.text()).toBeTruthy();
  const space=await spaceRes.json();
  const pageRes=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,
      title:"Structural move and peer edit "+randomUUID()},
  });
  expect(pageRes.ok(),await pageRes.text()).toBeTruthy();
  const document=await pageRes.json();
  const endpoint="/api/v1/pages/"+document.id+"/content";
  const initial=await (await page.request.get(endpoint)).json();
  const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  const seed=await page.request.patch(endpoint,{
    headers,data:{expected_revision:initial.revision,blocks:[
      {id:ids[0],type:"heading",props:{level:2},content:"Structural edit proof"},
      {id:ids[1],type:"callout",props:{variant:"warning"},content:"Move target"},
      {id:ids[2],type:"quote",content:"Peer quote baseline"},
      {id:ids[3],type:"paragraph",content:"Stable tail"},
    ]},
  });
  expect(seed.ok(),await seed.text()).toBeTruthy();
  const peerContext=await browser.newContext();
  try{
    const peer=await peerContext.newPage();
    await page.goto("/?page="+document.id);
    await login(peer,false);
    await peer.goto("/?page="+document.id);
    const toolbar=page.getByRole("toolbar",{name:"Formatting"});
    for(const name of ["Move current block up","Move current block down","Delete current block"]){
      await expect(toolbar.getByRole("button",{name})).toBeVisible();
    }
    const callout=page.locator(".workspace-callout");
    // Awareness cursor labels are transient DOM decorations inside the
    // callout's inline content: validate visibility separately from the
    // permission-checked canonical text and stable block identifiers.
    await expect(callout).toBeVisible();
    await expect(peer.locator(".bn-editor blockquote")).toContainText("Peer quote baseline");
    const canonical=async()=>{
      const response=await page.request.get(endpoint);
      expect(response.ok(),await response.text()).toBeTruthy();
      return response.json();
    };
    const matches=async(expected:string[],token:string)=>{
      const snapshot=await canonical();
      return snapshot.blocks.map((block:any)=>block.id).join("|")===expected.join("|")
        && snapshot.plain_text.includes(token);
    };
    // Both clients act on adjacent rich blocks while their live sockets remain open.
    await callout.locator(".workspace-callout-content").click();
    await peer.locator(".bn-editor blockquote").click();
    await peer.keyboard.press("End");
    await Promise.all([
      toolbar.getByRole("button",{name:"Move current block down"}).click(),
      peer.keyboard.insertText(" PEER_MERGED"),
    ]);
    await expect.poll(()=>matches([ids[0],ids[2],ids[1],ids[3]],"PEER_MERGED"),
      {timeout:30000}).toBe(true);
    for(const client of [page,peer]){
      await expect(client.locator(".bn-editor blockquote")).toContainText("PEER_MERGED");
      await expect(client.locator(".workspace-callout[data-workspace-callout='warning']")).toBeVisible();
    }
    const moved=await canonical();
    expect(moved.blocks[2].props.variant).toBe("warning");
    expect(moved.plain_text).toContain("Move target");
    // The owner's undo/redo must move just the structural block; the
    // peer's committed quote edit and all original identifiers survive.
    await toolbar.getByRole("button",{name:"Undo last edit"}).click();
    await expect.poll(()=>matches(ids,"PEER_MERGED"),{timeout:30000}).toBe(true);
    await toolbar.getByRole("button",{name:"Redo last edit"}).click();
    await expect.poll(()=>matches([ids[0],ids[2],ids[1],ids[3]],"PEER_MERGED"),
      {timeout:30000}).toBe(true);
    await callout.locator(".workspace-callout-content").click();
    await peer.locator(".bn-editor blockquote").click();
    await peer.keyboard.press("End");
    await Promise.all([
      toolbar.getByRole("button",{name:"Delete current block"}).click(),
      peer.keyboard.insertText(" PEER_AFTER_DELETE"),
    ]);
    const withoutCallout=[ids[0],ids[2],ids[3]];
    await expect.poll(()=>matches(withoutCallout,"PEER_AFTER_DELETE"),
      {timeout:30000}).toBe(true);
    for(const client of [page,peer]){
      await expect(client.locator(".workspace-callout")).toHaveCount(0);
      await expect(client.locator(".bn-editor blockquote")).toContainText("PEER_AFTER_DELETE");
    }
    await toolbar.getByRole("button",{name:"Undo last edit"}).click();
    await expect.poll(()=>matches([ids[0],ids[2],ids[1],ids[3]],"PEER_AFTER_DELETE"),
      {timeout:30000}).toBe(true);
    await expect(page.locator(".workspace-callout[data-workspace-callout='warning']")).toBeVisible();
    expect((await canonical()).plain_text).toContain("Move target");
    await toolbar.getByRole("button",{name:"Redo last edit"}).click();
    await expect.poll(()=>matches(withoutCallout,"PEER_AFTER_DELETE"),
      {timeout:30000}).toBe(true);
    await Promise.all([page.reload(),peer.reload()]);
    for(const client of [page,peer]){
      await expect(client.locator(".bn-editor blockquote")).toContainText("PEER_MERGED");
      await expect(client.locator(".bn-editor blockquote")).toContainText("PEER_AFTER_DELETE");
      await expect(client.locator(".workspace-callout")).toHaveCount(0);
    }
    const final=await canonical();
    expect(final.blocks.map((b:any)=>b.id)).toEqual(withoutCallout);
    expect(final.plain_text).not.toContain("Move target");
    expect(final.blocks[1].type).toBe("quote");
  }finally{
    await peerContext.close();
  }
});


test("W10c4f distinct principals: same block move versus delete never leaves ghost content",async ({page,browser})=>{
  test.setTimeout(240000);
  await login(page);
  const owner=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":owner.csrf};
  const invite=await page.request.post("/api/v1/members/invite",{
    headers,
    data:{name:"Structural Conflict Partner",
      email:"collision-"+randomUUID()+"@example.test",role:"member"},
  });
  expect(invite.ok(),await invite.text()).toBeTruthy();
  const context=await browser.newContext();
  try{
    const partner=await context.newPage();
    await partner.goto((await invite.json()).url);
    await expect(partner.getByRole("heading",{name:"Join your team."})).toBeVisible();
    await expect.poll(()=>new URL(partner.url()).search).toBe("");
    await partner.getByLabel("Password",{exact:true})
      .fill("partner-test-password-123");
    await partner.getByRole("button",{name:"Accept invitation",exact:true}).click();
    await expect(partner.getByRole("heading",{name:"Welcome back, Structural."}))
      .toBeVisible();
    const member=await (await partner.request.get("/api/v1/me")).json();
    expect(member.user.id).not.toBe(owner.user.id);
    expect(member.user.role).toBe("member");
    const roots=await (await page.request.get("/api/v1/resources")).json();
    const spaceResponse=await page.request.post("/api/v1/resources",{
      headers,data:{kind:"space",parent_id:roots[0].id,
        title:"Same block collision "+randomUUID()},
    });
    expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
    const space=await spaceResponse.json();

    // Repeat against fresh, distinct canonical Yjs rooms. Each user has
    // the *same* callout selected before triggering a competing operation.
    for(const moveOwner of [true,false]){
      const phase=moveOwner?"owner-moves":"member-moves";
      const created=await page.request.post("/api/v1/resources",{
        headers,data:{kind:"page",parent_id:space.id,
          title:"Live collision "+phase+" "+randomUUID()},
      });
      expect(created.ok(),await created.text()).toBeTruthy();
      const resource=await created.json();
      const endpoint="/api/v1/pages/"+resource.id+"/content";
      const initial=await (await page.request.get(endpoint)).json();
      const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
      const seed=await page.request.patch(endpoint,{
        headers,data:{expected_revision:initial.revision,blocks:[
          {id:ids[0],type:"heading",props:{level:2},
            content:"Collision regression "+phase},
          {id:ids[1],type:"callout",props:{variant:"warning"},
            content:"SAME_TARGET_SHOULD_BE_REMOVED"},
          {id:ids[2],type:"quote",content:"Unrelated quote survives"},
          {id:ids[3],type:"paragraph",content:"Preserved tail"},
        ]},
      });
      expect(seed.ok(),await seed.text()).toBeTruthy();
      const start=await seed.json();
      await page.goto("/?page="+resource.id);
      await partner.goto("/?page="+resource.id);
      for(const client of [page,partner]){
        await expect(client.locator(".workspace-callout[data-workspace-callout='warning']")).toBeVisible();
        await expect(client.locator(".bn-editor blockquote")).toContainText("Unrelated quote survives");
        await expect(client.getByRole("toolbar",{name:"Formatting"})).toBeVisible();
      }
      const ownerToolbar=page.getByRole("toolbar",{name:"Formatting"}),
        memberToolbar=partner.getByRole("toolbar",{name:"Formatting"});
      const current=(p:typeof page)=>p.locator(".workspace-callout-content");
      await current(page).click();
      await current(partner).click();
      const deleting=moveOwner?partner:page;
      const moveToolbar=moveOwner?ownerToolbar:memberToolbar;
      const deleteToolbar=moveOwner?memberToolbar:ownerToolbar;
      // Capture actual user-visible conflict feedback before the race:
      // the single-writer arbiter must reject one stale structural action
      // rather than silently deleting the neighboring Core quote.
      for(const client of [page,partner])
        await client.evaluate(()=>{
          (window as any).__structuralNotices=[];
          window.addEventListener("workspace-notice",(event:Event)=>{
            (window as any).__structuralNotices.push((event as CustomEvent).detail);
          });
        });
      await Promise.all([
        moveToolbar.getByRole("button",{name:"Move current block down"}).click(),
        deleteToolbar.getByRole("button",{name:"Delete current block"}).click(),
      ]);
      const canonical=async()=>{
        const result=await page.request.get(endpoint);
        expect(result.ok(),await result.text()).toBeTruthy();
        return result.json();
      };
      const remainingIds=[ids[0],ids[2],ids[3]].sort();
      const names=new Map<string,string>(ids.map((id,i):[string,string]=>[id,
        ["heading","DELETED-CALLOUT","quote","tail"][i]]));
      // Losing the sibling quote is NEVER valid, even transiently. If the
      // server accepted Move first it must explicitly reject simultaneous
      // Delete; an operator can retry against the now-synced canonical page.
      const describe=(blocks:any[])=>blocks.map((block:any)=>
        (names.get(block.id)||"UNEXPECTED")+":"+block.id+":"+block.type).sort();
      await expect.poll(async()=>{
        const current=await canonical();
        return current.revision>start.revision ? current.blocks : null;
      },{timeout:30000}).not.toBeNull();
      const afterRace=await canonical();
      const present=new Set(afterRace.blocks.map((b:any)=>b.id));
      expect(present.has(ids[0])).toBe(true);
      expect(present.has(ids[2])).toBe(true);
      expect(present.has(ids[3])).toBe(true);
      expect(afterRace.blocks.filter((b:any)=>b.id===ids[1]).length)
        .toBeLessThanOrEqual(1);
      expect(afterRace.blocks.length).toBe(present.has(ids[1])?4:3);
      if(present.has(ids[1])) {
        const conflict = await Promise.all([page,partner].map((client)=>
          client.evaluate(()=>(window as any).__structuralNotices as string[])));
        expect(conflict.flat().some((message)=>/Another editor|page changed/i.test(message)),
          "A rejected collision needs an explicit user-visible reason").toBe(true);
        await deleting.locator(".workspace-callout-content").click();
        await deleteToolbar.getByRole("button",{name:"Delete current block"}).click();
      }
      await expect.poll(async()=>describe((await canonical()).blocks),
        {timeout:30000}).toEqual(describe([
          {id:ids[0],type:"heading"},
          {id:ids[2],type:"quote"},
          {id:ids[3],type:"paragraph"},
        ]));
      for(const client of [page,partner]){
        await expect(client.locator(".workspace-callout")).toHaveCount(0);
        await expect(client.locator(".bn-editor blockquote"))
          .toContainText("Unrelated quote survives");
      }
      const beforePeer=await canonical();
      expect(beforePeer.plain_text).not.toContain("SAME_TARGET_SHOULD_BE_REMOVED");
      expect(beforePeer.blocks.filter((b:any)=>b.id===ids[1])).toHaveLength(0);
      expect(beforePeer.epoch).toBe(start.epoch);
      expect(beforePeer.revision).toBeGreaterThan(start.revision);

      // Force one later, acknowledged unrelated Yjs write after the
      // structural conflict. It must not reactivate the removed callout.
      const token=moveOwner?" PEER_AFTER_OWNER_MOVE":" PEER_AFTER_MEMBER_MOVE";
      await partner.locator(".bn-editor blockquote").click();
      await partner.keyboard.press("End");
      await partner.keyboard.insertText(token);
      await expect.poll(async()=>{
        const snap=await canonical();
        return snap.plain_text.includes(token)
          && snap.blocks.filter((b:any)=>b.id===ids[1]).length===0;
      },{timeout:30000}).toBe(true);
      await Promise.all([page.reload(),partner.reload()]);
      for(const client of [page,partner]){
        await expect(client.locator(".bn-editor blockquote")).toContainText(token);
        await expect(client.locator(".workspace-callout")).toHaveCount(0);
        await expect(client.locator(".bn-editor")).toContainText("Preserved tail");
      }
      const final=await canonical();
      expect(final.blocks.map((b:any)=>b.id).sort()).toEqual(remainingIds);
      expect(final.plain_text).not.toContain("SAME_TARGET_SHOULD_BE_REMOVED");
      expect(final.blocks.find((b:any)=>b.id===ids[2])?.type).toBe("quote");
      expect(final.epoch).toBe(start.epoch);
      expect(final.revision).toBeGreaterThan(beforePeer.revision);
    }
  }finally{
    await context.close();
  }
});


test("W11b browser: anchored comment, orphan badge and preserved stale draft", async ({page}) => {
  test.setTimeout(180000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceReq=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,title:"Anchored discussions "+randomUUID()},
  });
  expect(spaceReq.ok(),await spaceReq.text()).toBeTruthy();
  const space=await spaceReq.json();
  const pageReq=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,title:"Block comments "+randomUUID()},
  });
  expect(pageReq.ok(),await pageReq.text()).toBeTruthy();
  const resource=await pageReq.json();
  const url="/api/v1/pages/"+resource.id+"/content";
  const original=await (await page.request.get(url)).json();
  const firstId=randomUUID(),secondId=randomUUID(),thirdId=randomUUID();
  const seed=await page.request.patch(url,{headers,data:{
    expected_revision:original.revision,blocks:[
      {id:firstId,type:"heading",props:{level:2},content:"Anchor heading"},
      {id:secondId,type:"quote",content:"Still present"},
    ],
  }});
  expect(seed.ok(),await seed.text()).toBeTruthy();
  await page.goto("/?page="+resource.id);
  const heading=page.locator('.bn-block[data-id="'+firstId+'"]');
  await expect(heading).toBeVisible();
  await heading.click();
  await page.getByRole("button",{name:"Comment on selected block"}).click();
  const dialog=page.getByRole("dialog",{name:"Discussion"});
  await expect(dialog).toContainText("Commenting on selected heading");
  await dialog.locator("textarea").fill("This heading needs review");
  await dialog.getByRole("button",{name:"Post comment"}).click();
  await expect(dialog).toContainText("This heading needs review");
  await expect(dialog).toContainText("On heading");
  const comments=await (await page.request.get("/api/v1/resources/"+resource.id+"/comments")).json();
  const anchored=comments.find((comment:any)=>comment.body==="This heading needs review");
  expect(anchored?.block_id).toBe(firstId);
  await dialog.getByRole("button",{name:/close/i}).click();

  const current=await (await page.request.get(url)).json();
  const remove=await page.request.patch(url,{headers,data:{
    expected_revision:current.revision,blocks:[
      {id:secondId,type:"quote",content:"Still present"},
    ],
  }});
  expect(remove.ok(),await remove.text()).toBeTruthy();
  await page.getByRole("button",{name:"Comments",exact:true}).click();
  const orphan=page.getByRole("dialog",{name:"Discussion"});
  await expect(orphan).toContainText("Original block removed");
  await expect(orphan).toContainText("This heading needs review");
  await orphan.getByRole("button",{name:/close/i}).click();

  await page.reload();
  const quote=page.locator('.bn-block[data-id="'+secondId+'"]');
  await expect(quote).toBeVisible();
  await quote.click();
  await page.getByRole("button",{name:"Comment on selected block"}).click();
  const stale=page.getByRole("dialog",{name:"Discussion"});
  await stale.locator("textarea").fill("Retain my unsent draft");
  const before=await (await page.request.get(url)).json();
  const deleteTarget=await page.request.patch(url,{headers,data:{
    expected_revision:before.revision,blocks:[
      {id:thirdId,type:"paragraph",content:"Replacement body"},
    ],
  }});
  expect(deleteTarget.ok(),await deleteTarget.text()).toBeTruthy();
  await stale.getByRole("button",{name:"Post comment"}).click();
  await expect(stale.locator("textarea")).toHaveValue("Retain my unsent draft");
  await expect(stale).toContainText("Selected block removed");
  await stale.getByRole("button",{name:"Switch to page comment"}).click();
  await stale.getByRole("button",{name:"Post comment"}).click();
  await expect(stale).toContainText("Retain my unsent draft");
  const final=(await (await page.request.get("/api/v1/resources/"+resource.id+"/comments")).json())
    .find((c:any)=>c.body==="Retain my unsent draft");
  expect(final?.block_id).toBeNull();
});

test("W11d browser: two principals reply, resolve and revoke thread access",async ({page,browser})=>{
  test.setTimeout(180000);
  await login(page);
  await ensurePrincipalReadBudget(page);
  const ownerResponse=await page.request.get("/api/v1/me");
  expect(ownerResponse.ok(),await ownerResponse.text()).toBeTruthy();
  const owner=await ownerResponse.json();
  const ownerHeaders={"X-CSRF-Token":owner.csrf};
  const invitation=await page.request.post("/api/v1/members/invite",{
    headers:ownerHeaders,
    data:{name:"Discussion Partner",email:"threads-"+randomUUID()+"@example.test",role:"member"},
  });
  expect(invitation.ok(),await invitation.text()).toBeTruthy();
  const context=await browser.newContext();
  try {
    const memberPage=await context.newPage();
    await memberPage.goto((await invitation.json()).url);
    await expect(memberPage.getByRole("heading",{name:"Join your team."})).toBeVisible();
    await memberPage.getByLabel("Password",{exact:true}).fill("member-thread-test-password-123");
    await memberPage.getByRole("button",{name:"Accept invitation",exact:true}).click();
    await expect(memberPage.getByRole("heading",{name:"Welcome back, Discussion."})).toBeVisible();
    const member=await (await memberPage.request.get("/api/v1/me")).json();
    const roots=await (await page.request.get("/api/v1/resources")).json();
    const createdSpace=await page.request.post("/api/v1/resources",{
      headers:ownerHeaders,data:{kind:"space",parent_id:roots[0].id,
        title:"W11d shared discussions "+randomUUID()},
    });
    expect(createdSpace.ok(),await createdSpace.text()).toBeTruthy();
    const space=await createdSpace.json();
    const created=await page.request.post("/api/v1/resources",{
      headers:ownerHeaders,data:{kind:"page",parent_id:space.id,
        title:"W11d comment thread "+randomUUID()},
    });
    expect(created.ok(),await created.text()).toBeTruthy();
    const resource=await created.json();
    const url="/?page="+resource.id;
    const commentsApi="/api/v1/resources/"+resource.id+"/comments";
    await page.goto(url);
    await memberPage.goto(url);
    await page.getByRole("button",{name:"Comments",exact:true}).click();
    const ownerDialog=page.getByRole("dialog",{name:"Discussion"});
    await ownerDialog.getByRole("textbox",{name:"New comment text"})
      .fill("W11D_ROOT_KEEP_EXACT");
    await ownerDialog.getByRole("button",{name:"Post comment"}).click();
    await expect(ownerDialog).toContainText("W11D_ROOT_KEEP_EXACT");
    const rootListResponse=await page.request.get(commentsApi);
    expect(rootListResponse.ok(),await rootListResponse.text()).toBeTruthy();
    const rootList=await rootListResponse.json();
    const root=rootList.find((c:any)=>c.body==="W11D_ROOT_KEEP_EXACT");
    expect(root?.id).toBeTruthy();
    await ownerDialog.getByRole("button",{name:"Close dialog"}).click();
    await memberPage.getByRole("button",{name:"Comments",exact:true}).click();
    const peerDialog=memberPage.getByRole("dialog",{name:"Discussion"});
    await expect(peerDialog).toContainText("W11D_ROOT_KEEP_EXACT");
    await peerDialog.getByRole("button",{name:"Reply to "+root.author}).click();
    await expect(peerDialog).toContainText("Replying to "+root.author);
    await peerDialog.getByRole("textbox",{name:"Reply text"})
      .fill("W11D_PEER_REPLY_KEEP_EXACT");
    await peerDialog.getByRole("button",{name:"Post reply"}).click();
    await expect(peerDialog).toContainText("W11D_PEER_REPLY_KEEP_EXACT");
    const listResponse=await page.request.get(commentsApi);
    expect(listResponse.ok(),await listResponse.text()).toBeTruthy();
    const list=await listResponse.json();
    const reply=list.find((c:any)=>c.body==="W11D_PEER_REPLY_KEEP_EXACT");
    expect(reply?.parent_comment_id).toBe(root.id);
    await expect(peerDialog.locator('[data-parent-comment-id="'+root.id+'"]'))
      .toContainText("W11D_PEER_REPLY_KEEP_EXACT");
    await peerDialog.getByRole("button",{name:"Close dialog"}).click();
    await page.getByRole("button",{name:"Comments",exact:true}).click();
    const ownerAgain=page.getByRole("dialog",{name:"Discussion"});
    await expect(ownerAgain).toContainText("W11D_PEER_REPLY_KEEP_EXACT");
    const rootCard=ownerAgain.locator('[data-comment-id="'+root.id+'"]');
    await rootCard.getByRole("button",{name:"Resolve",exact:true}).click();
    await expect(rootCard).toContainText("Resolved");
    await expect(rootCard.getByRole("button",{name:"Reply to "+root.author})).toHaveCount(0);
    const resolvedAttempt=await memberPage.request.post(commentsApi,{
      headers:{"X-CSRF-Token":member.csrf},
      data:{body:"W11D_NO_REPLY_AFTER_RESOLVE",reply_to:root.id},
    });
    expect(resolvedAttempt.status()).toBe(409);
    await ownerAgain.getByRole("button",{name:"Close dialog"}).click();
    // Remove the explicit grant, disable inheritance: revoked actor must not
    // see either root/reply via API, even with known thread and resource IDs.
    await page.getByRole("button",{name:"Page actions"}).click();
    await page.getByRole("button",{name:"Manage access",exact:true}).click();
    const access=page.getByRole("dialog",{name:"Manage access"});
    await access.getByRole("button",{name:"Add person or integration"}).click();
    await access.getByLabel("Principal",{exact:true}).selectOption(member.user.id);
    await access.getByLabel("Access level",{exact:true}).selectOption("1");
    await access.getByRole("button",{name:"Save access",exact:true}).click();
    await expect(access).toBeHidden();
    expect((await memberPage.request.get(commentsApi)).status()).toBe(200);
    await page.getByRole("button",{name:"Page actions"}).click();
    await page.getByRole("button",{name:"Manage access",exact:true}).click();
    await access.getByRole("button",{name:"Remove grant"}).click();
    await access.getByLabel("Inherit access from parent").uncheck();
    await access.getByRole("button",{name:"Save access",exact:true}).click();
    // Save closes only after the permission PATCH has committed; use that
    // user-visible boundary before making the revoked-principal request.
    await expect(access).toBeHidden();
    expect((await memberPage.request.get(commentsApi)).status()).toBe(404);
    expect((await memberPage.request.get("/api/v1/notifications")).ok()).toBeTruthy();
    const notification=await (await memberPage.request.get("/api/v1/notifications")).json();
    expect(notification.some((n:any)=>n.resource_id===resource.id)).toBe(false);
    const retained=await (await page.request.get(commentsApi)).json();
    expect(retained.some((c:any)=>c.id===reply.id&&c.body==="W11D_PEER_REPLY_KEEP_EXACT"))
      .toBe(true);
  }finally{await context.close();}
});

test("W12a browser: new notification inbox filters mentions and rechecks destination",async ({page})=>{
  test.setTimeout(90000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceResponse=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"Inbox space "+randomUUID()},
  });
  expect(spaceResponse.ok(),await spaceResponse.text()).toBeTruthy();
  const space=await spaceResponse.json();
  const title="Mention inbox "+randomUUID();
  const create=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,title},
  });
  expect(create.ok(),await create.text()).toBeTruthy();
  const resource=await create.json();
  const mention=await page.request.post("/api/v1/resources/"+resource.id+"/comments",{
    headers,data:{body:"Please review @{"+me.user.id+"}"},
  });
  expect(mention.ok(),await mention.text()).toBeTruthy();
  await page.goto("/");
  await page.getByRole("button",{name:"Inbox",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Inbox"})).toBeVisible();
  const filter=page.getByRole("textbox",{name:"Filter notifications"});
  const item=page.getByRole("button",{name:/Open notification:.*mentioned you/}).filter({
    hasText:title,
  });
  await expect(item).toBeVisible();
  await filter.fill("Definitely no such message "+randomUUID());
  await expect(item).toHaveCount(0);
  await expect(page.getByText("No notifications match your filter.")).toBeVisible();
  await filter.fill(title);
  await expect(item).toBeVisible();
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByRole("textbox",{name:"Page title"})).toHaveValue(title);
  const seen=await (await page.request.get("/api/v1/notifications")).json();
  expect(seen.some((notice:any)=>notice.resource_id===resource.id)).toBe(true);
});

test("W12b browser: read/unread persisted across reload and unread filter",async ({page})=>{
  test.setTimeout(90000);
  await login(page);
  const me=await (await page.request.get("/api/v1/me")).json();
  const headers={"X-CSRF-Token":me.csrf};
  const roots=await (await page.request.get("/api/v1/resources")).json();
  const spaceRes=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,title:"Receipt space "+randomUUID()},
  });
  expect(spaceRes.ok(),await spaceRes.text()).toBeTruthy();
  const space=await spaceRes.json();
  const name="Read receipt "+randomUUID();
  const pageRes=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"page",parent_id:space.id,title:name},
  });
  expect(pageRes.ok(),await pageRes.text()).toBeTruthy();
  const target=await pageRes.json();
  const mention=await page.request.post("/api/v1/resources/"+target.id+"/comments",{
    headers,data:{body:"Receipt please @{"+me.user.id+"}"},
  });
  expect(mention.ok(),await mention.text()).toBeTruthy();
  await page.goto("/");
  await page.getByRole("button",{name:"Inbox",exact:true}).click();
  const row=page.locator(".notification-inbox-row").filter({hasText:name});
  await expect(row).toBeVisible();
  const unread=page.getByRole("checkbox",{name:"Unread only"});
  await unread.check();
  await expect(row).toBeVisible();
  await row.getByRole("button",{name:/^Mark read:/}).click();
  await expect(row).toHaveCount(0);
  await unread.uncheck();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button",{name:/^Mark unread:/})).toBeVisible();
  await page.reload();
  await page.getByRole("button",{name:"Inbox",exact:true}).click();
  const retained=page.locator(".notification-inbox-row").filter({hasText:name});
  await expect(retained.getByRole("button",{name:/^Mark unread:/})).toBeVisible();
  await retained.getByRole("button",{name:/^Mark unread:/}).click();
  await expect(retained.getByRole("button",{name:/^Mark read:/})).toBeVisible();
  const apiResult=await (await page.request.get("/api/v1/notifications")).json();
  expect(apiResult.find((n:any)=>n.resource_id===target.id)?.read_at).toBeNull();
});


test("W12d browser: user controls mention and reply alerts with persisted preferences",async({page})=>{
  test.setTimeout(90000);
  await login(page);
  await page.goto("/");
  await page.getByRole("button",{name:"Inbox",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Inbox"})).toBeVisible();
  const mentions=page.getByRole("checkbox",{name:"Mention alerts"});
  const replies=page.getByRole("checkbox",{name:"Reply alerts"});
  await expect(mentions).toBeChecked();
  await expect(replies).toBeChecked();
  await mentions.uncheck();
  await replies.uncheck();
  await page.getByRole("button",{name:"Save preferences"}).click();
  await expect(page.getByRole("button",{name:"Save preferences"})).toBeEnabled();
  await page.reload();
  await page.getByRole("button",{name:"Inbox",exact:true}).click();
  await expect(mentions).not.toBeChecked();
  await expect(replies).not.toBeChecked();
  const response=await page.request.get("/api/v1/notification-preferences");
  expect(response.ok(),await response.text()).toBeTruthy();
  expect(await response.json()).toEqual({
    mentions_enabled:false,replies_enabled:false,
  });
  await mentions.check();
  await replies.check();
  await page.getByRole("button",{name:"Save preferences"}).click();
  await expect(mentions).toBeChecked();
  await expect(replies).toBeChecked();
});


// Attempts less than 2.5s apart belong to one dialog effect run. Grouping them
// keeps the bounded-retry assertion deterministic even if the effect runs more
// than once during the dialog's life.
function attemptsInFirstBurst(attemptedAt: number[]): number[] {
  const burst: number[] = [];
  for (const t of attemptedAt) {
    if (burst.length && t - burst[burst.length - 1] > 2500) break;
    burst.push(t);
  }
  return burst;
}

test("W09b2 deployed browser recovers the append target after one throttled destination list request", async ({page}) => {
  const attemptedAt: number[] = [];
  let spaceId = "";
  await page.route(/\/api\/v1\/resources\?parent_id=[^&]+&limit=200/, async (r) => {
    const parent = new URL(r.request().url()).searchParams.get("parent_id");
    if (!spaceId || parent !== spaceId) return r.continue();
    attemptedAt.push(Date.now());
    if (attemptedAt.length <= 1)
      return r.fulfill({status:429,contentType:"application/json",
        headers:{"retry-after":"1"},body:JSON.stringify({error:"Too many requests"})});
    return r.continue();
  });
  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = {"X-CSRF-Token":me.csrf};
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const stamp=Date.now();
  const spaceRequest=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W09b CSV space "+stamp},
  });
  expect(spaceRequest.ok(),await spaceRequest.text()).toBeTruthy();
  const space=await spaceRequest.json();
  spaceId = space.id;
  const dbRequest=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"database",parent_id:space.id,
      title:"W09b Existing Target "+stamp},
  });
  expect(dbRequest.ok(),await dbRequest.text()).toBeTruthy();
  const database=await dbRequest.json();
  await page.getByRole("button",{name:/Import your work/}).click();
  const dialog=page.getByRole("dialog",{name:"Import your work"});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Create in").selectOption(space.id);
  await dialog.locator('input[type="file"]').setInputFiles({
    name:"mapped-append.csv",mimeType:"text/csv",
    buffer:Buffer.from(["Name", "New item"].join(String.fromCharCode(10))),
  });
  const destination=dialog.getByLabel("Import destination mode");
  // The injected 429 must not leave the append target permanently unselectable.
  await expect(destination.locator(`option[value="${database.id}"]`)).toHaveCount(1);
  const burst = attemptsInFirstBurst(attemptedAt);
  expect(burst.length, "the throttled request is retried exactly once").toBe(2);
  const gap = burst[1] - burst[0];
  expect(gap, "the retry waits the bounded backoff instead of spinning").toBeGreaterThanOrEqual(1400);
  expect(gap, "the retry stays inside the bounded policy").toBeLessThanOrEqual(5000);
});

test("W09b3 deployed browser stops after three throttled destination list attempts and surfaces the error", async ({page}) => {
  const attemptedAt: number[] = [];
  let spaceId = "";
  await page.route(/\/api\/v1\/resources\?parent_id=[^&]+&limit=200/, async (r) => {
    const parent = new URL(r.request().url()).searchParams.get("parent_id");
    if (!spaceId || parent !== spaceId) return r.continue();
    attemptedAt.push(Date.now());
    if (attemptedAt.length <= 3)
      return r.fulfill({status:429,contentType:"application/json",
        headers:{"retry-after":"1"},body:JSON.stringify({error:"Too many requests"})});
    return r.continue();
  });
  await login(page);
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = {"X-CSRF-Token":me.csrf};
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const stamp=Date.now();
  const spaceRequest=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"space",parent_id:roots[0].id,
      title:"W09b CSV space "+stamp},
  });
  expect(spaceRequest.ok(),await spaceRequest.text()).toBeTruthy();
  const space=await spaceRequest.json();
  spaceId = space.id;
  const dbRequest=await page.request.post("/api/v1/resources",{
    headers,data:{kind:"database",parent_id:space.id,
      title:"W09b Existing Target "+stamp},
  });
  expect(dbRequest.ok(),await dbRequest.text()).toBeTruthy();
  const database=await dbRequest.json();
  await page.getByRole("button",{name:/Import your work/}).click();
  const dialog=page.getByRole("dialog",{name:"Import your work"});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Create in").selectOption(space.id);
  await dialog.locator('input[type="file"]').setInputFiles({
    name:"mapped-append.csv",mimeType:"text/csv",
    buffer:Buffer.from(["Name", "New item"].join(String.fromCharCode(10))),
  });
  const destination=dialog.getByLabel("Import destination mode");
  // Bounded: three attempts, then the error surfaces. Never a fourth attempt.
  await expect.poll(() => attemptsInFirstBurst(attemptedAt).length, {timeout:30000}).toBe(3);
  await page.waitForTimeout(3000);
  expect(attemptsInFirstBurst(attemptedAt).length,
    "no fourth attempt: the retry loop is bounded").toBe(3);
  await expect(page.locator('.toast[role="alert"]')).toBeVisible({timeout:15000});
  expect(await destination.locator(`option[value="${database.id}"]`).count(),
    "the target really is unavailable, the failure is not hidden").toBe(0);
});
