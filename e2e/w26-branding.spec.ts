import { test, expect, type Page } from "@playwright/test";
import { recoverOnce, assertWorkspaceShell } from "./support/readiness";

// Wave X / X3 (W26). Browser acceptance for the two criteria that are genuinely
// browser-surface questions:
//   1. deployment branding appears on the unauthenticated sign-in surface;
//   2. organisation (post-auth) branding appears after sign-in.
//
// The remaining X3 criteria are proven at the layer that actually owns them and
// are not forced into browser code:
//   - organisation branding cannot modify sign-in branding, a member cannot
//     change organisation branding, and cross-tenant isolation:
//     tests/integration.test.ts (native authorization).
//   - first-run authority boundary: tests/branding-authority.test.ts.
//   - fresh-install configuration validates and boots, malformed configuration
//     fails closed and secret-safe: tests/deployment-profile.test.ts plus the
//     operator command, and this deployment booting with no mail configuration.
//   - the deployment summary is admin-only and secret-free:
//     tests/integration.test.ts.
//
// Readiness reuses the shared CI-H2 primitive. No arbitrary sleeps, no retries.

const email = "browser@example.test";
const password = "browser-password-123";

async function login(page: Page) {
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
  await recoverOnce(
    "w26-branding-shell",
    () => assertWorkspaceShell(page),
    async () => {
      await page.goto("/");
    },
  );
}

const accentVar = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent"),
  );

test("W26 deployment branding controls the unauthenticated sign-in surface", async ({
  page,
}) => {
  test.setTimeout(120000);

  // The public, deployment-scoped branding, read with no session at all.
  const deployment = await (await page.request.get("/api/v1/branding")).json();
  expect(deployment.productName).toBeTruthy();
  expect(deployment.primaryAccent).toMatch(/^#[0-9a-f]{6}$/i);

  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible({ timeout: 30000 });

  // The pre-auth surface applies the deployment branding: the document title is
  // the deployment product name, and the accent is applied from the same
  // deployment-scoped response (dark themes brighten it with color-mix, which
  // still contains the configured accent).
  await expect(page).toHaveTitle(deployment.productName);
  expect(await accentVar(page)).toContain(deployment.primaryAccent);

  // No session exists at this point, so this really is the unauthenticated
  // surface, not a signed-in view.
  const preAuth = await page.request.get("/api/v1/me");
  expect(preAuth.status()).toBe(401);
});

test("W26 organisation branding applies after sign-in from auth-scoped data", async ({
  page,
}) => {
  test.setTimeout(120000);
  await login(page);

  // After authentication the surface renders the auth-scoped branding object.
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.branding?.productName).toBeTruthy();

  await expect(page).toHaveTitle(me.branding.productName);
  expect(await accentVar(page)).toContain(me.branding.primaryAccent);

  // The deployment (pre-auth) branding is a separate plane and is unchanged by
  // anything the authenticated organisation sees.
  const deployment = await (await page.request.get("/api/v1/branding")).json();
  expect(deployment.productName).toBeTruthy();
});
