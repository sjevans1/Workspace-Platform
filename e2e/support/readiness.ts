import { expect, type Page } from "@playwright/test";

// CI-H2: shared, state-based browser readiness primitive.
//
// Root cause this addresses: the deployment job's "stack healthy" condition
// proves service liveness only (api/collab/worker/clamav plus the API's /ready
// through Caddy). The Next frontend declares no healthcheck and Caddy starts on
// `service_started`, so a browser step can reach the application before the
// frontend is serving or before the authenticated shell has hydrated. That
// produced intermittent "expected element absent" failures across unrelated
// suites (visual shell, accessibility command-K, collaboration capacity).
//
// Contract:
// - navigate, then assert the exact expected state;
// - if the state is absent, perform AT MOST ONE bounded reload/re-entry;
// - reassert the exact expected state;
// - if it is still absent, fail hard.
//
// Every outcome is observable in CI output so repeated application failure can
// never hide behind retries:
//   READINESS_OK <label>         first attempt satisfied the state
//   READINESS_RECOVERY <label>   state absent; single recovery attempt taken
//   READINESS_RECOVERED <label>  recovery satisfied the state
//   READINESS_FAILED <label>     still absent after the single attempt
export async function gotoWhenReady(
  page: Page,
  url: string,
  label: string,
  assertReady: (page: Page) => Promise<void>,
): Promise<void> {
  await page.goto(url);
  await recoverOnce(label, () => assertReady(page), async () => {
    await page.goto(url);
  });
}

/**
 * Single bounded, observable recovery around an exact expected state.
 * `recover` re-establishes the state (a re-entry or reload), never a sleep.
 */
export async function recoverOnce(
  label: string,
  assertReady: () => Promise<void>,
  recover: () => Promise<void>,
): Promise<void> {
  try {
    await assertReady();
    console.log(`READINESS_OK ${label}`);
    return;
  } catch {
    console.log(`READINESS_RECOVERY ${label}`);
  }
  await recover();
  try {
    await assertReady();
    console.log(`READINESS_RECOVERED ${label}`);
  } catch (error) {
    console.log(`READINESS_FAILED ${label}`);
    throw error;
  }
}

/**
 * The authenticated workspace shell is available: the sign-in/setup screens are
 * gone and the known navigation shell is present. Used as the readiness state
 * by suites whose first action assumes an authenticated application.
 */
export async function assertWorkspaceShell(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Search anything" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("YOUR SPACES", { exact: true })).toBeVisible({
    timeout: 20000,
  });
}
