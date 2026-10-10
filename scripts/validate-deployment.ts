import { readFileSync } from "node:fs";
import {
  formatDeploymentReport,
  validateDeployment,
} from "../packages/deployment/index.ts";

// Wave X / X3 (W26): operator deployment validation.
//
//   npm run validate:deployment            # reads .env when present, else the process environment
//   npm run validate:deployment -- .env    # reads an explicit env file
//
// Names invalid settings and exits non-zero. Never prints a secret value.

function loadEnvFile(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    env[name] = value;
  }
  return env;
}

const explicit = process.argv[2];
let env: NodeJS.ProcessEnv = process.env;
let source = "process environment";
if (explicit) {
  env = loadEnvFile(explicit);
  source = explicit;
} else {
  try {
    env = loadEnvFile(".env");
    source = ".env";
  } catch {
    // No .env present; fall back to the process environment.
  }
}

const report = validateDeployment(env, "full");
console.log(`source: ${source}`);
console.log(formatDeploymentReport(report));
process.exit(report.ok ? 0 : 1);
