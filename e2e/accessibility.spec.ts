import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const email = "browser@example.test",
  password = "browser-password-123";
// Each browser project signs in once, then reuses a real session across its
// sequential accessibility tests; logout/revocation tests do not use this cache.
let verifiedCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

async function login(page: Page) {
  if (verifiedCookies.length) await page.context().addCookies(verifiedCookies);
  // Live collaboration and background resources may outlive DOM readiness.
  // Firefox navigation should await interactive HTML, not every subresource.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toBeVisible();
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
    // The preceding deployed-browser workflows and both browser projects
    // share the same disposable server and IP rate limit. Preserve the
    // production limit and honor Retry-After rather than weakening it.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const response = page.waitForResponse(
        (r) => r.url().includes("/api/v1/auth/login") &&
          r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const loginResponse = await response;
      if (loginResponse.status() !== 429) {
        expect(loginResponse.ok(), "Login should succeed or return a bounded rate limit").toBeTruthy();
        break;
      }
      const retry = Number(loginResponse.headers()["retry-after"] || 0);
      const body = await loginResponse.json().catch(() => ({}));
      const fromBody = Number(String(body.error || "").match(/retry in (\d+) seconds?/i)?.[1] || 0);
      const seconds = retry || fromBody || 10;
      expect(seconds, "Only bounded login backoff is supported in acceptance").toBeLessThanOrEqual(30);
      await page.waitForTimeout((seconds + 1) * 1000);
      if (attempt === 3) throw Error("Exceeded bounded rate-limit retries");
    }
  }
  await expect(
    page.getByRole("heading", { name: "Welcome back, Shane." }),
  ).toBeVisible();
  verifiedCookies = (await page.context().cookies())
    .filter((cookie) => cookie.name === "workspace_session");
}

async function semanticProblems(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      },
      labelled = (element: Element) => {
        const aria = element.getAttribute("aria-label")?.trim();
        if (aria) return true;
        const labelledBy = element.getAttribute("aria-labelledby");
        if (
          labelledBy &&
          labelledBy
            .split(/\s+/)
            .some((id) => document.getElementById(id)?.textContent?.trim())
        )
          return true;
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement
        )
          return !!element.labels?.length;
        return !!(
          element.textContent?.trim() ||
          element.getAttribute("title")?.trim()
        );
      },
      problems: string[] = [];

    for (const element of document.querySelectorAll(
      'button,a[href],input:not([type="hidden"]),select,textarea',
    )) {
      if (visible(element) && !labelled(element))
        problems.push(`unnamed:${element.tagName.toLowerCase()}`);
    }

    for (const image of document.querySelectorAll("img"))
      if (visible(image) && !image.hasAttribute("alt"))
        problems.push("image-missing-alt");

    const ids = new Set<string>();
    for (const element of document.querySelectorAll<HTMLElement>("[id]")) {
      if (ids.has(element.id)) problems.push(`duplicate-id:${element.id}`);
      ids.add(element.id);
    }

    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!visible(dialog)) continue;
      if (dialog.getAttribute("aria-modal") !== "true")
        problems.push("dialog-not-modal");
      if (!labelled(dialog)) problems.push("dialog-unnamed");
    }

    return problems;
  });
}

test("keyboard modal focus is trapped, restored, and semantically labelled", async ({
  page,
  browserName,
}) => {
  await login(page);
  expect(await semanticProblems(page)).toEqual([]);

  const trigger = page.getByRole("button", { name: "New page", exact: true });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Create something new" });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBeTruthy();
  expect(await semanticProblems(page)).toEqual([]);

  const close = dialog.getByRole("button", { name: "Close dialog" }),
    create = dialog.getByRole("button", { name: "Create", exact: true });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(create).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search your workspace" });
  await expect(search).toBeVisible();
  expect(
    await search.evaluate((node) => node.contains(document.activeElement)),
  ).toBeTruthy();
  expect(await semanticProblems(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();

  expect(["chromium", "firefox"]).toContain(browserName);
});


test("command-K search supports arrow navigation, Enter opening, and Escape focus restoration", async ({ page }) => {
  await login(page);
  // Do not rely on the optional starter/demo content being installed.
  const target = "Keyboard search target " + Date.now();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create something new" });
  await create.getByLabel("Name", { exact: true }).fill(target);
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(target);
  const trigger = page.getByRole("button", { name: "Search anything" });
  await trigger.focus();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search your workspace" });
  await expect(dialog).toBeVisible();

  const input = dialog.getByRole("combobox", { name: "Search workspace" });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await input.fill(target);
  const option = dialog.getByRole("option", { name: target });
  await expect(option).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(option).toHaveAttribute("aria-selected", "true");

  await input.press("ArrowDown");
  await input.press("ArrowUp");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(target);

  await page.keyboard.press("ControlOrMeta+k");
  const reopen = page.getByRole("dialog", { name: "Search your workspace" });
  await expect(reopen).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reopen).toBeHidden();
  expect(await semanticProblems(page)).toEqual([]);
});
