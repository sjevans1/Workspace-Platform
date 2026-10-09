import { test, expect, type Page, type Browser } from "@playwright/test";
import { FIXTURE } from "./fixtures/catalog";
import { readVisualFixture, type VisualFixture } from "./support/visual-fixture";

// Wave X X2: deterministic visual regression, Chromium only, light and dark,
// desktop and phone. Every surface is built from the synthetic fixture in
// e2e/fixtures/catalog.ts. Snapshots must never contain IDs, timestamps or
// customer content.
//
// Baselines are committed artefacts. CI NEVER updates them (see
// docs/VISUAL_REGRESSION.md); they are regenerated only by the explicit
// .github/workflows/visual-baselines.yml dispatch.

const statePath = process.env.E2E_AUTH_STATE || "e2e/.auth/session.json";

async function authenticatedPage(browser: Browser): Promise<Page> {
  const info = test.info();
  const context = await browser.newContext({
    storageState: statePath,
    colorScheme: info.project.use.colorScheme,
    viewport: info.project.use.viewport,
  });
  return context.newPage();
}

// At phone width the sidebar is off-canvas, so any surface that lives in the
// navigation opens it first. This is viewport behaviour, not an engine or
// product defect. The open state is signalled by the "Close navigation"
// backdrop (the W16 journey uses the same contract) because the off-canvas
// panel's own CSS visibility does not report reliably.
async function openNavigation(page: Page) {
  const sidebar = page.locator(".sidebar");
  if (await sidebar.isVisible()) return;
  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  if (!(await toggle.isVisible())) return;
  await toggle.click();
  const backdrop = page.getByRole("button", { name: "Close navigation" });
  if (await backdrop.isVisible().catch(() => false)) return;
  await page.waitForTimeout(300);
}

// The deterministic fixture is seeded once by the setup project
// (e2e/auth.setup.ts) and its ids are read here, so the four snapshot projects
// do not repeat the writes and exhaust the shared API budget.
let fixture: VisualFixture;

test.beforeAll(() => {
  fixture = readVisualFixture();
});

test("sign-in surface", async ({ browser }) => {
  // A dedicated unauthenticated context: the project default is authenticated.
  const info = test.info();
  const context = await browser.newContext({
    colorScheme: info.project.use.colorScheme,
    viewport: info.project.use.viewport,
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page).toHaveScreenshot("sign-in.png", { fullPage: true });
  await context.close();
});

test("workspace shell with sidebar", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/");
  await openNavigation(page);
  await expect(page).toHaveScreenshot("workspace-shell.png");
  await page.context().close();
});

test("page with the core block set", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/?page=" + fixture.pageId);
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
    FIXTURE.page,
  );
  await expect(page).toHaveScreenshot("page-blocks.png");
  await page.context().close();
});

test("database table", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/?page=" + fixture.databaseId);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page).toHaveScreenshot("database-table.png");
  await page.context().close();
});

test("database board", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/?page=" + fixture.databaseId);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page).toHaveScreenshot("database-board.png");
  await page.context().close();
});

test("database calendar", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/?page=" + fixture.databaseId);
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveScreenshot("database-calendar.png");
  await page.context().close();
});

test("branding and settings surface", async ({ browser }) => {
  // Settings is a modal surface reached from the navigation. At phone width the
  // off-canvas navigation cannot expose it deterministically to Playwright, so
  // it is captured at desktop; phone coverage is provided by the other seven
  // surfaces. Documented in docs/VISUAL_REGRESSION.md.
  test.skip(
    (test.info().project.use.viewport?.width ?? 0) < 800,
    "Settings surface is captured at desktop only",
  );
  const page = await authenticatedPage(browser);
  await page.goto("/");
  await openNavigation(page);
  await page
    .getByRole("button", { name: "Settings & members", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Settings & members", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot("settings.png");
  await page.context().close();
});

test("manage access dialog", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/?page=" + fixture.pageId);
  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Manage access" }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot("manage-access.png");
  await page.context().close();
});

// Canary: deliberately mutate a surface and compare against the committed
// baseline. This test MUST fail when the harness is trusted; CI runs it with
// `--grep @canary` and asserts a non-zero exit (see .github/workflows/ci.yml).
test("@canary intentional visual drift is detected", async ({ browser }) => {
  const page = await authenticatedPage(browser);
  await page.goto("/?page=" + fixture.databaseId);
  await expect(page.getByRole("table")).toBeVisible();
  await page.addStyleTag({
    content: "body{filter:invert(1) hue-rotate(90deg) !important}",
  });
  await expect(page).toHaveScreenshot("database-table.png", {
    maxDiffPixelRatio: 0,
  });
  await page.context().close();
});
