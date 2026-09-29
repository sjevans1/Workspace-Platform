import { Database } from "../../../packages/database/index.ts";
import { buildApp } from "./app.ts";
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
