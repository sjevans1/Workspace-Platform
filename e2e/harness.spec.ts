import { test, expect } from "@playwright/test";
import {
  login,
  seedDeterministicFixture,
  fixtureFingerprint,
} from "./support/harness";

// Wave X X0: engine and viewport compatibility harness.
//
// This spec asserts nothing product-specific beyond that the deterministic
// fixture renders its own stable text on the current engine and viewport. It is
// the harness whose determinism and cross-engine wiring X1 builds on. It makes
// no product-behaviour change and never claims Linux WebKit equals Safari.
test("deterministic fixture renders on the current engine and viewport", async ({
  page,
  browserName,
}) => {
  await login(page);
  const fixture = await seedDeterministicFixture(page);
  const fingerprint = await fixtureFingerprint(page, fixture.databaseId);
  // A machine-readable line the determinism proof compares across runs.
  console.log(
    "HARNESS_FINGERPRINT " +
      JSON.stringify({ browserName, fingerprint: JSON.parse(fingerprint) }),
  );
  const parsed = JSON.parse(fingerprint);
  const joined = [
    parsed.headers.join(" "),
    parsed.cells.join(" "),
    parsed.inputs.join(" "),
  ].join(" ");
  expect(joined).toContain("Name");
  expect(joined).toContain("Qty");
  expect(joined).toContain("Note");
  expect(parsed.inputs.join(" ")).toContain("Fixture row one");
  expect(parsed.rows).toBeGreaterThanOrEqual(4);
});
