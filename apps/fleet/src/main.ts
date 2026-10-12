// OCP-2A fleet service entrypoint. Independent of the Workspace runtime: Workspace
// neither depends on this service nor knows its configuration.
import pg from "pg";
import { buildFleetService, ensureFleetSchema, fleetConfig } from "./fleet.ts";

// Fail closed on security-sensitive misconfiguration before listening.
const config = fleetConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
await ensureFleetSchema(pool);
const app = buildFleetService(pool, config);
await app.listen({
  host: process.env.FLEET_HOST || "127.0.0.1",
  port: config.port,
});
const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
