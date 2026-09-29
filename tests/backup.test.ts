import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database } from "../packages/database/index.ts";
import { backup, restore } from "../scripts/backup.ts";
import type { Storage } from "../packages/storage/index.ts";
import { blocksToState } from "../packages/editor/server.ts";
function memory() {
  const data = new Map<string, Buffer>();
  const storage: Storage = {
    async put(k, v) {
      data.set(k, v);
    },
    async get(k) {
      if (!data.has(k))
        throw Object.assign(Error("Missing"), { code: "ENOENT" });
      return data.get(k)!;
    },
    async delete(k) {
      data.delete(k);
    },
    async health() {},
  };
  return { data, storage };
}
test("backup round-trip restores metadata, canonical Yjs bytes and private objects; corrupt and nonempty restores fail", async () => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  const pg = await testPostgres(55434),
    source = memory(),
    target = memory();
  await migrate(pg.url);
  const db = new Database(pg.url, { serialize: pg.emulated }),
    tenant = randomUUID(),
    root = randomUUID(),
    space = randomUUID(),
    page = randomUUID(),
    file = randomUUID(),
    key = `${tenant}/${page}/${file}`;
  const state = blocksToState([
    { type: "paragraph", content: "Backup evidence" },
  ]);
  try {
    await db.tenant(tenant, async (q) => {
      await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
        tenant,
        "Restore test",
      ]);
      await q.query(
        "INSERT INTO resources(id,tenant_id,kind,title) VALUES($1,$2,'workspace','HQ')",
        [root, tenant],
      );
      await q.query(
        "INSERT INTO resources(id,tenant_id,parent_id,kind,title) VALUES($1,$2,$3,'space','Wiki')",
        [space, tenant, root],
      );
      await q.query(
        "INSERT INTO resources(id,tenant_id,parent_id,kind,title) VALUES($1,$2,$3,'page','Evidence')",
        [page, tenant, space],
      );
      await q.query(
        "INSERT INTO page_documents(tenant_id,resource_id,y_state,plain_text) VALUES($1,$2,$3,$4)",
        [tenant, page, state, "Backup evidence"],
      );
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size) VALUES($1,$2,$3,$4,'evidence.txt','text/plain',13)",
        [file, tenant, page, key],
      );
    });
    await source.storage.put(key, Buffer.from("Private bytes"), "text/plain");
    const archive = await backup(pg.url, source.storage);
    await assert.rejects(
      restore(pg.url, archive, target.storage),
      /empty database/,
    );
    const corrupt = structuredClone(archive);
    corrupt.objects[key].data = Buffer.from("corrupt").toString("base64");
    await assert.rejects(restore(pg.url, corrupt, target.storage), /checksum/);
    await db.system((q) => q.query("TRUNCATE organisations,users CASCADE"));
    await restore(pg.url, archive, target.storage);
    const rows = await db.tenant(tenant, (q) =>
      q.query("SELECT * FROM page_documents WHERE resource_id=$1", [page]),
    );
    assert.equal(rows.rows[0].plain_text, "Backup evidence");
    assert(Buffer.from(rows.rows[0].y_state).equals(state));
    assert.equal((await target.storage.get(key)).toString(), "Private bytes");
  } finally {
    await db.close();
    await pg.close();
  }
});
