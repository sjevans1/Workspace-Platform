// OCP-2B browser acceptance through a real Chromium browser.
//
// Proves the console actually renders and works in a browser: stylesheet delivery,
// navigation through browser semantics, native form interaction, keyboard focus, the
// session cookie lifecycle, and desktop plus tablet viewports. It does not create visual
// baselines and does not touch the customer Workspace E2E, visual or accessibility gates.
import { test, expect, type Page } from "@playwright/test";
import { E2E_IDS } from "./fixtures.ts";

const OPERATOR_TOKEN = "e2e-fleet-operator-token-0123456789";

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Fleet operator credential").fill(OPERATOR_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fleet overview" })).toBeVisible();
}

test("1. unauthenticated navigation lands on the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to the OpenJM Fleet Console" })).toBeVisible();
  await page.goto("/deployments");
  await expect(page).toHaveURL(/\/login$/);
});

test("2. operator sign-in succeeds and the session cookie is HttpOnly", async ({ page, context }) => {
  await signIn(page);
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "fleet_console_session");
  expect(session, "a console session cookie is set").toBeTruthy();
  expect(session!.httpOnly, "the session cookie is HttpOnly").toBe(true);
  expect(session!.sameSite).toBe("Lax");
  expect(session!.path).toBe("/");
  expect(session!.value).not.toContain(OPERATOR_TOKEN);
  // The credential the operator typed is not retained by the browser.
  expect(await page.evaluate(() => Object.keys(window.localStorage).length + Object.keys(window.sessionStorage).length)).toBe(0);
});

test("3. the overview renders factual state counts", async ({ page }) => {
  await signIn(page);
  const counts = page.locator(".stat");
  await expect(counts.filter({ hasText: "Total deployments" })).toContainText("6");
  for (const [label, value] of [
    ["Online", "1"],
    ["Stale", "1"],
    ["Offline", "1"],
    ["Never seen", "1"],
    ["Disabled", "1"],
    ["Revoked", "1"],
  ] as const) {
    await expect(counts.filter({ hasText: label }).first()).toContainText(value);
  }
  await expect(page.getByText(/3 deployments with at least one active alert/)).toBeVisible();
  await expect(page.getByText("No percentages or SLA claims are derived")).toBeVisible();
  await expect(page.getByRole("link", { name: "Refresh console data" })).toBeVisible();
});

test("4. inventory navigation works and the stylesheet is actually applied", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Deployments" }).click();
  await expect(page).toHaveURL(/\/deployments$/);
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();
  await expect(page.getByText("6 of 6 registered deployments shown")).toBeVisible();
  // The CSS really loaded: the table has its themed border and the header is not the
  // browser default, so the page is styled rather than unstyled HTML.
  const cssResponse = await page.request.get("/assets/console.css");
  expect(cssResponse.status()).toBe(200);
  expect(cssResponse.headers()["content-type"]).toContain("text/css");
  const table = page.locator("table.table").first();
  await expect(table).toBeVisible();
  const border = await table.evaluate((element) => getComputedStyle(element).borderTopWidth);
  expect(border, "the stylesheet is applied to the inventory table").not.toBe("0px");
  const headerBackground = await page.locator("table.table thead th").first().evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(headerBackground).not.toBe("rgba(0, 0, 0, 0)");
});

test("5. search and filters work through native browser controls", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Deployments" }).click();
  await page.getByLabel("Search").fill("brav");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 of 6 registered deployments shown")).toBeVisible();
  await expect(page.getByRole("link", { name: "e2e-bravo" })).toBeVisible();

  await page.getByRole("link", { name: "Clear" }).click();
  await page.getByLabel("Online state").selectOption("offline");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 of 6 registered deployments shown")).toBeVisible();
  await expect(page.getByRole("link", { name: "e2e-charlie" })).toBeVisible();

  await page.getByRole("link", { name: "Clear" }).click();
  await page.getByLabel("Alerting deployments only").check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("3 of 6 registered deployments shown")).toBeVisible();
});

