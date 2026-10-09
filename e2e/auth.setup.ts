import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Wave X: authenticate ONCE and persist the real session for every engine and
// viewport project.
//
// Playwright starts a fresh worker process per (file, project) group, so a
// module-level cookie cache does not survive from one project to the next. That
// made each project sign in separately and exhausted the deployed sign-in
// route's strict production budget (10 attempts / 5 minutes per network), which
// the later projects hit as a 429 with a >30s Retry-After. A setup project that
// writes storageState is the supported way to authenticate once.
const email = "browser@example.test",
  password = "browser-password-123";
const statePath = process.env.E2E_AUTH_STATE || "e2e/.auth/session.json";

setup("authenticate once for the engine and viewport matrix", async ({ page }) => {
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
    // Preserve the production limit and honor Retry-After; never weaken it.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/auth/login") &&
          r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const loginResponse = await response;
      if (loginResponse.status() !== 429) break;
      const retry = Number(loginResponse.headers()["retry-after"] || 0);
      const body = await loginResponse.json().catch(() => ({}));
      const fromBody = Number(
        String(body.error || "").match(/retry in (\d+) seconds?/i)?.[1] || 0,
      );
      const seconds = Math.min(60, retry || fromBody || 10);
      await page.waitForTimeout((seconds + 1) * 1000);
    }
  }
  await expect(
    page.getByRole("heading", { name: "Welcome back, Shane." }),
  ).toBeVisible({ timeout: 30000 });
  mkdirSync(dirname(statePath), { recursive: true });
  await page.context().storageState({ path: statePath });
});
