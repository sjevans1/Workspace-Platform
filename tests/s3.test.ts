import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { createStorage, type Storage } from "../packages/storage/index.ts";
import { Database } from "../packages/database/index.ts";
import { migrate } from "../packages/database/migrate.ts";
import { blocksToState } from "../packages/editor/server.ts";
import { backup, restore } from "../scripts/backup.ts";
import { testPostgres } from "../scripts/test-postgres.ts";

test(
  "S3: private immutable objects, isolated backup recovery and failed-restore rollback",
  { skip: !process.env.TEST_S3_ENDPOINT || !process.env.TEST_DATABASE_URL },
  async (t) => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    const config = {
      STORAGE_PROVIDER: "s3",
      S3_ENDPOINT: process.env.TEST_S3_ENDPOINT!,
      S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY!,
      S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY!,
    };
    assert(
      config.S3_ACCESS_KEY && config.S3_SECRET_KEY,
      "Test S3 credentials required",
    );
    const client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
    });
    const stores: { bucket: string; storage: Storage }[] = [];
    const databases: {
      db: Database;
      pg: Awaited<ReturnType<typeof testPostgres>>;
    }[] = [];
    const keys: string[] = [];
    t.after(async () => {
      try {
        for (const { bucket, storage } of stores) {
          try {
            for (const key of keys) await storage.delete(key);
            await client.send(new DeleteBucketCommand({ Bucket: bucket }));
          } finally {
            storage.close?.();
          }
        }
      } finally {
        client.destroy();
        for (const { db, pg } of databases) {
          await db.close();
          await pg.close();
        }
      }
    });
    // SeaweedFS mini seeds this authenticated bucket when its container starts.
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: "workspace-ci" }));
        break;
      } catch (error) {
        if (attempt >= 29) throw error;
        await delay(1000);
      }
    }
    for (const suffix of ["source", "recovery"]) {
      const bucket = `workspace-${randomUUID()}-${suffix}`;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      stores.push({
        bucket,
        storage: createStorage({ ...config, S3_BUCKET: bucket }),
      });
      const pg = await testPostgres();
      const db = new Database(pg.url);
      databases.push({ db, pg });
      await migrate(pg.url);
    }
    const source = stores[0].storage,
      target = stores[1].storage;
    const sourceDB = databases[0],
      targetDB = databases[1];
    const tenant = randomUUID(),
      root = randomUUID(),
      space = randomUUID(),
      page = randomUUID();
    const state = blocksToState([
      { type: "paragraph", content: "S3 recovery evidence" },
    ]);
    const bytes = [
      Buffer.from("Private active attachment"),
      Buffer.from("Retained deleted attachment"),
    ];
    await sourceDB.db.tenant(tenant, async (q) => {
      await q.query(
        "INSERT INTO organisations(id,name) VALUES($1,'Recovery source')",
        [tenant],
      );
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
        "INSERT INTO page_documents(tenant_id,resource_id,y_state,plain_text) VALUES($1,$2,$3,'S3 recovery evidence')",
        [tenant, page, state],
      );
      for (let i = 0; i < bytes.length; i++) {
        const file = randomUUID(),
          key = `${tenant}/${page}/${file}`;
        keys.push(key);
        await q.query(
          "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size,deleted_at) VALUES($1,$2,$3,$4,$5,'text/plain',$6,$7)",
          [
            file,
            tenant,
            page,
            key,
            `evidence-${i}.txt`,
            bytes[i].length,
            i ? new Date() : null,
          ],
        );
      }
    });
    for (let i = 0; i < keys.length; i++)
      await source.put(keys[i], bytes[i], "text/plain");
    await source.health();
    const precondition = (error: any) =>
      error.$metadata?.httpStatusCode === 412;
    await assert.rejects(
      source.put(keys[0], Buffer.from("Overwrite"), "text/plain"),
      precondition,
    );
    assert.deepEqual(await source.get(keys[0]), bytes[0]);
    const anonymous = await fetch(
      `${config.S3_ENDPOINT}/${stores[0].bucket}/${keys[0]}`,
    );
    assert.equal(
      anonymous.status,
      403,
      "Raw object URLs must require authentication",
    );
    await anonymous.arrayBuffer();
    const unauthorized = createStorage({
      ...config,
      S3_BUCKET: stores[0].bucket,
      S3_SECRET_KEY: "wrong-secret",
    });
    try {
      await assert.rejects(
        unauthorized.health(),
        (error: any) => error.$metadata?.httpStatusCode === 403,
      );
    } finally {
      unauthorized.close?.();
    }

    const archive = await backup(sourceDB.pg.url, source);
    assert.equal(
      Object.keys(archive.objects).length,
      2,
      "Backups include retained deleted files",
    );
    await assert.rejects(
      restore(sourceDB.pg.url, archive, target),
      /empty database/,
    );
    const corrupt = structuredClone(archive);
    corrupt.objects[keys[0]].data = Buffer.from("corrupt").toString("base64");
    await assert.rejects(restore(targetDB.pg.url, corrupt, target), /checksum/);
    await assert.rejects(
      restore(
        targetDB.pg.url,
        { ...archive, key_fingerprint: "wrong" },
        target,
      ),
      /encryption key/,
    );
    await assert.rejects(
      restore(targetDB.pg.url, { ...archive, versions: [] }, target),
      /same schema/,
    );
    const emptyDatabase = async () => {
      const result = await targetDB.db.system((q) =>
        q.query(
          "SELECT (SELECT count(*) FROM organisations) AS organisations, (SELECT count(*) FROM files) AS files",
        ),
      );
      assert.deepEqual(result.rows[0], { organisations: "0", files: "0" });
    };
    const missing = (error: any) => error.$metadata?.httpStatusCode === 404;
    await emptyDatabase();
    await target.put(keys[0], Buffer.from("Keep existing"), "text/plain");
    await assert.rejects(
      restore(targetDB.pg.url, archive, target),
      /destination is not empty/,
    );
    await emptyDatabase();
    assert.equal((await target.get(keys[0])).toString(), "Keep existing");
    await target.delete(keys[0]);

    // Model another writer winning between the restore preflight GET and PUT.
    const racedKey = Object.keys(archive.objects)[0];
    const racing: Storage = {
      ...target,
      async put(key, value, mime) {
        await target.put(key, Buffer.from("Concurrent object"), mime);
        await target.put(key, value, mime);
      },
    };
    await assert.rejects(
      restore(targetDB.pg.url, archive, racing),
      precondition,
    );
    await emptyDatabase();
    assert.equal((await target.get(racedKey)).toString(), "Concurrent object");
    await target.delete(racedKey);

    let uploads = 0;
    const interrupted: Storage = {
      ...target,
      async put(key, value, mime) {
        if (++uploads === 2) throw Error("Injected upload failure");
        await target.put(key, value, mime);
      },
    };
    await assert.rejects(
      restore(targetDB.pg.url, archive, interrupted),
      /Injected upload failure/,
    );
    await emptyDatabase();
    for (const key of keys) await assert.rejects(target.get(key), missing);

    await restore(targetDB.pg.url, archive, target);
    const recovered = await targetDB.db.tenant(tenant, (q) =>
      q.query(
        "SELECT y_state,plain_text FROM page_documents WHERE resource_id=$1",
        [page],
      ),
    );
    assert.equal(recovered.rows[0].plain_text, "S3 recovery evidence");
    assert.deepEqual(Buffer.from(recovered.rows[0].y_state), state);
    const metadata = await targetDB.db.tenant(tenant, (q) =>
      q.query("SELECT name,deleted_at FROM files ORDER BY name"),
    );
    assert.equal(metadata.rowCount, 2);
    assert.equal(metadata.rows[0].deleted_at, null);
    assert(metadata.rows[1].deleted_at);
    for (let i = 0; i < keys.length; i++) {
      assert.deepEqual(await target.get(keys[i]), bytes[i]);
      assert.deepEqual(
        await source.get(keys[i]),
        bytes[i],
        "Source remains intact",
      );
    }
    await assert.rejects(
      restore(targetDB.pg.url, archive, target),
      /empty database/,
    );
  },
);
