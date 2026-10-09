import { defineConfig } from "@playwright/test";

// Wave X X0: visual-regression configuration skeleton.
//
// X0 establishes the configuration and the baseline policy only; X2 populates
// the eight-surface snapshot set. Until X2 commits baselines, CI does not run
// this config. Design constraints (see docs/VISUAL_REGRESSION.md):
// - Chromium only: Firefox and WebKit rasterise differently, so cross-engine
//   pixel baselines are noise rather than signal;
// - light and dark, desktop and phone;
// - animations disabled, pinned timezone/locale, deviceScaleFactor 1.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "visual.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: {
    timeout: 20000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" },
  },
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    headless: true,
    browserName: "chromium",
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
  },
  projects: [
    // Authenticate once for the whole snapshot set (see e2e/auth.setup.ts).
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium-desktop-light",
      use: {
        colorScheme: "light",
        viewport: { width: 1440, height: 1000 },
        storageState: process.env.E2E_AUTH_STATE || "e2e/.auth/session.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "chromium-desktop-dark",
      use: {
        colorScheme: "dark",
        viewport: { width: 1440, height: 1000 },
        storageState: process.env.E2E_AUTH_STATE || "e2e/.auth/session.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "chromium-phone-light",
      use: {
        colorScheme: "light",
        viewport: { width: 390, height: 844 },
        storageState: process.env.E2E_AUTH_STATE || "e2e/.auth/session.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "chromium-phone-dark",
      use: {
        colorScheme: "dark",
        viewport: { width: 390, height: 844 },
        storageState: process.env.E2E_AUTH_STATE || "e2e/.auth/session.json",
      },
      dependencies: ["setup"],
    },
  ],
  // Local runs start their own dev server; CI sets E2E_BASE_URL against the
  // already-running Compose stack, so no webServer is started there.
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
