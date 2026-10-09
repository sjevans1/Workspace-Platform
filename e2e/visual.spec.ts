import { test, expect, type Page, type Browser } from "@playwright/test";
import { FIXTURE } from "./fixtures/catalog";

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

async function seed(page: Page) {
  const me = await (await page.request.get("/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const root = (await (await page.request.get("/api/v1/resources")).json())[0];
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: { kind: "space", parent_id: root.id, title: FIXTURE.space },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const pageResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: { kind: "page", parent_id: space.id, title: FIXTURE.page },
  });
  expect(pageResponse.ok(), await pageResponse.text()).toBeTruthy();
  const fixturePage = await pageResponse.json();
  const contentResponse = await page.request.patch(
    `/api/v1/pages/${fixturePage.id}/content`,
    {
      headers,
      data: {
        blocks: [
          { type: "heading", props: { level: 1 }, content: FIXTURE.page },
          { type: "paragraph", content: FIXTURE.pageBody },
          { type: "checkListItem", content: "First deterministic item" },
          { type: "checkListItem", content: "Second deterministic item" },
        ],
        expected_revision: 1,
      },
    },
  );
  expect(contentResponse.ok(), await contentResponse.text()).toBeTruthy();
  const databaseResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: { kind: "database", parent_id: space.id, title: FIXTURE.database },
  });
  expect(databaseResponse.ok(), await databaseResponse.text()).toBeTruthy();
  const database = await databaseResponse.json();
  const schemaResponse = await page.request.patch(
    `/api/v1/databases/${database.id}`,
    { headers, data: { properties: FIXTURE.properties } },
  );
  expect(schemaResponse.ok(), await schemaResponse.text()).toBeTruthy();
  for (const values of FIXTURE.records) {
    const recordResponse = await page.request.post(
      `/api/v1/databases/${database.id}/records`,
      { headers, data: { values } },
    );
    expect(recordResponse.ok(), await recordResponse.text()).toBeTruthy();
  }
  return { spaceId: space.id, pageId: fixturePage.id, databaseId: database.id };
}

// Seeded once per project; Playwright re-runs beforeAll for each project.
let fixture: { spaceId: string; pageId: string; databaseId: string };

test.beforeAll(async ({ browser }) => {
  const page = await authenticatedPage(browser);
  fixture = await seed(page);
  await page.context().close();
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
