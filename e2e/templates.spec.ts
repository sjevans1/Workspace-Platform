import { test, expect, type Page } from "@playwright/test";
import { recoverOnce, assertWorkspaceShell } from "./support/readiness";

// Wave X X2.5 (W25-T): deployed browser acceptance for the curated template
// library. Native tests cover every definition; this covers the representative
// execution classes end to end. Readiness reuses the shared CI-H2 primitive -
// no sleeps and no local retry logic.

const email = "browser@example.test",
  password = "browser-password-123";

async function login(page: Page) {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible({ timeout: 30000 });
  if (
    await page.getByRole("button", { name: "Sign in", exact: true }).isVisible()
  ) {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await recoverOnce(
    "templates-shell",
    () => assertWorkspaceShell(page),
    async () => {
      await page.goto("/");
    },
  );
}

test("W25-T browser: browse, filter, instantiate and verify template classes", async ({
  page,
}) => {
  test.setTimeout(240000);
  await login(page);

  // Category browsing and type distinction.
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Templates", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/of \d+ templates/)).toBeVisible();

  const typeFilter = page.getByLabel("Filter templates by type");
  await typeFilter.selectOption("space");
  const spaceCards = page.locator(".template-card");
  await expect(spaceCards.first().getByText("Multi-resource")).toBeVisible();
  expect(await spaceCards.count()).toBe(5);

  await typeFilter.selectOption("database");
  await expect(page.locator(".template-card").first().getByText("Database")).toBeVisible();
  await typeFilter.selectOption("page");
  await expect(page.locator(".template-card").first().getByText("Page", { exact: true })).toBeVisible();
  await typeFilter.selectOption("All");

  const categoryFilter = page.getByLabel("Filter templates by category");
  await categoryFilter.selectOption("HR & People");
  await expect(
    page.locator(".template-card").filter({ hasText: "HR Workspace" }),
  ).toBeVisible();

  // Multi-resource instantiation: Project Management.
  await categoryFilter.selectOption("Projects & Delivery");
  await page
    .locator(".template-card")
    .filter({ hasText: "Project Management" })
    .click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
    "Project Management",
    { timeout: 30000 },
  );

  // Database instantiation: Sales pipeline, with its schema, views and starter record.
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await categoryFilter.selectOption("Sales & CRM");
  await page
    .locator(".template-card")
    .filter({ hasText: "Sales pipeline" })
    .click();
  await expect(page.getByRole("table")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Example: Acme renewal")).toBeVisible();
  // The template's own board view exists and is usable.
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);

  // Remapped cross-resource relation, proven on the deployed stack.
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const space = roots.find((r: any) => r.title === "Project Management");
  expect(space, "multi-resource template space must exist").toBeTruthy();
  const children = await (
    await page.request.get(`/api/v1/resources?parent_id=${space.id}&limit=200`)
  ).json();
  const tasks = children.find((c: any) => c.title === "Tasks");
  const projects = children.find((c: any) => c.title === "Projects");
  const taskRows = await (
    await page.request.get(`/api/v1/databases/${tasks.id}/records`)
  ).json();
  const projectRows = await (
    await page.request.get(`/api/v1/databases/${projects.id}/records`)
  ).json();
  expect(
    taskRows[0].values.project,
    "starter task must reference the generated starter project record",
  ).toEqual([projectRows[0].id]);

  // Navigation into a created resource.
  await page.goto("/?page=" + tasks.id);
  await expect(page.getByRole("table")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Example: draft brief")).toBeVisible();
});
