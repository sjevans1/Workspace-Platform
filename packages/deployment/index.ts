import { brandingSchema, defaultBranding } from "../branding/index.ts";

// Wave X / X3 (W26): shared deployment profile and environment validation.
//
// ONE source of truth for deployment configuration validation, used by both the
// operator command (scripts/validate-deployment.ts, `npm run validate:deployment`)
// and by each service's startup check. Schema logic is never duplicated.
//
// Two explicitly different scopes:
//   - "full": the whole deployment, as an operator would validate it before
//     starting Compose. Includes settings only the deploy step owns
//     (PostgreSQL passwords).
//   - a service scope ("api" | "collab" | "worker"): only the settings that
//     service actually receives. A service is never required to provide a
//     variable it is not given.
//
// SECURITY: reports and errors name the offending SETTING but never include its
// value. Settings whose value is secret are listed in SECRET_SETTINGS and are
// reported only as present/absent or structurally valid/invalid.
//
// Mail: no SMTP transport exists and none is required. A mail-free deployment
// installs and operates fully; this module never requires a mail provider.

export type DeploymentScope = "full" | "api" | "collab" | "worker";
export type StorageProvider = "local" | "s3";
export type StorageEncryptionMode = "off" | "legacy-read" | "required";
export type AntivirusMode = "required" | "disabled";

/** Settings whose values must never be printed, logged, or returned. */
export const SECRET_SETTINGS = [
  "POSTGRES_PASSWORD",
  "RUNTIME_DB_PASSWORD",
  "ENCRYPTION_KEY",
  "SETUP_TOKEN",
  "METRICS_BEARER_TOKEN",
  "OIDC_CLIENT_SECRET",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "REDIS_URL",
] as const;

export type ValidationIssue = {
  /** The environment variable at fault. Never a value. */
  setting: string;
  problem: string;
};

export type DeploymentSummary = {
  deploymentScope: DeploymentScope;
  deploymentVersion: string;
  storageProfile: StorageProvider;
  storageEncryption: StorageEncryptionMode;
  encryptedAtRest: boolean;
  applicationUrl: string;
  secureCookies: boolean;
  trustProxy: boolean;
  localAuthEnabled: boolean;
  deploymentOidcConfigured: boolean;
  antivirusMode: AntivirusMode;
  branding: "configured" | "default";
  mailTransport: "none";
  secretsPresent: string[];
  secretsMissing: string[];
};

export type DeploymentReport = {
  ok: boolean;
  issues: ValidationIssue[];
  summary: DeploymentSummary;
};

const BOOLEANS = ["true", "false", "1", "0"] as const;

/** Parse a boolean setting strictly. Returns undefined when invalid. */
export function parseDeploymentBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!(BOOLEANS as readonly string[]).includes(raw)) return undefined;
  return raw === "true" || raw === "1";
}

function booleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
  issues: ValidationIssue[],
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = parseDeploymentBoolean(env, name);
  if (value === undefined) {
    issues.push({
      setting: name,
      problem: `must be one of ${BOOLEANS.join(", ")}; got an unrecognised boolean`,
    });
    return fallback;
  }
  return value;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
  issues: ValidationIssue[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) {
    issues.push({ setting: name, problem: "must be an integer; got a non-numeric value" });
    return fallback;
  }
  const value = Number(raw);
  if (value < bounds.min || value > bounds.max) {
    issues.push({ setting: name, problem: `must be between ${bounds.min} and ${bounds.max}` });
    return fallback;
  }
  return value;
}

function enumSetting<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
  issues: ValidationIssue[],
): T {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    issues.push({ setting: name, problem: `must be one of ${allowed.join(", ")}` });
    return fallback;
  }
  return raw as T;
}

/** A required secret: presence only. The value is never read into the report. */
function requiredSecret(env: NodeJS.ProcessEnv, name: string, issues: ValidationIssue[]) {
  if ((env[name] ?? "") === "")
    issues.push({ setting: name, problem: "is required but is not set" });
}

