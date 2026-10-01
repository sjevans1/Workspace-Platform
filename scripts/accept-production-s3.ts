import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createStorage, type Storage } from "../packages/storage/index.ts";
import { Database } from "../packages/database/index.ts";
import { migrate } from "../packages/database/migrate.ts";
import { blocksToState } from "../packages/editor/server.ts";
import { backup, restore } from "./backup.ts";
import { testPostgres } from "./test-postgres.ts";

function required(name: string) {
  const value = process.env[name]?.trim();
  assert(value, `${name} is required`);
  return value;
}

function bool(name: string, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function storageEnv(kind: "SOURCE" | "RECOVERY") {
  const sharedEndpoint = required("S3_ACCEPT_ENDPOINT");
  const sharedAccessKey = required("S3_ACCEPT_ACCESS_KEY");
  const sharedSecretKey = required("S3_ACCEPT_SECRET_KEY");
  const bucket = required(`S3_ACCEPT_${kind}_BUCKET`);
  return {
    STORAGE_PROVIDER: "s3",
    S3_ENDPOINT:
      process.env[`S3_ACCEPT_${kind}_ENDPOINT`]?.trim() || sharedEndpoint,
    S3_REGION:
      process.env[`S3_ACCEPT_${kind}_REGION`]?.trim() ||
      process.env.S3_ACCEPT_REGION?.trim() ||
      "us-east-1",
    S3_BUCKET: bucket,
    S3_ACCESS_KEY:
      process.env[`S3_ACCEPT_${kind}_ACCESS_KEY`]?.trim() || sharedAccessKey,
    S3_SECRET_KEY:
      process.env[`S3_ACCEPT_${kind}_SECRET_KEY`]?.trim() || sharedSecretKey,
    S3_FORCE_PATH_STYLE: String(
      bool(
        `S3_ACCEPT_${kind}_FORCE_PATH_STYLE`,
        bool("S3_ACCEPT_FORCE_PATH_STYLE", true),
      ),
    ),
  } satisfies NodeJS.ProcessEnv;
}

function missing(error: any) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 404 || error?.name === "NoSuchKey";
}

function precondition(error: any) {
  const status = error?.$metadata?.httpStatusCode;
  return (
    status === 409 ||
    status === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.Code === "PreconditionFailed"
  );
}

