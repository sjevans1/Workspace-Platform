import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";
import { createSession, hash } from "../packages/auth/index.ts";

test("OIDC state and session provider bindings require atomic same-tenant provenance", async () => {
  const pg = await testPostgres(55457);
  await migrate(pg.url);
  const db = new Database(pg.url, { serialize: pg.emulated });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const providerA = randomUUID();
  const providerB = randomUUID();
  const user = randomUUID();
  const issuer = "https://id.example.test/realms/workspace";
  try {
    await db.tenant(tenantA, async (q) => {
      await q.query(
        "INSERT INTO organisations(id,name) VALUES($1,'State tenant A')",
        [tenantA],
      );
      await q.query(
        "INSERT INTO users(id,email,name) VALUES($1,$2,'State test user')",
        [user, user + "@example.test"],
      );
      await q.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        [tenantA, user],
      );
      await q.query(
        "INSERT INTO oidc_tenant_providers" +
          " (id,tenant_id,label,issuer,client_id,token_auth_method,created_by)" +
          " VALUES($1,$2,'Tenant A',$3,$4,'none',$5)",
        [providerA, tenantA, issuer, "workspace-a", user],
      );
    });
    await db.tenant(tenantB, async (q) => {
      await q.query("INSERT INTO organisations(id,name) VALUES($1,'State tenant B')", [tenantB]);
      await q.query(
        "INSERT INTO oidc_tenant_providers" +
          " (id,tenant_id,label,issuer,client_id,token_auth_method)" +
          " VALUES($1,$2,'Tenant B',$3,$4,'none')",
        [providerB, tenantB, issuer, "workspace-b"],
      );
    });
    // Backward-compatible deployment-level state contains no tenant fields.
    await db.system((q) =>
      q.query(
        "INSERT INTO oidc_login_states(state_hash,code_verifier,nonce) VALUES('legacy-state','verifier','nonce')",
      ),
    );
    const legacy = await db.system((q) =>
      one(q, "SELECT tenant_id,provider_id FROM oidc_login_states WHERE state_hash='legacy-state'"),
    );
    assert.equal(legacy.tenant_id, null);
    assert.equal(legacy.provider_id, null);

    const insertState =
      "INSERT INTO oidc_login_states" +
      " (state_hash,code_verifier,nonce,tenant_id,provider_id,provider_revision,expected_issuer,expected_client_id)" +
      " VALUES($1,'pkce','nonce',$2,$3,1,$4,'workspace-a')";
    await db.system((q) =>
      q.query(insertState, ["tenant-state", tenantA, providerA, issuer]),
    );
    await assert.rejects(
      db.system((q) => q.query(
        "INSERT INTO oidc_login_states" +
        " (state_hash,code_verifier,nonce,tenant_id,provider_id)" +
        " VALUES('partial-state','v','n',$1,$2)",
        [tenantA, providerA],
      )),
      /check constraint|oidc_state_provider_fields_atomic/i,
    );
    await assert.rejects(
      db.system((q) =>
        q.query(insertState, ["mixed-provider", tenantA, providerB, issuer]),
      ),
      /foreign key|oidc_state_tenant_provider_fk/i,
    );
    const token = await db.tenant(tenantA, (q) =>
      createSession(q, tenantA, user, null, null, {
        issuer,
        subject: "subject-a",
        sid: "idp-session",
      }),
    );
    await db.tenant(tenantA, (q) => q.query(
      "UPDATE sessions SET oidc_provider_id=$1 WHERE token_hash=$2",
      [providerA, hash(token)],
    ));
    const stored = await db.tenant(tenantA, (q) =>
      one(q, "SELECT oidc_provider_id,oidc_issuer FROM sessions WHERE token_hash=$1", [hash(token)]),
    );
    assert.equal(stored.oidc_provider_id, providerA);
    assert.equal(stored.oidc_issuer, issuer);
    await assert.rejects(
      db.tenant(tenantA, (q) => q.query(
        "UPDATE sessions SET oidc_provider_id=$1 WHERE token_hash=$2",
        [providerB, hash(token)],
      )),
      /foreign key|oidc_session_tenant_provider_fk/i,
    );
    await assert.rejects(
      db.tenant(tenantA, (q) => q.query(
        "UPDATE sessions SET oidc_issuer=NULL WHERE token_hash=$1",
        [hash(token)],
      )),
      /check constraint|oidc_session_provider_provenance/i,
    );
    const legacySession = await db.tenant(tenantA, (q) =>
      createSession(q, tenantA, user),
    );
    assert.equal(
      (await db.tenant(tenantA, (q) =>
        one(q, "SELECT oidc_provider_id FROM sessions WHERE token_hash=$1", [hash(legacySession)]),
      )).oidc_provider_id,
      null,
    );
    await assert.rejects(
      db.tenant(tenantA, (q) => q.query(
        "UPDATE sessions SET oidc_provider_id=$1 WHERE token_hash=$2",
        [providerA, hash(legacySession)],
      )),
      /check constraint|oidc_session_provider_provenance/i,
    );
  } finally {
    await db.close();
    await pg.close();
  }
});
