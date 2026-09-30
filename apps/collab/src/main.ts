import { Database } from "../../../packages/database/index.ts";
import { startInternalHealthServer } from "../../../packages/operations/health.ts";
import { createCollab } from "./server.ts";

const db = new Database(),
  collab = await createCollab(db, Number(process.env.COLLAB_PORT || 1234)),
  stopHealth = await startInternalHealthServer(
    Number(process.env.COLLAB_HEALTH_PORT || 1235),
    () => collab.health(),
  );

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await stopHealth();
    await collab.close();
    await db.close();
    process.exit(0);
  });
