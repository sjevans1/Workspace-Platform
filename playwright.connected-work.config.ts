import { defineConfig, devices } from "@playwright/test";

// W29-A / W30-A: dedicated browser acceptance for Settings > Connections and
// Settings > Automations.
//
// Deliberately separate from the customer Workspace suite: it owns its own
// testDir and config, so the default playwright.config.ts (testDir "./e2e") and
// the harness config never collect it, and its traces land in their own output
// directory. The acceptance signs in once through a setup project that writes a
// storageState, then drives the real UI in headless Chromium only.
//
// This lane IS a blocking gate on the FULL deployment job (see ci.yml, "Verify
// Connected Work and Automations browser workflow", which uploads
// test-results/connected-work as its own artifact). It has no retries, no
// continue-on-error and no quarantined assertion.
const authState =
  process.env.E2E_AUTH_STATE || "e2e-connected-work/.auth/session.json";

export default defineConfig({
  testDir: "./e2e-connected-work",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 20000 },
  // A dedicated output directory so the deployment job can upload this lane's
  // traces and screenshots as a clearly named artifact.
  outputDir: "test-results/connected-work",
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: "en-GB",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Authenticate once and persist the real session for the spec. A pristine
    // database shows the first-run setup screen; an initialised one shows sign-in.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        headless: true,
        storageState: authState,
      },
      dependencies: ["setup"],
    },
  ],
  // Local runs start their own dev stack, identical in spirit to
  // playwright.harness.config.ts. When E2E_BASE_URL points at an
  // already-running stack (as the local acceptance does, so the API port can be
  // chosen freely) no webServer is started.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node --import tsx scripts/dev.ts",
        url: "http://localhost:3000",
        timeout: 120000,
        reuseExistingServer: false,
        env: {
          SETUP_TOKEN: "e2e-setup-token",
          ENCRYPTION_KEY: "e".repeat(64),
          DEV_DATABASE_PATH: ".data/e2e-postgres",
          E2E_PRODUCTION: "true",
          NEXT_TELEMETRY_DISABLED: "1",
          WEBHOOK_ALLOWED_ORIGINS: "https://events.example.test",
        },
      },
});
