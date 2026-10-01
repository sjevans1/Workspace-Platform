import { randomUUID } from "node:crypto";
import { Database } from "../packages/database/index.ts";
import {
  createUnencryptedStorage,
  encryptStoredObject,
  isEncryptedStoredObject,
} from "../packages/storage/index.ts";

if (process.env.WORKSPACE_MAINTENANCE !== "true")
  throw new Error(
    "Stop api, collab and worker, then set WORKSPACE_MAINTENANCE=true",
  );

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error("Owner database URL required");
if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY || ""))
  throw new Error("ENCRYPTION_KEY must contain 64 hex characters");

const db = new Database(url),
  storage = createUnencryptedStorage(),
  rows = await db.system((q) =>
    q.query(
      "SELECT id,tenant_id,resource_id,object_key FROM files ORDER BY created_at,id",
    ),
  );

let encrypted = 0,
  alreadyEncrypted = 0,
  deletionDeferred = 0;

try {
  for (const file of rows.rows) {
    const oldKey = String(file.object_key),
      raw = await storage.get(oldKey);

    if (isEncryptedStoredObject(raw)) {
      alreadyEncrypted++;
      continue;
    }

    const newKey = `${file.tenant_id}/${file.resource_id}/${randomUUID()}`,
      encoded = encryptStoredObject(newKey, raw);

    await storage.put(newKey, encoded, "application/octet-stream");
    try {
      await db.systemTransaction(async (q) => {
        const updated = await q.query(
          "UPDATE files SET object_key=$1 WHERE id=$2 AND object_key=$3",
          [newKey, file.id, oldKey],
        );
        if (updated.rowCount !== 1)
          throw new Error("File metadata changed during encryption migration");
        await q.query(
          "INSERT INTO object_deletions(id,tenant_id,object_key,reason) VALUES($1,$2,$3,'storage_encryption_migration') ON CONFLICT(tenant_id,object_key) DO NOTHING",
          [randomUUID(), file.tenant_id, oldKey],
        );
      });
    } catch (error) {
      await storage.delete(newKey).catch(() => {});
      throw error;
    }

    try {
      await storage.delete(oldKey);
      await db.system((q) =>
        q.query(
          "UPDATE object_deletions SET status='completed',attempts=attempts+1,completed_at=now(),last_error=NULL WHERE tenant_id=$1 AND object_key=$2 AND status IN ('pending','retry')",
          [file.tenant_id, oldKey],
        ),
      );
    } catch (error: any) {
      deletionDeferred++;
      await db.system((q) =>
        q.query(
          "UPDATE object_deletions SET last_error=$3 WHERE tenant_id=$1 AND object_key=$2 AND status IN ('pending','retry')",
          [
            file.tenant_id,
            oldKey,
            String(error?.message || error).slice(0, 1000),
          ],
        ),
      );
    }
    encrypted++;
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        encrypted,
        already_encrypted: alreadyEncrypted,
        deletion_deferred: deletionDeferred,
        next_step:
          "Set STORAGE_ENCRYPTION_MODE=required before restarting Workspace.",
      },
      null,
      2,
    ),
  );
} finally {
  storage.close?.();
  await db.close();
}
