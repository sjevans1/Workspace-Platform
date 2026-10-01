import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database, one, type Query } from "../packages/database/index.ts";
import { passwordHash, type Actor } from "../packages/auth/index.ts";
import { title } from "../packages/contracts/index.ts";
import { createResource, seedDemo } from "../apps/api/src/domain.ts";

export type ProvisionTenantInput = {
  organisation: string;
  workspace: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword?: string;
  allowExistingUser?: boolean;
  passwordlessOwner?: boolean;
  demo?: boolean;
};

export type ProvisionTenantResult = {
  tenant_id: string;
  workspace_id: string;
  owner_user_id: string;
  owner_mode: "existing-user" | "local-password" | "passwordless-sso";
};

function email(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new Error("Owner email is invalid");
  return normalized;
}

export async function provisionTenant(
  db: Database,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const organisation = title.parse(input.organisation),
    workspace = title.parse(input.workspace),
    ownerName = title.parse(input.ownerName),
    ownerEmail = email(input.ownerEmail);

  if (input.ownerPassword && input.passwordlessOwner)
    throw new Error("Choose either an owner password or passwordless SSO, not both");

  const encoded = input.ownerPassword
    ? await passwordHash(input.ownerPassword)
    : undefined;

  return db.systemTransaction(async (q: Query) => {
    await q.query("SELECT pg_advisory_xact_lock(8831243)");

    const duplicate = await one(
      q,
      "SELECT id FROM organisations WHERE lower(name)=lower($1) LIMIT 1",
      [organisation],
    );
    if (duplicate)
      throw new Error("An organisation with this name already exists");

    let user = await one(
      q,
      "SELECT id,email,password_hash,is_service FROM users WHERE email=$1",
      [ownerEmail],
    );
    const existingUser = !!user;

    if (user) {
      if (user.is_service)
        throw new Error("A service principal cannot be the tenant owner");
      if (!input.allowExistingUser)
        throw new Error(
          "Owner email already exists; rerun with --allow-existing-user only after verifying the account",
        );
      if (input.ownerPassword)
        throw new Error(
          "Do not supply an owner password when reusing an existing user; provisioning never changes existing credentials",
        );
    } else {
      if (!encoded && !input.passwordlessOwner)
        throw new Error(
          "New owners require WORKSPACE_PROVISION_OWNER_PASSWORD or --passwordless-owner for verified-email SSO",
        );
      user = { id: randomUUID(), email: ownerEmail };
      await q.query(
        "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [user.id, ownerEmail, ownerName, encoded || null],
      );
    }

    const tenant = randomUUID();
    await q.query("SET LOCAL ROLE workspace_app");
    await q.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await q.query("INSERT INTO organisations(id,name) VALUES($1,$2)", [
      tenant,
      organisation,
    ]);
    await q.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
      [tenant, user.id],
    );

    const actor: Actor = {
      tenant_id: tenant,
      user_id: user.id,
      role: "owner",
      name: ownerName,
      email: ownerEmail,
      scopes: null,
      expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000),
      requestId: "operator-provisioning",
    };
    const root = await createResource(q, actor, {
      kind: "workspace",
      title: workspace,
    });
    if (input.demo) await seedDemo(q, actor, root.id);
    await q.query(
      "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id,request_id) VALUES($1,$2,$3,'tenant.provisioned',$4,'operator-provisioning')",
      [randomUUID(), tenant, user.id, root.id],
    );

    return {
      tenant_id: tenant,
      workspace_id: root.id,
      owner_user_id: user.id,
      owner_mode: existingUser
        ? "existing-user"
        : encoded
          ? "local-password"
          : "passwordless-sso",
    };
  });
}

function args(values: string[]) {
  const result = new Map<string, string | true>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (["allow-existing-user", "passwordless-owner", "demo"].includes(key)) {
      result.set(key, true);
      continue;
    }
    const next = values[++i];
    if (!next || next.startsWith("--"))
      throw new Error(`Missing value for --${key}`);
    result.set(key, next);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      "MIGRATION_DATABASE_URL is required; tenant provisioning must use the deployment owner database credential",
    );
  const a = args(process.argv.slice(2));
  const required = (name: string) => {
    const value = a.get(name);
    if (typeof value !== "string" || !value.trim())
      throw new Error(`--${name} is required`);
    return value;
  };
  const db = new Database(url);
  try {
    const result = await provisionTenant(db, {
      organisation: required("organisation"),
      workspace: required("workspace"),
      ownerName: required("owner-name"),
      ownerEmail: required("owner-email"),
      ownerPassword: process.env.WORKSPACE_PROVISION_OWNER_PASSWORD,
      allowExistingUser: a.get("allow-existing-user") === true,
      passwordlessOwner: a.get("passwordless-owner") === true,
      demo: a.get("demo") === true,
    });
    console.log(
      JSON.stringify(
        {
          result: "PASS",
          ...result,
          note:
            result.owner_mode === "passwordless-sso"
              ? "Owner account has no local password; verified-email OIDC/SSO must be configured."
              : result.owner_mode === "existing-user"
                ? "Existing global user credentials were preserved."
                : "Local owner password was read from WORKSPACE_PROVISION_OWNER_PASSWORD and was not printed.",
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}
