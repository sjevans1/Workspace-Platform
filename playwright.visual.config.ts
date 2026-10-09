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
    baseURL: process.env.E2E_BASE_URL || "http://localhost:8080",
    headless: true,
    browserName: "chromium",
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
  },
  projects: [
    { name: "chromium-desktop-light", use: { colorScheme: "light", viewport: { width: 1440, height: 1000 } } },
    { name: "chromium-desktop-dark", use: { colorScheme: "dark", viewport: { width: 1440, height: 1000 } } },
    { name: "chromium-phone-light", use: { colorScheme: "light", viewport: { width: 390, height: 844 } } },
  ],
});
