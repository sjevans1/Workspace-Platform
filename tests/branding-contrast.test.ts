import { test } from "node:test";
import assert from "node:assert/strict";
import { brandingSchema } from "../packages/branding/index.ts";
import {
  accentContrastIssues,
  contrastRatio,
  DARK_SURFACE,
  isUsableAccent,
  LIGHT_SURFACE,
  MIN_ACCENT_COMPONENT_CONTRAST,
  MIN_ACCENT_CONTRAST,
  parseHexColor,
  relativeLuminance,
} from "../packages/branding/contrast.ts";

// Wave X / X3 (W26): deterministic accent contrast validation.
//
// The check rejects accents that cannot carry the required UI states. It does
// not, on its own, establish WCAG conformance and no test here claims that.

test("contrast: WCAG reference values are exact", () => {
  assert.equal(contrastRatio("#ffffff", "#000000").toFixed(2), "21.00");
  assert.equal(contrastRatio("#ffffff", "#ffffff").toFixed(2), "1.00");
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#ffffff").toFixed(4), "1.0000");
});

test("contrast: ratio is symmetric", () => {
  assert.equal(
    contrastRatio("#177a64", "#ffffff").toFixed(6),
    contrastRatio("#ffffff", "#177a64").toFixed(6),
  );
});

test("contrast: the shipped default accent is usable", () => {
  assert.equal(isUsableAccent("#177a64"), true);
  assert.deepEqual(accentContrastIssues("#177a64"), []);
  assert.ok(contrastRatio("#177a64", LIGHT_SURFACE) >= MIN_ACCENT_CONTRAST);
  assert.ok(
    contrastRatio("#177a64", DARK_SURFACE) >= MIN_ACCENT_COMPONENT_CONTRAST,
  );
});

test("contrast: an accent too light for white text or accent text is rejected", () => {
  const issues = accentContrastIssues("#ffffff");
  assert.ok(issues.some((entry) => entry.includes("light surface")), issues.join());
  assert.equal(isUsableAccent("#ffffff"), false);
});

test("contrast: an accent that vanishes on the dark surface is rejected", () => {
  const issues = accentContrastIssues("#000000");
  assert.ok(issues.some((entry) => entry.includes("dark surface")), issues.join());
  assert.equal(isUsableAccent("#000000"), false);
});

test("contrast: a malformed accent is rejected with an actionable message", () => {
  assert.deepEqual(accentContrastIssues("teal"), [
    "must be a #rrggbb colour value such as #177a64",
  ]);
  assert.equal(parseHexColor("teal"), undefined);
  assert.equal(parseHexColor("#177a64")?.r, 0x17);
});

test("contrast: messages state the required ratio and the measured ratio", () => {
  const [light] = accentContrastIssues("#ffe600");
  assert.ok(light.includes("4.5:1"), light);
  assert.match(light, /reaches \d+\.\d{2}:1/);
});

test("contrast: the branding schema rejects an unusable accent for both planes", () => {
  const candidate = {
    productName: "Acme Workspace",
    primaryAccent: "#ffffff",
    logoLight: "",
    logoDark: "",
    favicon: "",
    loginBackground: "",
    supportName: "Support",
    supportUrl: "",
    legalName: "",
    privacyUrl: "",
    termsUrl: "",
  };
  const parsed = brandingSchema.safeParse(candidate);
  assert.equal(parsed.success, false);
  if (!parsed.success)
    assert.ok(
      parsed.error.issues.some(
        (entry) =>
          entry.path.join(".") === "primaryAccent" &&
          /light surface/.test(entry.message),
      ),
      JSON.stringify(parsed.error.issues),
    );
  // The shipped default stays valid.
  assert.equal(
    brandingSchema.safeParse({ ...candidate, primaryAccent: "#177a64" }).success,
    true,
  );
});
