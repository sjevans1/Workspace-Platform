import { spawnSync } from "node:child_process";

process.loadEnvFile();
const result = spawnSync("npm", ["run", "test:e2e"], {
  stdio: "inherit",
  env: {
    ...process.env,
    E2E_BASE_URL: process.env.APP_URL || "http://localhost:8080",
    E2E_SETUP_TOKEN: process.env.SETUP_TOKEN,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
