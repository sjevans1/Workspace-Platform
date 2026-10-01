import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testPostgres } from "../scripts/test-postgres.ts";
import { migrate } from "../packages/database/migrate.ts";
import { Database, one } from "../packages/database/index.ts";

test("OIDC state schema binds provider and tenant atomically without changing legacy state", async () => {
  const pg = await testPostgres(55451);
  await migrate(pg.url);
  const db = new Database(pg.url, { serialize: pg.emulated });
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const provider = randomUUID();
  const issuer = "https://idp.example.test/realm";
  const clientId = "registered-oidc-client";
  const makeState = (name: string) => [
    "state-" + name + "-" + randomUUID(),
    "pkce-code-verifier-placeholder",
    "random-nonce-placeholder",
  ];
  const insertSql =
    "INSERT INTO oidc_login_states" +
    " (state_hash,code_verifier,nonce,tenant_id,provider_id,provider_revision,expected_issuer,expected_client_id)" +
    " VALUES($1,$2,$3,$4,$5,$6,$7,$8)";
  try {
    await db.system(async (q) => {
      await q.query("INSERT INTO organisations(id,name) VALUES($1,'Tenant A'),($2,'Tenant B')", [
        tenant,
        otherTenant,
      ]);
    });
    await db.tenant(tenant, (q) =>
      q.query(
        "INSERT INTO oidc_tenant_providers" +
          " (id,tenant_id,label,issuer,client_id,token_auth_method)" +
          " VALUES($1,$2,'Staged IdP',$3,$4,'none')",
        [provider, tenant, issuer, clientId],
      ),
    );

    // Unmodified deployment-level OIDC login state is still supported.
    const legacy = makeState("legacy");
    await db.system((q) =>
      q.query(
        "INSERT INTO oidc_login_states(state_hash,code_verifier,nonce) VALUES($1,$2,$3)",
        legacy,
      ),
    );
    const legacyRow = await db.system((q) =>
      one(q, "SELECT tenant_id,provider_id,provider_revision FROM oidc_login_states WHERE state_hash=$1", [legacy[0]]),
    );
    assert.deepEqual(legacyRow, {
      tenant_id: null,
      provider_id: null,
      provider_revision: null,
    });

    const bound = makeState("bound");
    await db.system((q) =>
      q.query(insertSql, [...bound, tenant, provider, 1, issuer, clientId]),
    );
    const row = await db.system((q) =>
      one(
        q,
        "SELECT tenant_id,provider_id,provider_revision,expected_issuer,expected_client_id FROM oidc_login_states WHERE state_hash=$1",
        [bound[0]],
      ),
    );
    assert.equal(row.tenant_id, tenant);
    assert.equal(row.provider_id, provider);
    assert.equal(row.provider_revision, 1);
    assert.equal(row.expected_issuer, issuer);
    assert.equal(row.expected_client_id, clientId);

    // Omitted provider fields and cross-tenant provider links are rejected.
    for (const fields of [
      [tenant, null, 1, issuer, clientId],
      [tenant, provider, null, issuer, clientId],
      [tenant, provider, 1, null, clientId],
      [tenant, provider, 1, issuer, null],
      [tenant, provider, 0, issuer, clientId],
      [tenant, provider, 1, "", clientId],
      [null, null, null, issuer, null],
    ]) {
      await assert.rejects(
        db.system((q) => q.query(insertSql, [...makeState("partial"), ...fields])),
        /oidc_state_complete_provider_binding|check constraint/i,
      );
    }
    await assert.rejects(
      db.system((q) =>
        q.query(insertSql, [...makeState("cross"), otherTenant, provider, 1, issuer, clientId]),
      ),
      /oidc_state_provider_tenant_fk|foreign key/i,
    );
    await assert.rejects(
      db.system((q) =>
        q.query(insertSql, [...makeState("unknown"), tenant, randomUUID(), 1, issuer, clientId]),
      ),
      /oidc_state_provider_tenant_fk|foreign key/i,
    );

    // Exactly one request consumes a state even if a replay retries it.
    const consume = () =>
      db.system((q) =>
        one(
          q,
          "DELETE FROM oidc_login_states WHERE state_hash=$1 AND expires_at>now() RETURNING provider_id,tenant_id",
          [bound[0]],
        ),
      );
    const first = await consume();
    assert.equal(first.provider_id, provider);
    assert.equal(first.tenant_id, tenant);
    assert.equal(await consume(), undefined);

    const expired = makeState("expired");
    await db.system((q) =>
      q.query(
        "INSERT INTO oidc_login_states(state_hash,code_verifier,nonce,expires_at) VALUES($1,$2,$3,now()-interval '1 minute')",
        expired,
      ),
    );
    assert.equal(
      await db.system((q) =>
        one(
          q,
          "DELETE FROM oidc_login_states WHERE state_hash=$1 AND expires_at>now() RETURNING state_hash",
          [expired[0]],
        ),
      ),
      undefined,
    );
  } finally {
    await db.close();
    await pg.close();
  }
});
