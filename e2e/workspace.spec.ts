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
    return (await response.json()).some((v: any) => v.id === sourceId);
  }, { timeout: 12000 }).toBe(true);
  await page.goto("/?page=" + targetId);
  await expect(page.getByRole("heading", { name: "Linked from", exact: true }))
    .toBeVisible();
  const backlink = page.locator(".backlink-items")
    .getByRole("button", { name: sourceName, exact: true });
  await expect(backlink).toBeVisible();
  await backlink.click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(sourceName);
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
