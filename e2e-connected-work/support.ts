import { expect, type Page } from "@playwright/test";

// The only provider implemented in this tranche (packages/connectors/registry.ts).
export const SYNTHETIC_PROVIDER_KEY = "synthetic-test";

/** Open Settings from the signed-in workspace shell. */
export async function openSettings(page: Page): Promise<void> {
  await page.goto("/");
  const settings = page.getByRole("button", {
    name: "Settings & members",
    exact: true,
  });
  await expect(settings).toBeVisible({ timeout: 60000 });
  await settings.click();
  await expect(
    page.getByRole("heading", { name: "Settings & members", exact: true }),
  ).toBeVisible();
}

/** Open Settings and select the Connections or Automations tab. */
export async function openSettingsTab(
  page: Page,
  tab: "Connections" | "Automations",
): Promise<void> {
  await openSettings(page);
  await page.getByRole("button", { name: tab, exact: true }).click();
}

/** The session CSRF token every state-changing API call must carry. */
export async function csrfToken(page: Page): Promise<string> {
  const response = await page.request.get("/api/v1/me");
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).csrf;
}

export async function apiGet(page: Page, path: string): Promise<any> {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

/**
 * Create a real page resource through the API so a workflow action has a
 * resource that genuinely exists. The UI is only used to observe the workflow.
 */
export async function createPageResource(
  page: Page,
  title: string,
): Promise<string> {
  const headers = { "X-CSRF-Token": await csrfToken(page) };
  const roots = await page.request.get("/api/v1/resources");
  expect(roots.ok(), await roots.text()).toBeTruthy();
  const root = (await roots.json())[0];
  const spaceResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: { kind: "space", parent_id: root.id, title: `${title} space` },
  });
  expect(spaceResponse.ok(), await spaceResponse.text()).toBeTruthy();
  const space = await spaceResponse.json();
  const pageResponse = await page.request.post("/api/v1/resources", {
    headers,
    data: { kind: "page", parent_id: space.id, title },
  });
  expect(pageResponse.ok(), await pageResponse.text()).toBeTruthy();
  return (await pageResponse.json()).id;
}

export async function findWorkflowId(
  page: Page,
  name: string,
): Promise<string> {
  const list = await apiGet(page, "/automations/workflows");
  const found = (list.workflows || []).find((w: any) => w.name === name);
  expect(found, `workflow "${name}" should exist`).toBeTruthy();
  return found.id;
}

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter",
];

/**
 * Wait for the worker to settle the workflow's newest run. The worker ticks
 * every second, so a manual run completes quickly, but polling keeps the
 * observation honest instead of sleeping a fixed guess.
 */
export async function waitForTerminalRun(
  page: Page,
  workflowId: string,
  timeoutMs = 45000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const list = await apiGet(
      page,
      `/automations/runs?workflow_id=${workflowId}&limit=50`,
    );
    last = (list.runs || []).find((run: any) =>
      TERMINAL_RUN_STATUSES.includes(run.status),
    );
    if (last) return last;
    await page.waitForTimeout(1000);
  }
  throw new Error(
    `no terminal run for workflow ${workflowId} within ${timeoutMs}ms (last=${JSON.stringify(last)})`,
  );
}

/**
 * Prove the supplied secret is nowhere the browser or the API can reach: not in
 * the rendered text, not in the serialized DOM, not in any form control value,
 * and not in the list or catalog responses.
 */
export async function expectSecretAbsent(
  page: Page,
  secret: string,
): Promise<void> {
  expect(await page.locator("body").innerText()).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);
  const leaked = await page.evaluate((value) => {
    const controls = Array.from(
      document.querySelectorAll("input,textarea,option"),
    );
    return controls.some(
      (control) =>
        ((control as HTMLInputElement).value || "").includes(value) ||
        (control.textContent || "").includes(value),
    );
  }, secret);
  expect(leaked, "no form control exposes the supplied secret").toBe(false);
  for (const path of ["/connectors/connections", "/connectors/catalog"]) {
    const response = await page.request.get(`/api/v1${path}`);
    expect(await response.text()).not.toContain(secret);
  }
}
