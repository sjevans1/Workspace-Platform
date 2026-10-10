import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertDeploymentValid,
  formatDeploymentReport,
  parseDeploymentBoolean,
  SECRET_SETTINGS,
  validateDeployment,
} from "../packages/deployment/index.ts";

// Wave X / X3 (W26): native deployment profile validation.
//
// Deterministic, no I/O. Proves the profile rules, the fail-closed behaviour,
// that service scopes never require variables a service does not receive, and
// above all that a secret value can never appear in an error or a report.

const ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

const localProfile: NodeJS.ProcessEnv = {
  APP_URL: "http://localhost:8080",
  COOKIE_SECURE: "false",
  POSTGRES_PASSWORD: "postgres-plaintext-secret",
  RUNTIME_DB_PASSWORD: "runtime-plaintext-secret",
  ENCRYPTION_KEY,
  SETUP_TOKEN: "setup-token-abcdefghij",
  STORAGE_PROVIDER: "local",
  STORAGE_ENCRYPTION_MODE: "required",
  ANTIVIRUS_MODE: "required",
  ANTIVIRUS_HOST: "clamav",
  PRODUCT_NAME: "Acme Workspace",
  PRIMARY_ACCENT: "#177a64",
};

const settingsOf = (report: ReturnType<typeof validateDeployment>) =>
  report.issues.map((entry) => entry.setting);

test("deployment: a valid local profile passes with no issues", () => {
  const report = validateDeployment(localProfile, "full");
  assert.equal(report.ok, true, formatDeploymentReport(report));
  assert.deepEqual(report.issues, []);
  assert.equal(report.summary.storageProfile, "local");
  assert.equal(report.summary.encryptedAtRest, true);
  assert.equal(report.summary.mailTransport, "none");
});

test("deployment: a valid S3 profile passes", () => {
  const report = validateDeployment(
    {
      ...localProfile,
      STORAGE_PROVIDER: "s3",
      S3_BUCKET: "workspace-objects",
      S3_ENDPOINT: "https://s3.example.internal",
      S3_ACCESS_KEY: "access-key-value",
      S3_SECRET_KEY: "secret-key-value",
      S3_REGION: "us-east-1",
    },
    "full",
  );
  assert.equal(report.ok, true, formatDeploymentReport(report));
  assert.equal(report.summary.storageProfile, "s3");
});

test("deployment: a missing required secret is reported by name", () => {
  const { RUNTIME_DB_PASSWORD, ...missing } = localProfile;
  void RUNTIME_DB_PASSWORD;
  const report = validateDeployment(missing, "full");
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("RUNTIME_DB_PASSWORD"));
});

test("deployment: a malformed encryption key is rejected", () => {
  const report = validateDeployment(
    { ...localProfile, ENCRYPTION_KEY: "not-a-hex-key" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("ENCRYPTION_KEY"));
});

test("deployment: a malformed APP_URL is rejected", () => {
  const report = validateDeployment({ ...localProfile, APP_URL: "not a url" }, "full");
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("APP_URL"));
});

