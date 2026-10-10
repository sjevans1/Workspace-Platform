import { Database } from "../../../packages/database/index.ts";
import { assertDeploymentValid } from "../../../packages/deployment/index.ts";
import { buildApp } from "./app.ts";
// Wave X / X3 (W26): fail closed on invalid deployment configuration before the
// service starts. Service scope, so only settings this service receives.
assertDeploymentValid(process.env, "api");
const db = new Database(),
  app = await buildApp(db);
await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.API_PORT) || 4000,
});
const stop = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
