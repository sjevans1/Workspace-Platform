import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
          args: ["--no-sandbox"],
        }
      : {},
  },
  webServer: {
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
    },
  },
});
