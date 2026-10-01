import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { blocksToState } from "../packages/editor/server.ts";
import { sealTenantOidcSecret, openTenantOidcSecret } from "../packages/auth/tenant-provider.ts";
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
    user = randomUUID(),
    connector = randomUUID(),
    scimUser = randomUUID(),
    scimGroup = randomUUID(),
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
        "INSERT INTO sessions" +
          " (token_hash,tenant_id,user_id,expires_at,oidc_issuer,oidc_subject,oidc_provider_id)" +
          " VALUES('backup-oidc-session',$1,$2,now()+interval '12 hours',$3,'backup-oidc-subject',$4)",
        [tenant, user, "https://idp.example.test/", providerId],
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
    const archive = await backup(pg.url, source.storage);
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
    assert.equal(providers.rows.length, 1);
    assert.equal(providers.rows[0].enabled, false);
    const bound = await db.tenant(tenant, (q) =>
      q.query(
        "SELECT oidc_provider_id,oidc_issuer FROM sessions WHERE token_hash='backup-oidc-session'",
      ),
    );
    assert.equal(bound.rows.length, 1);
    assert.equal(bound.rows[0].oidc_provider_id, providers.rows[0].id);
    assert.equal(bound.rows[0].oidc_issuer, "https://idp.example.test/");

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
  } finally {
    await db.close();
    await pg.close();
  }
});