function appUrl(env: NodeJS.ProcessEnv, issues: ValidationIssue[]): string {
  const raw = env.APP_URL ?? "";
  if (!raw) {
    issues.push({ setting: "APP_URL", problem: "is required but is not set" });
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.push({
      setting: "APP_URL",
      problem: "must be an absolute URL such as https://workspace.example",
    });
    return raw;
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    issues.push({ setting: "APP_URL", problem: "must use the http or https scheme" });
  if (parsed.pathname !== "/" || parsed.search || parsed.hash)
    issues.push({
      setting: "APP_URL",
      problem: "must be an origin without a path, query or fragment",
    });
  return raw;
}

/** Validate deployment branding against the existing branding schema. */
function branding(env: NodeJS.ProcessEnv, issues: ValidationIssue[]): "configured" | "default" {
  const branded = [
    "PRODUCT_NAME",
    "PRIMARY_ACCENT",
    "LOGO_LIGHT",
    "LOGO_DARK",
    "FAVICON",
  ].some((name) => (env[name] ?? "") !== "");
  // defaultBranding() validates as it reads and throws on an invalid value, so
  // name the offending setting where the schema allows it and otherwise report
  // the branding field group, never silently ignoring a bad value.
  const accent = env.PRIMARY_ACCENT ?? "";
  const accentOk = !accent || brandingSchema.shape.primaryAccent.safeParse(accent).success;
  if (!accentOk)
    issues.push({ setting: "PRIMARY_ACCENT", problem: "must be a #rrggbb colour value" });
  try {
    brandingSchema.parse(defaultBranding(env));
  } catch {
    if (accentOk)
      issues.push({
        setting: "branding",
        problem:
          "a deployment branding value is invalid (check PRODUCT_NAME, LOGO_*, SUPPORT_*, LEGAL_NAME and the *_URL settings)",
      });
  }
  return branded ? "configured" : "default";
}

/** Deployment OIDC is optional; when an issuer is set the rest must be coherent. */
function oidc(
  env: NodeJS.ProcessEnv,
  issues: ValidationIssue[],
): { configured: boolean } {
  const issuer = env.OIDC_ISSUER ?? "";
  if (!issuer) return { configured: false };
  let parsed: URL | undefined;
  try {
    parsed = new URL(issuer);
  } catch {
    issues.push({ setting: "OIDC_ISSUER", problem: "must be an absolute URL" });
  }
  const allowInsecure = booleanSetting(env, "OIDC_ALLOW_INSECURE", false, issues);
  if (parsed && !allowInsecure && parsed.protocol !== "https:" && env.NODE_ENV === "production")
    issues.push({
      setting: "OIDC_ISSUER",
      problem: "must use https in production unless OIDC_ALLOW_INSECURE=true",
    });
  if (!(env.OIDC_CLIENT_ID ?? ""))
    issues.push({ setting: "OIDC_CLIENT_ID", problem: "is required when OIDC_ISSUER is set" });
  enumSetting(
    env,
    "OIDC_TOKEN_ENDPOINT_AUTH_METHOD",
    ["client_secret_basic", "client_secret_post", "none"] as const,
    "client_secret_basic",
    issues,
  );
  if (!(env.OIDC_SCOPES ?? "").trim())
    issues.push({ setting: "OIDC_SCOPES", problem: "must list at least one scope" });
  booleanSetting(env, "OIDC_REQUIRE_VERIFIED_EMAIL", true, issues);
  return { configured: true };
}

/** Storage provider selection, encryption posture and S3 shape. */
function storage(
  env: NodeJS.ProcessEnv,
  issues: ValidationIssue[],
): {
  provider: StorageProvider;
  encryption: StorageEncryptionMode;
  encryptedAtRest: boolean;
} {
  const provider = enumSetting(
    env,
    "STORAGE_PROVIDER",
    ["local", "s3"] as const,
    "local",
    issues,
  );
  const encryption = enumSetting(
    env,
    "STORAGE_ENCRYPTION_MODE",
    ["off", "legacy-read", "required"] as const,
    "legacy-read",
    issues,
  );
  if (encryption !== "off") {
    const key = env.ENCRYPTION_KEY ?? "";
    if (!key)
      issues.push({
        setting: "ENCRYPTION_KEY",
        problem: "is required when STORAGE_ENCRYPTION_MODE is not off",
      });
    else if (!/^[a-f0-9]{64}$/i.test(key))
      issues.push({
        setting: "ENCRYPTION_KEY",
        problem: "must be 64 hexadecimal characters (the value is never printed)",
      });
  }
  if (provider === "s3") {
    if (!(env.S3_BUCKET ?? ""))
      issues.push({ setting: "S3_BUCKET", problem: "is required when STORAGE_PROVIDER=s3" });
    const hasKey = (env.S3_ACCESS_KEY ?? "") !== "";
    const hasSecret = (env.S3_SECRET_KEY ?? "") !== "";
    if (hasKey !== hasSecret)
      issues.push({
        setting: hasKey ? "S3_SECRET_KEY" : "S3_ACCESS_KEY",
        problem: "must be set together with the other S3 credential",
      });
    if (env.S3_ENDPOINT)
      try {
        new URL(env.S3_ENDPOINT);
      } catch {
        issues.push({ setting: "S3_ENDPOINT", problem: "must be an absolute URL when set" });
      }
    booleanSetting(env, "S3_FORCE_PATH_STYLE", true, issues);
  }
  return { provider, encryption, encryptedAtRest: encryption === "required" };
}

/** Antivirus posture. Required for the supported local profile. */
function antivirus(env: NodeJS.ProcessEnv, issues: ValidationIssue[]): AntivirusMode {
  const mode = enumSetting(
    env,
    "ANTIVIRUS_MODE",
    ["required", "disabled"] as const,
    "required",
    issues,
  );
  if (mode === "disabled" && (env.NODE_ENV ?? "") === "production")
    issues.push({ setting: "ANTIVIRUS_MODE", problem: "must not be disabled in production" });
  if (mode === "required") {
    if (!(env.ANTIVIRUS_HOST ?? ""))
      issues.push({
        setting: "ANTIVIRUS_HOST",
        problem: "is required when ANTIVIRUS_MODE=required",
      });
    integerSetting(env, "ANTIVIRUS_PORT", 3310, { min: 1, max: 65535 }, issues);
    integerSetting(env, "ANTIVIRUS_TIMEOUT_MS", 30000, { min: 1, max: 600000 }, issues);
  }
  return mode;
}

/**
 * Validate a deployment configuration.
 *
 * Scope "full" validates the whole deployment (operator use). A service scope
 * validates only what that service receives. Neither logs nor returns the value
 * of any setting listed in SECRET_SETTINGS.
 */
export function validateDeployment(
  env: NodeJS.ProcessEnv = process.env,
  scope: DeploymentScope = "full",
): DeploymentReport {
  const issues: ValidationIssue[] = [];
  const url = appUrl(env, issues);
  const secureCookies = booleanSetting(env, "COOKIE_SECURE", false, issues);
  const full = scope === "full";
  const apiScope = full || scope === "api";
  const trustProxy = full || scope === "api" ? booleanSetting(env, "TRUST_PROXY", false, issues) : false;
  const localAuthEnabled = apiScope ? booleanSetting(env, "LOCAL_AUTH_ENABLED", true, issues) : true;
  const brandingState = branding(env, issues);
  const storageState = storage(env, issues);
  const oidcState = apiScope ? oidc(env, issues) : { configured: false };
  const antivirusMode = apiScope ? antivirus(env, issues) : "required";

  // Secure-cookie posture must be reachable: a secure cookie is never sent over
  // plain http, so advertising https-only cookies on an http origin cannot work.
  if (secureCookies && url && !url.startsWith("https://"))
    issues.push({
      setting: "COOKIE_SECURE",
      problem: "is true but APP_URL is not https; secure cookies will not be sent",
    });

  // Required generated secrets. Services receive these through the runtime
  // environment, so a service scope requires only what that service consumes.
  const requiredSecrets =
    full
      ? (["POSTGRES_PASSWORD", "RUNTIME_DB_PASSWORD", "ENCRYPTION_KEY", "SETUP_TOKEN"] as const)
      : scope === "api"
        ? (["ENCRYPTION_KEY", "SETUP_TOKEN"] as const)
        : (["ENCRYPTION_KEY"] as const);
  for (const name of requiredSecrets) requiredSecret(env, name, issues);

  const setupToken = env.SETUP_TOKEN ?? "";
  if (setupToken && setupToken.length < 16)
    issues.push({ setting: "SETUP_TOKEN", problem: "must be at least 16 characters" });
  const metricsToken = env.METRICS_BEARER_TOKEN ?? "";
  if (metricsToken && metricsToken.length < 16)
    issues.push({
      setting: "METRICS_BEARER_TOKEN",
      problem: "must be at least 16 characters when set",
    });

  const summary: DeploymentSummary = {
    deploymentScope: scope,
    deploymentVersion: env.WORKSPACE_VERSION ?? "",
    storageProfile: storageState.provider,
    storageEncryption: storageState.encryption,
    encryptedAtRest: storageState.encryptedAtRest,
    applicationUrl: url,
    secureCookies,
    trustProxy,
    localAuthEnabled,
    deploymentOidcConfigured: oidcState.configured,
    antivirusMode,
    branding: brandingState,
    mailTransport: "none",
    secretsPresent: [],
    secretsMissing: [],
  };
  for (const name of SECRET_SETTINGS) {
    if ((env[name] ?? "") !== "") summary.secretsPresent.push(name);
    else summary.secretsMissing.push(name);
  }

  return { ok: issues.length === 0, issues, summary };
}

/** Fail closed. The thrown message names settings only, never their values. */
export function assertDeploymentValid(
  env: NodeJS.ProcessEnv = process.env,
  scope: DeploymentScope = "full",
): DeploymentReport {
  const report = validateDeployment(env, scope);
  if (!report.ok) {
    const detail = report.issues
      .map((entry) => `${entry.setting}: ${entry.problem}`)
      .join("; ");
    throw new Error(
      `Invalid ${scope === "full" ? "deployment" : `${scope} service`} configuration: ${detail}`,
    );
  }
  return report;
}

/** A short, secret-free report for `npm run validate:deployment`. */
export function formatDeploymentReport(report: DeploymentReport): string {
  const { summary } = report;
  const yes = (value: boolean) => (value ? "yes" : "no");
  const lines = [
    `deployment scope:        ${summary.deploymentScope}`,
    `deployment version:      ${summary.deploymentVersion || "unspecified"}`,
    `storage profile:         ${summary.storageProfile}`,
    `storage encryption:      ${summary.storageEncryption} (encrypted at rest: ${yes(summary.encryptedAtRest)})`,
    `application url:         ${summary.applicationUrl || "(not set)"}`,
    `secure cookies:          ${yes(summary.secureCookies)}`,
    `reverse proxy trusted:   ${yes(summary.trustProxy)}`,
    `local auth enabled:      ${yes(summary.localAuthEnabled)}`,
    `deployment oidc:         ${summary.deploymentOidcConfigured ? "configured" : "not configured"}`,
    `antivirus posture:       ${summary.antivirusMode}`,
    `branding:                ${summary.branding}`,
    `mail transport:          ${summary.mailTransport} (a mail-free deployment is supported)`,
    `secrets present:         ${summary.secretsPresent.join(", ") || "(none)"}`,
    `secrets missing:         ${summary.secretsMissing.join(", ") || "(none)"}`,
  ];
  if (!report.ok) {
    lines.push("", "invalid settings:");
    for (const entry of report.issues) lines.push(`  - ${entry.setting}: ${entry.problem}`);
    lines.push("", "result: INVALID");
  } else {
    lines.push("", "result: VALID");
  }
  return lines.join("\n");
}
