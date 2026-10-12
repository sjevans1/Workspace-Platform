// OCP-2B fleet console entrypoint. Standalone from the customer Workspace app: it shares
// no runtime with apps/web and has no Workspace dependency.
import { buildFleetConsole, fleetConsoleConfig } from "./server.ts";

// Fail closed on missing security configuration before listening.
const config = fleetConsoleConfig(process.env);
const app = buildFleetConsole(config);
await app.listen({ host: process.env.FLEET_CONSOLE_HOST || "127.0.0.1", port: config.port });
const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
