import test from "node:test";
import assert from "node:assert/strict";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { provisionTenant } from "../scripts/provision-tenant.ts";

test("operator tenant provisioning is atomic, conservative and auditable", async () => {
  process.env.ENCRYPTION_KEY = "b".repeat(64);
  const pg = await testPostgres(55438);
  await migrate(pg.url);
  const db = new Database(pg.url, { serialize: pg.emulated });

  try {
    const first = await provisionTenant(db, {
      organisation: "Provisioned Alpha",
      workspace: "Alpha HQ",
      ownerName: "Alice Owner",
      ownerEmail: "alice.provision@example.test",
      ownerPassword: "test-password-123",
      demo: false,
    });

    assert.equal(first.owner_mode, "local-password");

    const firstState = await db.system(async (q) => {
      const org = await one(q, "SELECT name FROM organisations WHERE id=$1", [
        first.tenant_id,
      ]);
      const membership = await one(
        q,
        "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
        [first.tenant_id, first.owner_user_id],
      );
      const user = await one(
        q,
        "SELECT email,password_hash,is_service FROM users WHERE id=$1",
        [first.owner_user_id],
      );
      const root = await one(
        q,
        "SELECT id,title,kind FROM resources WHERE tenant_id=$1 AND parent_id IS NULL",
        [first.tenant_id],
      );
      const audit = await one(
        q,
        "SELECT action,resource_id,request_id FROM audit_events WHERE tenant_id=$1 AND action='tenant.provisioned'",
        [first.tenant_id],
      );
      return { org, membership, user, root, audit };
    });

    assert.equal(firstState.org.name, "Provisioned Alpha");
    assert.deepEqual(firstState.membership, { role: "owner", active: true });
    assert.equal(firstState.user.email, "alice.provision@example.test");
    assert.equal(firstState.user.is_service, false);
    assert.match(firstState.user.password_hash, /^scrypt:/);
    assert.equal(firstState.root.id, first.workspace_id);
    assert.equal(firstState.root.title, "Alpha HQ");
    assert.equal(firstState.root.kind, "workspace");
    assert.deepEqual(firstState.audit, {
      action: "tenant.provisioned",
      resource_id: first.workspace_id,
      request_id: "operator-provisioning",
    });

    await assert.rejects(
      provisionTenant(db, {
        organisation: "Provisioned Alpha",
        workspace: "Duplicate HQ",
        ownerName: "Another Owner",
        ownerEmail: "another@example.test",
        ownerPassword: "another-password-123",
      }),
      /organisation with this name already exists/i,
    );

    await assert.rejects(
      provisionTenant(db, {
        organisation: "Provisioned Beta",
        workspace: "Beta HQ",
        ownerName: "Alice Owner",
        ownerEmail: "alice.provision@example.test",
      }),
      /Owner email already exists/,
    );

    const originalHash = firstState.user.password_hash;
    const second = await provisionTenant(db, {
      organisation: "Provisioned Beta",
      workspace: "Beta HQ",
      ownerName: "Alice Owner",
      ownerEmail: "alice.provision@example.test",
      allowExistingUser: true,
      demo: false,
    });

    assert.equal(second.owner_mode, "existing-user");
    assert.equal(second.owner_user_id, first.owner_user_id);

    const reused = await db.system(async (q) => ({
      user: await one(
        q,
        "SELECT password_hash FROM users WHERE id=$1",
        [first.owner_user_id],
      ),
      memberships: (
        await q.query(
          "SELECT tenant_id,role,active FROM memberships WHERE user_id=$1 ORDER BY tenant_id",
          [first.owner_user_id],
        )
      ).rows,
    }));
    assert.equal(reused.user.password_hash, originalHash);
    assert.equal(reused.memberships.length, 2);
    assert.ok(
      reused.memberships.every(
        (m: any) => m.role === "owner" && m.active === true,
      ),
    );

    const passwordless = await provisionTenant(db, {
      organisation: "Provisioned SSO",
      workspace: "SSO HQ",
      ownerName: "SSO Owner",
      ownerEmail: "sso.provision@example.test",
      passwordlessOwner: true,
      demo: false,
    });
    assert.equal(passwordless.owner_mode, "passwordless-sso");
    const ssoUser = await db.system((q) =>
      one(q, "SELECT password_hash FROM users WHERE id=$1", [
        passwordless.owner_user_id,
      ]),
    );
    assert.equal(ssoUser.password_hash, null);

    await assert.rejects(
      provisionTenant(db, {
        organisation: "Invalid Mode",
        workspace: "Invalid HQ",
        ownerName: "Invalid Owner",
        ownerEmail: "invalid@example.test",
        ownerPassword: "invalid-password-123",
        passwordlessOwner: true,
      }),
      /either an owner password or passwordless SSO/,
    );
  } finally {
    await db.close();
    await pg.close();
  }
});
