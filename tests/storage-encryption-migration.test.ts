import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database } from "../packages/database/index.ts";
import {
  decryptStoredObject,
  isEncryptedStoredObject,
  type Storage,
} from "../packages/storage/index.ts";
import { migrateStorageEncryption } from "../scripts/migrate-storage-encryption.ts";

function memoryStorage(initial: Record<string, Buffer>) {
  const data = new Map(Object.entries(initial));
  const storage: Storage = {
    async put(key, value) {
      if (data.has(key)) throw new Error("Object already exists");
      data.set(key, Buffer.from(value));
    },
    async get(key) {
      const value = data.get(key);
      if (!value) throw Object.assign(new Error("Missing"), { code: "ENOENT" });
      return Buffer.from(value);
    },
    async delete(key) {
      data.delete(key);
    },
    async health() {},
  };
  return { data, storage };
}

test("storage encryption migration repoints plaintext objects and is idempotent", async () => {
  const env = { ENCRYPTION_KEY: "e".repeat(64) } as NodeJS.ProcessEnv,
    pg = await testPostgres(55439),
    db = new Database(pg.url, { serialize: pg.emulated }),
    tenant = randomUUID(),
    root = randomUUID(),
    page = randomUUID(),
    file = randomUUID(),
    oldKey = `${tenant}/${page}/${file}`,
    plain = Buffer.from("legacy plaintext attachment"),
    memory = memoryStorage({ [oldKey]: plain });

  await migrate(pg.url);
  try {
    await db.tenant(tenant, async (q) => {
      await q.query("INSERT INTO organisations(id,name) VALUES($1,'Encryption migration')", [
        tenant,
      ]);
      await q.query(
        "INSERT INTO resources(id,tenant_id,kind,title) VALUES($1,$2,'workspace','HQ')",
        [root, tenant],
      );
      await q.query(
        "INSERT INTO resources(id,tenant_id,parent_id,kind,title) VALUES($1,$2,$3,'page','Legacy file')",
        [page, tenant, root],
      );
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size) VALUES($1,$2,$3,$4,'legacy.txt','text/plain',$5)",
        [file, tenant, page, oldKey, plain.length],
      );
    });

    const first = await migrateStorageEncryption(pg.url, memory.storage, env);
    assert.deepEqual(first, {
      encrypted: 1,
      already_encrypted: 0,
      deletion_deferred: 0,
    });

    const state = await db.system(async (q) => ({
      file: (
        await q.query("SELECT object_key FROM files WHERE id=$1", [file])
      ).rows[0],
      deletion: (
        await q.query(
          "SELECT object_key,reason,status FROM object_deletions WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0],
    }));
    assert.notEqual(state.file.object_key, oldKey);
    assert.equal(memory.data.has(oldKey), false);

    const encrypted = memory.data.get(state.file.object_key);
    assert(encrypted);
    assert(isEncryptedStoredObject(encrypted!));
    assert.deepEqual(
      decryptStoredObject(state.file.object_key, encrypted!, env),
      plain,
    );
    assert.deepEqual(state.deletion, {
      object_key: oldKey,
      reason: "storage_encryption_migration",
      status: "completed",
    });

    const second = await migrateStorageEncryption(pg.url, memory.storage, env);
    assert.deepEqual(second, {
      encrypted: 0,
      already_encrypted: 1,
      deletion_deferred: 0,
    });
  } finally {
    await db.close();
    await pg.close();
  }
});
