import { test, expect, type Page } from "@playwright/test";

const email = "browser@example.test",
  password = "browser-password-123";

async function login(page: Page) {
  await page.goto("/");
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
