import { defineConfig } from "@playwright/test";

// Wave X X0: deterministic engine x viewport harness.
//
// Named viewport projects replace ad hoc in-test resizing. Chromium and Firefox
// are retained; WebKit is added alongside (never in place of) them. A pinned
// locale, timezone and deviceScaleFactor keep runs comparable.
const engines = ["chromium", "firefox", "webkit"] as const;
const viewports = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "harness.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    headless: true,
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: engines.flatMap((browserName) =>
    Object.entries(viewports).map(([name, viewport]) => ({
      name: `${browserName}-${name}`,
      use: { browserName, viewport },
    })),
  ),
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