test("deployment: APP_URL with a path is rejected as an origin", () => {
  const report = validateDeployment(
    { ...localProfile, APP_URL: "https://workspace.example/app" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("APP_URL"));
});

test("deployment: an incompatible secure-cookie posture is rejected", () => {
  const report = validateDeployment(
    { ...localProfile, COOKIE_SECURE: "true" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("COOKIE_SECURE"));
});

test("deployment: a secure cookie posture over https passes", () => {
  const report = validateDeployment(
    { ...localProfile, APP_URL: "https://workspace.example", COOKIE_SECURE: "true" },
    "full",
  );
  assert.equal(report.ok, true, formatDeploymentReport(report));
});

test("deployment: invalid branding accent is rejected via the branding schema", () => {
  const report = validateDeployment(
    { ...localProfile, PRIMARY_ACCENT: "teal" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some((entry) => entry.setting === "PRIMARY_ACCENT"),
    JSON.stringify(report.issues),
  );
});

test("deployment: S3 selected without its required configuration is rejected", () => {
  const report = validateDeployment(
    { ...localProfile, STORAGE_PROVIDER: "s3" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("S3_BUCKET"));
});

test("deployment: a half-configured S3 credential is rejected", () => {
  const report = validateDeployment(
    {
      ...localProfile,
      STORAGE_PROVIDER: "s3",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY: "only-the-key",
    },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("S3_SECRET_KEY"));
});

test("deployment: an unsupported storage provider is rejected", () => {
  const report = validateDeployment(
    { ...localProfile, STORAGE_PROVIDER: "gcs" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("STORAGE_PROVIDER"));
});

test("deployment: invalid boolean and numeric values are rejected", () => {
  const report = validateDeployment(
    { ...localProfile, COOKIE_SECURE: "maybe", ANTIVIRUS_PORT: "not-a-port" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("COOKIE_SECURE"));
  assert.ok(settingsOf(report).includes("ANTIVIRUS_PORT"));
});

test("deployment: an out-of-range numeric value is rejected", () => {
  const report = validateDeployment(
    { ...localProfile, ANTIVIRUS_PORT: "70000" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("ANTIVIRUS_PORT"));
});

test("deployment: OIDC configuration must be coherent when enabled", () => {
  const report = validateDeployment(
    { ...localProfile, OIDC_ISSUER: "https://idp.example/realms/main" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("OIDC_CLIENT_ID"));
  assert.equal(report.summary.deploymentOidcConfigured, true);
});

test("deployment: antivirus must not be disabled in production", () => {
  const report = validateDeployment(
    { ...localProfile, NODE_ENV: "production", ANTIVIRUS_MODE: "disabled" },
    "full",
  );
  assert.equal(report.ok, false);
  assert.ok(settingsOf(report).includes("ANTIVIRUS_MODE"));
});

test("deployment: no secret value ever appears in a report or an error", () => {
  const secrets = {
    POSTGRES_PASSWORD: "postgres-VALUE-must-not-appear",
    RUNTIME_DB_PASSWORD: "runtime-VALUE-must-not-appear",
    ENCRYPTION_KEY: "feedface".repeat(8),
    SETUP_TOKEN: "setup-VALUE-must-not-appear-16",
    METRICS_BEARER_TOKEN: "metrics-VALUE-must-not-appear",
    OIDC_CLIENT_SECRET: "oidc-VALUE-must-not-appear",
    S3_ACCESS_KEY: "s3access-VALUE-must-not-appear",
    S3_SECRET_KEY: "s3secret-VALUE-must-not-appear",
  };
  // Deliberately invalid elsewhere so issues are produced too.
  const env: NodeJS.ProcessEnv = {
    ...localProfile,
    ...secrets,
    STORAGE_PROVIDER: "s3",
    OIDC_ISSUER: "https://idp.example",
  };
  const report = validateDeployment(env, "full");
  const serialised = JSON.stringify(report) + formatDeploymentReport(report);
  let thrown = "";
  try {
    assertDeploymentValid(env, "full");
  } catch (error) {
    thrown = String((error as Error).message);
  }
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(!serialised.includes(value), `report leaked ${name}`);
    assert.ok(!thrown.includes(value), `error leaked ${name}`);
    if (name !== "ENCRYPTION_KEY")
      assert.ok(!serialised.includes(name + "="), `report echoed ${name}=`);
  }
  assert.ok(!serialised.includes(ENCRYPTION_KEY) || !serialised.includes(secrets.ENCRYPTION_KEY));
});

test("deployment: a service scope never requires variables it does not receive", () => {
  const collabEnv: NodeJS.ProcessEnv = {
    APP_URL: "http://localhost:8080",
    COOKIE_SECURE: "false",
    ENCRYPTION_KEY,
    STORAGE_ENCRYPTION_MODE: "off",
  };
  const report = validateDeployment(collabEnv, "collab");
  assert.equal(report.ok, true, formatDeploymentReport(report));
  // A collab container does not receive PostgreSQL passwords, OIDC or antivirus
  // settings, so their absence must not be reported as a failure.
  for (const setting of [
    "POSTGRES_PASSWORD",
    "RUNTIME_DB_PASSWORD",
    "OIDC_ISSUER",
    "ANTIVIRUS_HOST",
  ])
    assert.ok(!settingsOf(report).includes(setting), setting);
});

test("deployment: assertDeploymentValid fails closed with a named setting", () => {
  assert.throws(
    () => assertDeploymentValid({ ...localProfile, APP_URL: "http://" }, "full"),
    /APP_URL/,
  );
});

test("deployment: parseDeploymentBoolean is strict", () => {
  assert.equal(parseDeploymentBoolean({ X: "true" }, "X"), true);
  assert.equal(parseDeploymentBoolean({ X: "1" }, "X"), true);
  assert.equal(parseDeploymentBoolean({ X: "0" }, "X"), false);
  assert.equal(parseDeploymentBoolean({ X: "off" }, "X"), undefined);
  assert.equal(parseDeploymentBoolean({}, "X"), undefined);
});

test("deployment: SECRET_SETTINGS covers every credential-bearing setting", () => {
  for (const name of [
    "POSTGRES_PASSWORD",
    "RUNTIME_DB_PASSWORD",
    "ENCRYPTION_KEY",
    "SETUP_TOKEN",
    "METRICS_BEARER_TOKEN",
    "OIDC_CLIENT_SECRET",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
  ])
    assert.ok((SECRET_SETTINGS as readonly string[]).includes(name), name);
});
