import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { FIXTURE } from "../fixtures/catalog";

export const FIXTURE_PATH =
  process.env.E2E_FIXTURE_STATE || "e2e/.auth/fixture.json";

export type VisualFixture = {
  spaceId: string;
  pageId: string;
  databaseId: string;
};

// The deployed API applies real production rate limits, and the visual step runs
// late in the acceptance job after other browser workflows have consumed much of
// the shared budget. A 429 must be waited out, never bypassed.
async function api(
  page: Page,
  method: "get" | "post" | "patch",
  path: string,
  options: { headers?: Record<string, string>; data?: unknown } = {},
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await page.request[method](path, options as any);
    if (response.status() !== 429) {
      expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
      return response;
    }
    const retry = Number(response.headers()["retry-after"] || 0);
    const body = await response.json().catch(() => ({}));
    const fromBody = Number(
      String((body as any).error || "").match(/retry in (\d+) seconds?/i)?.[1] || 0,
    );
    const seconds = Math.min(60, retry || fromBody || 10);
    await page.waitForTimeout((seconds + 1) * 1000);
  }
  throw new Error(`Rate limited on ${method} ${path} after bounded retries`);
}

async function findChild(
  page: Page,
  parentId: string,
  kind: string,
  title: string,
): Promise<any | undefined> {
  const response = await api(
    page,
    "get",
    `/api/v1/resources?parent_id=${parentId}&limit=200`,
  );
  const children = (await response.json()) as any[];
  return children.find((child) => child.kind === kind && child.title === title);
}

/**
 * Seed the deterministic visual fixture once per run (from the setup project),
 * so the matrix projects do not each repeat the writes and exhaust the budget.
 *
 * Idempotent by title: an existing fixture space/page/database is reused rather
 * than duplicated, so repeated runs and a shared database cannot produce
 * duplicate sidebar entries (which would make the shell surface nondeterministic
 * and create ambiguous selectors).
 */
export async function seedVisualFixture(page: Page): Promise<VisualFixture> {
  const me = await (await api(page, "get", "/api/v1/me")).json();
  const headers = { "X-CSRF-Token": me.csrf };
  const root = (await (await api(page, "get", "/api/v1/resources")).json())[0];
  expect(root?.id, "workspace root must exist").toBeTruthy();

  let space = await findChild(page, root.id, "space", FIXTURE.space);
  if (!space) {
    space = await (
      await api(page, "post", "/api/v1/resources", {
        headers,
        data: { kind: "space", parent_id: root.id, title: FIXTURE.space },
      })
    ).json();
  }

  let fixturePage = await findChild(page, space.id, "page", FIXTURE.page);
  if (!fixturePage) {
    fixturePage = await (
      await api(page, "post", "/api/v1/resources", {
        headers,
        data: { kind: "page", parent_id: space.id, title: FIXTURE.page },
      })
    ).json();
    await api(page, "patch", `/api/v1/pages/${fixturePage.id}/content`, {
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
    });
  }

  let database = await findChild(page, space.id, "database", FIXTURE.database);
  if (!database) {
    database = await (
      await api(page, "post", "/api/v1/resources", {
        headers,
        data: {
          kind: "database",
          parent_id: space.id,
          title: FIXTURE.database,
        },
      })
    ).json();
    await api(page, "patch", `/api/v1/databases/${database.id}`, {
      headers,
      data: { properties: FIXTURE.properties },
    });
    for (const values of FIXTURE.records)
      await api(page, "post", `/api/v1/databases/${database.id}/records`, {
        headers,
        data: { values },
      });
  }

  return { spaceId: space.id, pageId: fixturePage.id, databaseId: database.id };
}

export function readVisualFixture(): VisualFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as VisualFixture;
}
