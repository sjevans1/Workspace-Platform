import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sealTenantOidcSecret,
  openTenantOidcSecret,
  validateTenantOidcRegistration,
} from "../packages/auth/tenant-provider.ts";

test("tenant provider secrets are authenticated and cryptographically tenant-bound", () => {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "c".repeat(64);
  const tenant = randomUUID();
  const anotherTenant = randomUUID();
  const provider = randomUUID();
  const anotherProvider = randomUUID();
  try {
    const sealed = sealTenantOidcSecret("confidential-client-secret", tenant, provider);
    assert.match(sealed, /^oidc-v1\./);
    assert.doesNotMatch(sealed, /confidential-client-secret/);
    assert.equal(
      openTenantOidcSecret(sealed, tenant, provider),
      "confidential-client-secret",
    );
    assert.throws(() => openTenantOidcSecret(sealed, anotherTenant, provider));
    assert.throws(() => openTenantOidcSecret(sealed, tenant, anotherProvider));
    const altered = sealed.split(".");
    altered[3] = (altered[3][0] === "A" ? "B" : "A") + altered[3].slice(1);
    assert.throws(() => openTenantOidcSecret(altered.join("."), tenant, provider));
    assert.throws(() => openTenantOidcSecret("not-an-envelope", tenant, provider));
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
});

test("tenant issuer registration requires explicit approved HTTPS origin", () => {
  const value = {
    label: "Acme",
    issuer: "https://login.example.test/realms/acme",
    clientId: "client",
    clientSecret: "secret-long-enough",
    tokenAuthMethod: "client_secret_basic" as const,
    scopes: ["openid", "profile", "email"],
  };
  const allowed = "https://login.example.test";
  assert.equal(
    validateTenantOidcRegistration(value, allowed),
    value.issuer,
  );
  assert.throws(() => validateTenantOidcRegistration(value, ""), /operator-approved/);
  assert.throws(
    () => validateTenantOidcRegistration({ ...value, issuer: "https://other.example.test/" }, allowed),
    /operator-approved/,
  );
  for (const issuer of [
    "http://login.example.test/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://id.internal.local/",
    "https://someone:password@login.example.test/",
    "https://login.example.test/?issuer=https://other.example.test",
    "https://login.example.test/#fragment",
  ]) {
    assert.throws(
      () => validateTenantOidcRegistration({ ...value, issuer }, allowed),
    );
  }
  assert.throws(
    () => validateTenantOidcRegistration({ ...value, scopes: ["email"] }, allowed),
    /Invalid OIDC scopes/,
  );
  assert.equal(
    validateTenantOidcRegistration({
      ...value,
      tokenAuthMethod: "none",
      clientSecret: undefined,
    }, allowed),
    value.issuer,
  );
  assert.throws(
    () => validateTenantOidcRegistration({ ...value, tokenAuthMethod: "none" }, allowed),
    /client secret and authentication method must agree/,
  );
});
