import { test, expect, type Page } from "@playwright/test";

const email = "browser@example.test",
  password = "browser-password-123";

test.skip(
  !process.env.E2E_BASE_URL?.startsWith("https://"),
  "trusted TLS acceptance runs only in the dedicated HTTPS gate",
);

async function login(page: Page) {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  expect(response?.headers()["strict-transport-security"]).toContain("max-age=31536000");

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
}

test("trusted HTTPS uses secure cookies and WSS collaboration", async ({
  page,
  context,
}) => {
  const websockets: string[] = [];
  const insecureRequests: string[] = [];

  page.on("websocket", (socket) => websockets.push(socket.url()));
  page.on("request", (request) => {
    if (request.url().startsWith("http://")) insecureRequests.push(request.url());
  });

  await login(page);
  expect(page.url()).toMatch(/^https:\/\//);

  const cookies = await context.cookies();
  expect(
    cookies.some(
      (cookie) =>
        cookie.secure &&
        cookie.httpOnly &&
        cookie.sameSite === "Lax" &&
        cookie.domain === "workspace.test",
    ),
  ).toBeTruthy();

  await page.getByRole("button", { name: "New page", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create something new" });
  await dialog
    .getByLabel("Name", { exact: true })
    .fill(`TLS acceptance ${Date.now()}`);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".bn-editor")).toBeVisible();

  await expect
    .poll(() => websockets.find((url) => url.startsWith("wss://")))
    .toBeTruthy();

  await page.locator(".bn-editor").click();
  await page.keyboard.type("Encrypted collaboration path verified.");
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();

  expect(insecureRequests).toEqual([]);
});
