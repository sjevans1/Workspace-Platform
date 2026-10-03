import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database } from "../packages/database/index.ts";
import {
  backup,
  restore,
  encodeBackup,
  decodeBackup,
} from "../scripts/backup.ts";
import type { Storage } from "../packages/storage/index.ts";
import { blocksToState, project } from "../packages/editor/server.ts";
import { sealTenantOidcSecret, openTenantOidcSecret } from "../packages/auth/tenant-provider.ts";
import { encrypt, decrypt } from "../packages/events/index.ts";
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
test("backup restores rich Yjs blocks, table and private media bytes atomically", async () => {
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
    imageFile = randomUUID(),
    user = randomUUID(),
    connector = randomUUID(),
    webhook = randomUUID(),
    scimUser = randomUUID(),
    scimGroup = randomUUID(),
    key = `${tenant}/${page}/${file}`,
    imageKey = `${tenant}/${page}/${imageFile}`;
  // The native backup must retain both the Yjs document *and* the actual
  // private storage objects referenced by installed BlockNote Core blocks.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRwwAAAAASUVORK5CYII=",
    "base64",
  );
  const richBlocks: any[] = [
    { id: randomUUID(), type: "heading", props: { level: 2 },
      content: "Backup evidence" },
    { id: randomUUID(), type: "callout", props: { variant: "warning" },
      content: [{type:"text",text:"Review before recovery",styles:{bold:true}}] },
    { id: randomUUID(), type: "table", content: {
      type: "tableContent", rows: [
        { cells: ["Warehouse", "Stock"] },
        { cells: ["Blue Mountain", "24"] },
      ],
    }},
    { id: randomUUID(), type: "image", props: {
      name: "private-1x1.png", caption: "Source diagram",
      url: `/api/v1/files/${imageFile}/content`,
    }},
    { id: randomUUID(), type: "file", props: {
      name: "evidence.txt", url: `/api/v1/files/${file}/content`,
    }},
  ];
  const state = blocksToState(richBlocks);
  const document = new Y.Doc();
  let original: ReturnType<typeof project>;
  try {
    Y.applyUpdate(document, state);
    original = project(document);
  } finally { document.destroy(); }
  assert.match(original.plain_text, /Blue Mountain/);
  assert.equal(original.plain_text.includes("/api/v1/files"), false);
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
        "INSERT INTO page_documents(tenant_id,resource_id,y_state,blocks,plain_text) VALUES($1,$2,$3,$4,$5)",
        [tenant, page, state, JSON.stringify(original.blocks), original.plain_text],
      );
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size) VALUES($1,$2,$3,$4,'evidence.txt','text/plain',13)",
        [file, tenant, page, key],
      );
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size) VALUES($1,$2,$3,$4,'private-1x1.png','image/png',$5)",
        [imageFile, tenant, page, imageKey, png.length],
      );
      await q.query(
        "INSERT INTO users(id,email,name,password_hash) VALUES($1,'directory@example.test','Directory User',NULL)",
        [user],
      );
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role,active) VALUES($1,$2,'guest',true)",
        [tenant, user],
      );
      const providerId = randomUUID();
      await q.query(
        "INSERT INTO webhook_subscriptions(id,tenant_id,url,events,secret_encrypted," +
          " pending_secret_encrypted,signing_revision) VALUES($1,$2,'https://events.example.test/inbox'," +
          " ARRAY['page.updated'],$3,$4,2)",
        [
          webhook,
          tenant,
          encrypt("backup-active-secret"),
          encrypt("backup-prepared-secret"),
        ],
      );
      await q.query(
        "INSERT INTO oidc_tenant_providers" +
          " (id,tenant_id,label,issuer,client_id,token_auth_method,client_secret_encrypted,created_by)" +
          " VALUES($1,$2,'Backup IdP','https://idp.example.test/','backup-client'," +
          " 'client_secret_basic',$3,$4)",
        [
          providerId,
          tenant,
          sealTenantOidcSecret("backup-oidc-secret", tenant, providerId),
          user,
        ],
      );

      await q.query(
        "INSERT INTO scim_connectors(id,tenant_id,label,token_hash,default_role,created_by) VALUES($1,$2,'Directory','backup-token-hash','guest',$3)",
        [connector, tenant, user],
      );
      await q.query(
        "INSERT INTO scim_users(id,tenant_id,user_id,external_id,user_name,display_name,base_role) VALUES($1,$2,$3,'backup-user','directory@example.test','Directory User','guest')",
        [scimUser, tenant, user],
      );
      await q.query(
        "INSERT INTO scim_groups(id,tenant_id,external_id,display_name) VALUES($1,$2,'backup-group','Backup Group')",
        [scimGroup, tenant],
      );
      await q.query(
        "INSERT INTO scim_group_role_mappings(tenant_id,group_id,role,created_by) VALUES($1,$2,'member',$3)",
        [tenant, scimGroup, user],
      );
      await q.query(
        "INSERT INTO scim_group_members(tenant_id,group_id,scim_user_id) VALUES($1,$2,$3)",
        [tenant, scimGroup, scimUser],
      );
    });
    await source.storage.put(key, Buffer.from("Private bytes"), "text/plain");
    await source.storage.put(imageKey, png, "image/png");
    const archive = await backup(pg.url, source.storage);
    assert.deepEqual(Object.keys(archive.objects).sort(), [key, imageKey].sort());
    assert.equal(archive.objects[imageKey].mime, "image/png");
    const encodedArchive = encodeBackup(archive);
    assert.match(encodedArchive, /openjm-backup-encrypted-v1/);
    assert.doesNotMatch(encodedArchive, /Backup evidence|Private bytes/);
    assert.equal(
      JSON.stringify(decodeBackup(encodedArchive)),
      JSON.stringify(archive),
    );

    process.env.ENCRYPTION_KEY = "b".repeat(64);
    assert.throws(() => decodeBackup(encodedArchive), /Backup decryption failed/);
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    assert.throws(
      () => decodeBackup(JSON.stringify(archive)),
      /Legacy plaintext backup refused/,
    );
    assert.equal(
      JSON.stringify(
        decodeBackup(JSON.stringify(archive), {
          ...process.env,
          ALLOW_LEGACY_PLAINTEXT_BACKUP: "true",
        }),
      ),
      JSON.stringify(archive),
      "legacy plaintext archives require an explicit one-time restore opt-in",
    );

    await assert.rejects(
      restore(pg.url, archive, target.storage),
      /empty database/,
    );
    for (const damaged of [key, imageKey]) {
      const corrupt = structuredClone(archive);
      corrupt.objects[damaged].data = Buffer.from("corrupt").toString("base64");
      await assert.rejects(
        restore(pg.url, corrupt, target.storage), /checksum/,
        "tampered objects must fail *before* writing any restore bytes",
      );
      assert.equal(target.data.size, 0, "corrupt archive must not write objects");
    }
    await db.system((q) => q.query("TRUNCATE organisations,users CASCADE"));
    await restore(pg.url, archive, target.storage);
    const rows = await db.tenant(tenant, (q) =>
      q.query("SELECT * FROM page_documents WHERE resource_id=$1", [page]),
    );
    assert.equal(rows.rows[0].plain_text, original.plain_text);
    assert(Buffer.from(rows.rows[0].y_state).equals(state));
    // JSONB discards undefined object properties and converts undefined
    // array slots to null (such as unset Core table column widths).
    // Compare the canonical JSON representation, while the separate
    // raw Yjs check verifies the exact native document bytes.
    assert.deepEqual(rows.rows[0].blocks,
      JSON.parse(JSON.stringify(original.blocks)));
    const restoredDocument = new Y.Doc();
    try {
      Y.applyUpdate(restoredDocument, Buffer.from(rows.rows[0].y_state));
      const restoredRich = project(restoredDocument);
      assert.deepEqual(restoredRich.blocks, original.blocks,
        "rich table/callout/media schema must survive encrypted archive round trip");
      assert.deepEqual(
        restoredRich.blocks.map((block:any)=>block.id),
        richBlocks.map(block=>block.id),
        "block identities must be preserved");
      assert.deepEqual(
        restoredRich.blocks.map((block:any)=>block.type),
        ["heading","callout","table","image","file"]);
      assert.equal((restoredRich.blocks[1] as any).props.variant, "warning");
      assert.match(JSON.stringify(restoredRich.blocks[2]), /Blue Mountain/);
      assert.equal((restoredRich.blocks[3] as any).props.url,
        `/api/v1/files/${imageFile}/content`);
      assert.equal((restoredRich.blocks[4] as any).props.url,
        `/api/v1/files/${file}/content`);
    } finally { restoredDocument.destroy(); }
    const directory = await db.tenant(tenant, async (q) => ({
      user: await q.query(
        "SELECT base_role FROM scim_users WHERE id=$1",
        [scimUser],
      ),
      group: await q.query(
        "SELECT display_name FROM scim_groups WHERE id=$1",
        [scimGroup],
      ),
      mapping: await q.query(
        "SELECT role FROM scim_group_role_mappings WHERE group_id=$1",
        [scimGroup],
      ),
      members: await q.query(
        "SELECT scim_user_id FROM scim_group_members WHERE group_id=$1",
        [scimGroup],
      ),
    }));
    const providers = await db.tenant(tenant, (q) =>
      q.query(
        "SELECT id,client_secret_encrypted,enabled FROM oidc_tenant_providers",
      ),
    );
    const hooks = await db.tenant(tenant, (q) =>
      q.query(
        "SELECT secret_encrypted,pending_secret_encrypted,signing_revision FROM webhook_subscriptions WHERE id=$1",
        [webhook],
      ),
    );
    assert.equal(hooks.rows[0].signing_revision, 2);
    assert.equal(
      decrypt(hooks.rows[0].secret_encrypted),
      "backup-active-secret",
    );
    assert.equal(
      decrypt(hooks.rows[0].pending_secret_encrypted),
      "backup-prepared-secret",
    );
    assert.equal(providers.rows.length, 1);
    assert.equal(providers.rows[0].enabled, false);
    assert.equal(
      openTenantOidcSecret(
        providers.rows[0].client_secret_encrypted,
        tenant,
        providers.rows[0].id,
      ),
      "backup-oidc-secret",
    );

    assert.equal(directory.user.rows[0].base_role, "guest");
    assert.equal(directory.group.rows[0].display_name, "Backup Group");
    assert.equal(directory.mapping.rows[0].role, "member");
    assert.equal(directory.members.rows[0].scim_user_id, scimUser);
    assert.equal((await target.storage.get(key)).toString(), "Private bytes");
    assert.deepEqual(await target.storage.get(imageKey), png,
      "private linked image must be byte-for-byte restored");
    const linkedFiles=await db.tenant(tenant,(q)=>
      q.query("SELECT id,mime,object_key FROM files WHERE resource_id=$1 ORDER BY mime", [page]));
    assert.equal(linkedFiles.rows.length,2);
    assert.deepEqual(linkedFiles.rows.map((row:any)=>row.object_key).sort(),
      [key,imageKey].sort());
  } finally {
    await db.close();
    await pg.close();
  }
});