async function safeDelete(storage: Storage, key: string) {
  try {
    await storage.delete(key);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

const confirmation = process.env.S3_ACCEPT_WRITE_CONFIRMATION;
assert.equal(
  confirmation,
  "I_UNDERSTAND_THIS_WRITES_TEST_OBJECTS",
  "Refusing to write. Set S3_ACCEPT_WRITE_CONFIRMATION=I_UNDERSTAND_THIS_WRITES_TEST_OBJECTS only for dedicated acceptance buckets.",
);

assert(
  process.env.TEST_DATABASE_URL,
  "TEST_DATABASE_URL is required and must point to a disposable PostgreSQL server where temporary databases may be created.",
);

const sourceEnv = storageEnv("SOURCE"),
  recoveryEnv = storageEnv("RECOVERY");

assert.notEqual(
  sourceEnv.S3_BUCKET,
  recoveryEnv.S3_BUCKET,
  "Source and recovery buckets must be different.",
);

for (const endpoint of [sourceEnv.S3_ENDPOINT, recoveryEnv.S3_ENDPOINT]) {
  if (!endpoint?.startsWith("https://")) {
    assert(
      bool("S3_ACCEPT_ALLOW_INSECURE"),
      "Real-provider acceptance requires HTTPS unless S3_ACCEPT_ALLOW_INSECURE=true is explicitly set for an isolated test endpoint.",
    );
  }
}

process.env.ENCRYPTION_KEY ||= randomBytes(32).toString("hex");

const source = createStorage(sourceEnv),
  recovery = createStorage(recoveryEnv),
  sourcePg = await testPostgres(),
  recoveryPg = await testPostgres(),
  sourceDb = new Database(sourcePg.url),
  recoveryDb = new Database(recoveryPg.url),
  createdSourceKeys: string[] = [],
  createdRecoveryKeys: string[] = [];

try {
  await Promise.all([source.health(), recovery.health()]);
  await Promise.all([migrate(sourcePg.url), migrate(recoveryPg.url)]);

  const tenant = randomUUID(),
    root = randomUUID(),
    space = randomUUID(),
    page = randomUUID(),
    files = [randomUUID(), randomUUID()],
    keys = files.map((file) => `${tenant}/${page}/${file}`),
    bytes = [
      Buffer.from("OpenJM production S3 acceptance active object"),
      Buffer.from("OpenJM production S3 acceptance retained deleted object"),
    ],
    state = blocksToState([
      { type: "paragraph", content: "Production S3 recovery evidence" },
    ]);

  await sourceDb.tenant(tenant, async (q) => {
    await q.query(
      "INSERT INTO organisations(id,name) VALUES($1,'Production S3 acceptance')",
      [tenant],
    );
    await q.query(
      "INSERT INTO resources(id,tenant_id,kind,title) VALUES($1,$2,'workspace','Acceptance HQ')",
      [root, tenant],
    );
    await q.query(
      "INSERT INTO resources(id,tenant_id,parent_id,kind,title) VALUES($1,$2,$3,'space','Acceptance')",
      [space, tenant, root],
    );
    await q.query(
      "INSERT INTO resources(id,tenant_id,parent_id,kind,title) VALUES($1,$2,$3,'page','S3 recovery evidence')",
      [page, tenant, space],
    );
    await q.query(
      "INSERT INTO page_documents(tenant_id,resource_id,y_state,plain_text) VALUES($1,$2,$3,'Production S3 recovery evidence')",
      [tenant, page, state],
    );
    for (let i = 0; i < keys.length; i++) {
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size,deleted_at) VALUES($1,$2,$3,$4,$5,'text/plain',$6,$7)",
        [
          files[i],
          tenant,
          page,
          keys[i],
          `acceptance-${i}.txt`,
          bytes[i].length,
          i === 1 ? new Date() : null,
        ],
      );
    }
  });

  for (let i = 0; i < keys.length; i++) {
    await source.put(keys[i], bytes[i], "text/plain");
    createdSourceKeys.push(keys[i]);
  }

  await assert.rejects(
    source.put(keys[0], Buffer.from("must not overwrite"), "text/plain"),
    precondition,
    "Provider must enforce conditional immutable PUT with If-None-Match: *",
  );
  assert.deepEqual(await source.get(keys[0]), bytes[0]);

  for (const key of keys)
    await assert.rejects(
      recovery.get(key),
      missing,
      "Recovery bucket already contains a generated acceptance key",
    );
  // Register generated recovery keys before any target write so cleanup remains
  // bounded and effective even if a provider fails partway through restore.
  createdRecoveryKeys.push(...keys);

  const archive = await backup(sourcePg.url, source);
  assert.equal(Object.keys(archive.objects).length, 2);

  await recovery.put(keys[0], Buffer.from("collision sentinel"), "text/plain");
  await assert.rejects(
    restore(recoveryPg.url, archive, recovery),
    /destination is not empty/,
    "Restore must refuse a colliding object key",
  );
  await safeDelete(recovery, keys[0]);

  await restore(recoveryPg.url, archive, recovery);

  const recovered = await recoveryDb.tenant(tenant, (q) =>
    q.query(
      "SELECT y_state,plain_text FROM page_documents WHERE resource_id=$1",
      [page],
    ),
  );
  assert.equal(recovered.rows[0].plain_text, "Production S3 recovery evidence");
  assert.deepEqual(Buffer.from(recovered.rows[0].y_state), state);

  const metadata = await recoveryDb.tenant(tenant, (q) =>
    q.query("SELECT name,deleted_at FROM files ORDER BY name"),
  );
  assert.equal(metadata.rowCount, 2);
  assert.equal(metadata.rows[0].deleted_at, null);
  assert(metadata.rows[1].deleted_at);

  for (let i = 0; i < keys.length; i++) {
    assert.deepEqual(await recovery.get(keys[i]), bytes[i]);
    assert.deepEqual(
      await source.get(keys[i]),
      bytes[i],
      "Source object changed during recovery acceptance",
    );
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        provider: process.env.S3_ACCEPT_PROVIDER_LABEL || "S3-compatible",
        checks: [
          "source and recovery bucket health",
          "HTTPS endpoint policy",
          "conditional immutable PUT",
          "source backup",
          "collision-safe restore refusal",
          "separate recovery database and bucket",
          "canonical Yjs recovery",
          "active and retained-deleted object recovery",
          "source preservation",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  for (const key of createdRecoveryKeys) await safeDelete(recovery, key);
  for (const key of createdSourceKeys) await safeDelete(source, key);
  source.close?.();
  recovery.close?.();
  await sourceDb.close();
  await recoveryDb.close();
  await sourcePg.close();
  await recoveryPg.close();
}
