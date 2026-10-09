import { expect, type Page } from "@playwright/test";
import { FIXTURE } from "../fixtures/catalog";

const email = "browser@example.test",
  password = "browser-password-123";

// Self-contained sign-in/setup for the deterministic harness. Deliberately does
// NOT extend the product specs so the harness can run on WebKit and on the
// viewport matrix without touching the existing accessibility journeys.
export async function login(page: Page) {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible({ timeout: 30000 });
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
  ).toBeVisible({ timeout: 20000 });
}

export type SeededFixture = {
  spaceId: string;
  pageId: string;
  databaseId: string;
};

/**
 * Seed the deterministic fixture through the real API. IDs are generated, so
 * callers must fingerprint only fixture text, never IDs.
 */
export async function seedDeterministicFixture(
  page: Page,
): Promise<SeededFixture> {
  const meResponse = await page.request.get("/api/v1/me");
  expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
  const me = await meResponse.json();
  const headers = { "X-CSRF-Token": me.csrf };
  const rootsResponse = await page.request.get("/api/v1/resources");
  expect(rootsResponse.ok(), await rootsResponse.text()).toBeTruthy();
  const root = (await rootsResponse.json())[0];

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

/**
 * An ID-free, order-stable fingerprint of the fixture database table. Used by
 * the determinism proof: three consecutive runs must produce the identical
 * string. Only fixture text is included, never generated resource IDs.
 */
export async function fixtureFingerprint(
  page: Page,
  databaseId: string,
): Promise<string> {
  await page.goto("/?page=" + databaseId);
  await expect(page.getByRole("table")).toBeVisible();
  const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
  const table = page.getByRole("table");
  const headers = (await table.getByRole("columnheader").allInnerTexts())
    .map(normalise)
    .sort();
  const cells = (await table.getByRole("cell").allInnerTexts())
    .map(normalise)
    .filter(Boolean)
    .sort();
  // Database record cells are editable, so record text lives in form fields.
  const inputs = (
    await table
      .locator("input, textarea")
      .evaluateAll((elements) =>
        elements.map(
          (element) =>
            (element as HTMLInputElement | HTMLTextAreaElement).value ||
            element.textContent ||
            "",
        ),
      )
  )
    .map(normalise)
    .filter(Boolean)
    .sort();
  const rows = await table.getByRole("row").count();
  return JSON.stringify({ headers, cells, inputs, rows });
}
