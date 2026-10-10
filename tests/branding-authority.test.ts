import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brandingSchema,
  defaultBranding,
  organisationBranding,
} from "../packages/branding/index.ts";

// Wave X / X3 (W26): first-run branding authority.
//
// The three-plane model: provider/deployment, organisation admin, end user.
// Deployment branding is operator-controlled from deployment configuration.
// Organisation branding is stored on the organisation row and applies after
// sign-in to that organisation only. These tests pin the boundary natively so
// the browser layer only has to prove the surface, not the rule.

const deploymentEnv: NodeJS.ProcessEnv = {
  PRODUCT_NAME: "Deployment Product",
  PRIMARY_ACCENT: "#177a64",
  SUPPORT_NAME: "Deployment Support",
};

test("authority: an organisation override never changes deployment branding", () => {
  const before = defaultBranding(deploymentEnv);
  const stored = organisationBranding({ productName: "Acme Co" }, deploymentEnv);
  const after = defaultBranding(deploymentEnv);
  assert.deepEqual(after, before, "deployment branding must be read-only here");
  assert.equal(after.productName, "Deployment Product");
  assert.equal(after.primaryAccent, "#177a64");
  assert.equal(stored.productName, "Acme Co");
  assert.equal(
    stored.primaryAccent,
    "#177a64",
    "an accent the organisation did not set stays the deployment default",
  );
});

test("authority: a usable organisation accent override is stored unchanged", () => {
  // The acceptable accent band is deliberately narrow: dark enough to carry the
  // primary button's white text, light enough to stay visible on the dark
  // surface. The shipped default satisfies both, so it is a valid override.
  const stored = organisationBranding({ primaryAccent: "#177a64" }, deploymentEnv);
  assert.equal(stored.primaryAccent, "#177a64");
});

test("authority: unspecified organisation values fall back to deployment defaults", () => {
  const stored = organisationBranding({}, deploymentEnv);
  assert.deepEqual(stored, defaultBranding(deploymentEnv));
  // A stored organisation row is always complete and schema-valid.
  assert.equal(brandingSchema.safeParse(stored).success, true);
});

test("authority: malformed organisation branding is rejected by the shared schema", () => {
  assert.throws(() => organisationBranding({ primaryAccent: "teal" }, deploymentEnv));
  assert.throws(() =>
    organisationBranding(
      // An accent that cannot carry the required UI states.
      { primaryAccent: "#ffffff" },
      deploymentEnv,
    ),
  );
  assert.throws(() =>
    organisationBranding({ productName: "" }, deploymentEnv),
  );
});

test("authority: an unusable accent is rejected by name on the accent field", () => {
  const parsed = brandingSchema.safeParse({
    ...defaultBranding(deploymentEnv),
    primaryAccent: "#ffff00",
  });
  assert.equal(parsed.success, false);
  if (!parsed.success)
    assert.ok(
      parsed.error.issues.some(
        (entry) => entry.path.join(".") === "primaryAccent",
      ),
      JSON.stringify(parsed.error.issues),
    );
});

test("authority: existing installations stay compatible", () => {
  // An organisation with no stored branding (the pre-existing state) resolves to
  // the deployment defaults, which is exactly what /me already merged.
  const resolved = { ...defaultBranding(deploymentEnv), ...{} };
  assert.deepEqual(resolved, defaultBranding(deploymentEnv));
  // And a deployment that sets nothing still produces a valid default.
  const bare = defaultBranding({});
  assert.equal(brandingSchema.safeParse(bare).success, true);
  assert.equal(bare.primaryAccent, "#177a64");
});

test("authority: the organisation override produces exactly the branding shape", () => {
  const stored = organisationBranding(
    { productName: "Acme", legalName: "Acme Ltd" },
    deploymentEnv,
  );
  assert.equal(stored.productName, "Acme");
  assert.equal(stored.legalName, "Acme Ltd");
  assert.deepEqual(
    Object.keys(stored).sort(),
    Object.keys(defaultBranding(deploymentEnv)).sort(),
    "a stored organisation row carries exactly the branding fields",
  );
});
