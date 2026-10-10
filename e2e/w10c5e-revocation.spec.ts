import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { recoverOnce, assertWorkspaceShell } from "./support/readiness";

// Wave X / X4a / W10c5e: deployed browser acceptance.
//
// The claim under test is NOT "a revoked user cannot request a new URL". It is:
// a URL that DEMONSTRABLY WORKED in a real browser session before permission
// revocation no longer grants access afterwards. The same URL string is reused
// either side of the revocation, in the same browser session.
//
// Readiness reuses the shared CI-H2 primitive. No sleeps, no retries.

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
    "w10c5e-shell",
    () => assertWorkspaceShell(page),
    async () => {
      await page.goto("/");
    },
  );
}

// Authenticated GETs are limited per tenant+principal. Wait for the real
// principal budget from the response header rather than misreading a 429.
async function ensurePrincipalReadBudget(page: Page, minimum = 160) {
  for (let attempt = 0; attempt < 26; attempt++) {
    const response = await page.request.get("/api/v1/me");
    const raw = response.headers()["x-ratelimit-remaining"];
    const remaining = raw === undefined ? NaN : Number(raw);
    if (response.ok() && Number.isFinite(remaining) && remaining >= minimum)
      return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Principal read budget did not recover");
}

/** Replace the resource's local grants using the current permission revision. */
async function setGrants(
  page: Page,
  resourceId: string,
  csrf: string,
  grants: { principal_id: string; level: number }[],
  inherit = false,
) {
  const current = await (
    await page.request.get(`/api/v1/resources/${resourceId}/permissions`)
  ).json();
  const response = await page.request.patch(
    `/api/v1/resources/${resourceId}/permissions`,
    {
      headers: { "X-CSRF-Token": csrf },
      data: { inherit, expected_revision: current.revision, grants },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test("W10c5e browser: a previously working private attachment URL is revoked", async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  await login(page);
  await ensurePrincipalReadBudget(page);
  const owner = await (await page.request.get("/api/v1/me")).json();
  const ownerHeaders = { "X-CSRF-Token": owner.csrf };

  // A private space and page owned by the owner.
  const roots = await (await page.request.get("/api/v1/resources")).json();
  const space = await (
    await page.request.post("/api/v1/resources", {
      headers: ownerHeaders,
      data: {
        kind: "space",
        parent_id: roots[0].id,
        title: "W10c5e space " + randomUUID(),
      },
    })
  ).json();
  const resource = await (
    await page.request.post("/api/v1/resources", {
      headers: ownerHeaders,
      data: {
        kind: "page",
        parent_id: space.id,
        title: "W10c5e page " + randomUUID(),
      },
    })
  ).json();

  // A fresh resource under the workspace root is readable by members until it is
  // restricted, so make the page genuinely private first: no inherited grants and
  // an empty local grant list means only the owner (and later explicit grantees)
  // can read it.
  await setGrants(page, resource.id, owner.csrf, []);

  // Upload through the real browser session.
  const payload = "W10c5e browser private bytes " + randomUUID();
  const uploaded = await page.request.post(
    `/api/v1/resources/${resource.id}/files`,
    {
      headers: ownerHeaders,
      multipart: {
        file: {
          name: "evidence.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(payload),
        },
      },
    },
  );
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const attachment = await uploaded.json();
  const url = attachment.url;

  // The URL works for its owner, and it carries no capability token.
  expect(url).toMatch(/^\/api\/v1\/files\/[0-9a-f-]+\/content$/);
  const ownerBefore = await page.request.get(url);
  expect(ownerBefore.ok(), await ownerBefore.text()).toBeTruthy();
  expect(await ownerBefore.text()).toBe(payload);

  // A second principal, accepting inside its own browser context.
  const invitation = await page.request.post("/api/v1/members/invite", {
    headers: ownerHeaders,
    data: {
      name: "Revoked Reader",
      email: `w10c5e-${randomUUID()}@example.test`,
      role: "member",
    },
  });
  expect(invitation.ok(), await invitation.text()).toBeTruthy();

  const context = await browser.newContext();
  try {
    const memberPage = await context.newPage();
    await memberPage.goto((await invitation.json()).url);
    await memberPage
      .getByLabel("Password", { exact: true })
      .fill("w10c5e-member-password-123");
    await memberPage
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    // Wait for the accepted member's authenticated shell before reading /me, so
    // the assertion is about authorization and not about a not-yet-settled
    // session.
    await expect(
      memberPage.getByRole("heading", { name: /Welcome back, Revoked/ }),
    ).toBeVisible({ timeout: 30000 });
    const member = (await (await memberPage.request.get("/api/v1/me")).json())
      .user;
    expect(member.id).toBeTruthy();

    // Without a grant the member cannot use the URL.
    expect((await memberPage.request.get(url)).status()).toBe(404);

    // The owner grants read access on the page.
    await setGrants(page, resource.id, owner.csrf, [
      { principal_id: member.id, level: 1 },
    ]);

    // The SAME URL now works in the member's browser session: this is the
    // "demonstrably worked before revocation" evidence.
    const memberBefore = await memberPage.request.get(url);
    expect(memberBefore.ok(), await memberBefore.text()).toBeTruthy();
    expect(await memberBefore.text()).toBe(payload);

    // Revoke, then reuse the exact same URL in the same session.
    await setGrants(page, resource.id, owner.csrf, []);
    const memberAfter = await memberPage.request.get(url);
    expect(memberAfter.status()).toBe(404);
    expect(await memberAfter.text()).not.toContain(payload);

    // Another still-authorized principal keeps access to that same URL.
    const ownerAfter = await page.request.get(url);
    expect(ownerAfter.ok(), await ownerAfter.text()).toBeTruthy();
    expect(await ownerAfter.text()).toBe(payload);

    // The revoked member's browser UI no longer renders the resource either.
    await memberPage.goto("/?page=" + resource.id);
    await expect(memberPage.getByText(payload)).toHaveCount(0);
    await expect(memberPage.getByText("evidence.txt")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