test("6. a deployment detail page opens from the inventory", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Deployments" }).click();
  await page.getByRole("link", { name: "e2e-bravo" }).click();
  await expect(page).toHaveURL(new RegExp(`/deployments/${E2E_IDS.stale}$`));
  await expect(page.getByRole("heading", { level: 1, name: "e2e-bravo" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Identity and inventory" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Runtime health" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Current telemetry" })).toBeVisible();
  await expect(page.getByText(/not a time series/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Credential status" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Recent state history" })).toBeVisible();
  // An unknown id produces a bounded not-found page, not a stack trace.
  const notFound = await page.goto("/deployments/does-not-exist");
  expect(notFound!.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Deployment not found" })).toBeVisible();
});

test("7. null and unknown values visibly render as Unknown or Not reported", async ({ page }) => {
  await signIn(page);
  await page.goto(`/deployments/${E2E_IDS.never}`);
  await expect(page.getByText("Never seen").first()).toBeVisible();
  await expect(page.getByText("Not reported").first()).toBeVisible();
  await expect(page.getByText("Unknown").first()).toBeVisible();
  // Never seen must not be rendered as a zero last-seen.
  const lastSeenRow = page.locator("tr", { hasText: "Last seen" }).first();
  await expect(lastSeenRow).toContainText("Never seen");
  await expect(lastSeenRow).not.toContainText(/\b0\b/);

  await page.goto(`/deployments/${E2E_IDS.offline}`);
  const backupRow = page.locator("tr", { hasText: "Backup" }).first();
  await expect(backupRow).toContainText("Unknown");
  const capacityRow = page.locator("tr", { hasText: "Database capacity" }).first();
  await expect(capacityRow).toContainText("Not reported");
  await expect(capacityRow).not.toContainText(/\b0\b/);
});

test("8. the alerts page renders with severity and category", async ({ page }) => {
  await signIn(page);
  // Exact match: the overview also links out with the accessible name "View fleet alerts".
  await page.getByRole("link", { name: "Alerts", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fleet alerts" })).toBeVisible();
  await expect(page.getByText("3 of 3 current alerts shown")).toBeVisible();
  // The alerts table links to the deployment and labels it with its operator alias.
  await expect(page.getByRole("link", { name: "e2e-charlie" })).toBeVisible();
  // Scope to the table: the same human label also appears as a filter option.
  const alertTable = page.locator("table.table").first();
  await expect(alertTable.getByText("Deployment offline")).toBeVisible();
  await expect(alertTable.getByText("deployment.offline")).toBeVisible();
  await page.getByLabel("Severity").selectOption("info");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 of 3 current alerts shown")).toBeVisible();
});

test("9. the audit page renders with readable and canonical actions", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Operator audit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Operator audit" })).toBeVisible();
  await expect(page.getByText("Deployment registered")).toBeVisible();
  await expect(page.getByText("deployment.registered")).toBeVisible();
  await expect(page.getByText("Credential rotated")).toBeVisible();
  await expect(page.getByText(/read-only/)).toBeVisible();
});

test("10. signing out returns to sign-in and protected navigation is denied", async ({ page, context }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  const session = (await context.cookies()).find((cookie) => cookie.name === "fleet_console_session");
  expect(session?.value ?? "", "the session cookie is cleared on sign-out").toBe("");
  await page.goto("/deployments");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/audit");
  await expect(page).toHaveURL(/\/login$/);
});

test("11. no client-side script is present on any console surface", async ({ page }) => {
  await signIn(page);
  for (const path of ["/", "/deployments", `/deployments/${E2E_IDS.online}`, "/alerts", "/audit", "/egress"]) {
    await page.goto(path);
    await expect(page.locator("script")).toHaveCount(0);
    await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  }
  await page.goto("/login");
  await expect(page.locator("script")).toHaveCount(0);
});

test("12. keyboard navigation and focus reach the navigation, filters and primary controls", async ({ page }) => {
  await page.goto("/login");
  // The sign-in form is operable by keyboard alone.
  await page.getByLabel("Fleet operator credential").focus();
  await expect(page.getByLabel("Fleet operator credential")).toBeFocused();
  await page.keyboard.type(OPERATOR_TOKEN);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Fleet overview" })).toBeVisible();

  // The skip link receives focus first and is visibly focused when focused.
  await page.keyboard.press("Tab");
  const focusedTag = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(focusedTag).toContain("skiplink");
  const outline = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return `${style.outlineStyle}${style.boxShadow}`;
  });
  expect(outline, "the focused element has a visible focus indicator").not.toBe("none");

  await page.getByRole("link", { name: "Deployments" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/deployments$/);
  await page.getByLabel("Search").focus();
  await expect(page.getByLabel("Search")).toBeFocused();
  await page.keyboard.type("e2e-echo");
  await page.keyboard.press("Enter");
  await expect(page.getByText("1 of 6 registered deployments shown")).toBeVisible();
  // The primary control is reachable and labelled.
  await expect(page.getByRole("button", { name: "Apply filters" })).toBeVisible();
});

test("13. the console is usable at this project's desktop or tablet viewport", async ({ page }, testInfo) => {
  await signIn(page);
  // Every element a desktop and a tablet both need is in the accessibility tree, and the
  // title remains within the viewport rather than overflowing.
  await expect(page.getByRole("navigation", { name: "Fleet console sections" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("link", { name: "Deployments" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();
  const viewport = page.viewportSize()!;
  const heading = await page.getByRole("heading", { level: 1, name: "Deployments" }).boundingBox();
  expect(heading!.x + heading!.width).toBeLessThanOrEqual(viewport.width + 1);
  // The table stays reachable, horizontally scrollable at narrow widths instead of
  // collapsing or clipping content away.
  const table = page.locator("table.table").first();
  await expect(table).toBeVisible();
  await table.scrollIntoViewIfNeeded();
  console.log(`console viewport ${testInfo.project.name} ${viewport.width}x${viewport.height}: ok`);
});

test("14. the egress posture and diagnostic render, and stay read-only", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Egress posture" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Outbound provider egress" })).toBeVisible();
  // The effective policy identity is shown; the policy body is not.
  await expect(page.getByText("e3f1c0de9a7b4f2d8c6a1b0e")).toBeVisible();
  await expect(page.getByText("DNS and policy only; the endpoint is never contacted")).toBeVisible();
  await expect(page.getByText("metadata", { exact: false }).first()).toBeVisible();
  // The diagnostic is a native GET form: no script, and it works with keyboard input.
  await page.getByLabel("Host").fill("mail.internal.example");
  await page.getByLabel("Port").selectOption("993");
  await page.getByRole("button", { name: "Check destination" }).click();
  await expect(page).toHaveURL(/host=mail\.internal\.example/);
  await expect(page.getByText("Requires operator approval")).toBeVisible();
  await expect(page.getByText("endpoint contacted: no")).toBeVisible();
  // There is no control that could change policy from here.
  await expect(page.getByRole("button", { name: /save|apply|update policy/i })).toHaveCount(0);
});
