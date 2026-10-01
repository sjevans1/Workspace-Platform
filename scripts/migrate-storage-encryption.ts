import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database } from "../packages/database/index.ts";
import {
  createUnencryptedStorage,
  encryptStoredObject,
  decryptStoredObject,
  isEncryptedStoredObject,
  type Storage,
} from "../packages/storage/index.ts";

export type StorageEncryptionMigrationResult = {
  encrypted: number;
  already_encrypted: number;
  deletion_deferred: number;
};

export async function migrateStorageEncryption(
  url: string,
  storage: Storage,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageEncryptionMigrationResult> {
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || ""))
    throw new Error("ENCRYPTION_KEY must contain 64 hex characters");

  const db = new Database(url);
  let encrypted = 0,
    alreadyEncrypted = 0,
    deletionDeferred = 0;

  try {
    const rows = await db.system((q) =>
      q.query(
        "SELECT id,tenant_id,resource_id,object_key FROM files ORDER BY created_at,id",
      ),
    );

    for (const file of rows.rows) {
      const oldKey = String(file.object_key),
        raw = await storage.get(oldKey);

      if (isEncryptedStoredObject(raw)) {
        decryptStoredObject(oldKey, raw, env);
        alreadyEncrypted++;
        continue;
      }

      const newKey = `${file.tenant_id}/${file.resource_id}/${randomUUID()}`,
        encoded = encryptStoredObject(newKey, raw, env);

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

    return {
      encrypted,
      already_encrypted: alreadyEncrypted,
      deletion_deferred: deletionDeferred,
    };
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.WORKSPACE_MAINTENANCE !== "true")
    throw new Error(
      "Stop api, collab and worker, then set WORKSPACE_MAINTENANCE=true",
    );

  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Owner database URL required");

  const storage = createUnencryptedStorage();
  try {
    const result = await migrateStorageEncryption(url, storage);
    console.log(
      JSON.stringify(
        {
          result: "PASS",
          ...result,
          next_step:
            "Set STORAGE_ENCRYPTION_MODE=required before restarting Workspace.",
        },
        null,
        2,
      ),
    );
  } finally {
    storage.close?.();
  }
}
