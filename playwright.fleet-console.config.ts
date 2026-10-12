// OCP-2B: dedicated browser acceptance harness for the fleet console.
//
// Deliberately small and separate from the customer Workspace Playwright suite: it runs
// only the fleet-console spec, against a real `buildFleetConsole()` listener started with
// a deterministic stub FleetClient and login verifier. It never touches the customer
// Workspace compose stack, its data or its visual baselines, and it is wired into the
// FULL deployment tier only.
import { defineConfig, devices } from "@playwright/test";

export const FLEET_CONSOLE_E2E_PORT = 4319;
export const FLEET_CONSOLE_E2E_ORIGIN = `http://127.0.0.1:${FLEET_CONSOLE_E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e/fleet-console",
  testMatch: /console\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"]] : [["list"]],
  use: {
    baseURL: FLEET_CONSOLE_E2E_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Chromium only: the global Workspace compatibility gates already cover the broader
  // engine matrix, and this harness exists to prove the console works in a real browser.
  projects: [
    {
      name: "console-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "console-tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 834, height: 1112 }, isMobile: false, hasTouch: true },
    },
  ],
  webServer: {
    command: "node --import tsx e2e/fleet-console/console-server.ts",
    url: `${FLEET_CONSOLE_E2E_ORIGIN}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      FLEET_CONSOLE_E2E_PORT: String(FLEET_CONSOLE_E2E_PORT),
    },
  },
});
