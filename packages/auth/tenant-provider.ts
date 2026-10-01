import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { isIP } from "node:net";
import { assert } from "../contracts/index.ts";

export type TenantOidcInput = {
  label: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  scopes: string[];
};

function key() {
  const raw = process.env.ENCRYPTION_KEY || "";
  assert(/^[a-f0-9]{64}$/i.test(raw), 500, "Invalid encryption configuration");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(raw, "hex"),
      Buffer.from("openjm-workspace"),
      Buffer.from("tenant-oidc-client-secret-v1"),
      32,
    ),
  );
}

const aad = (tenantId: string, providerId: string) =>
  Buffer.from("openjm-tenant-oidc-secret-v1:" + tenantId + ":" + providerId);

export function sealTenantOidcSecret(
  plain: string,
  tenantId: string,
  providerId: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(tenantId, providerId));
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return [
    "oidc-v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

// Server-internal only. No provider-management endpoint returns this value.
export function openTenantOidcSecret(
  envelope: string,
  tenantId: string,
  providerId: string,
) {
  const parts = envelope.split(".");
  assert(parts.length === 4 && parts[0] === "oidc-v1", 500, "Invalid OIDC secret envelope");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  assert(iv.length === 12 && tag.length === 16, 500, "Invalid OIDC secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(aad(tenantId, providerId));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// This is registration validation only. The T3 sign-in path MUST independently
// constrain DNS, redirects, discovery URLs and JWKS URL destinations before it
// performs network I/O. T2 never fetches an issuer-supplied address.
export function validateTenantOidcRegistration(
  value: TenantOidcInput,
  allowedOrigins = process.env.OIDC_TENANT_ISSUER_ORIGINS || "",
) {
  let issuer: URL;
  try {
    issuer = new URL(value.issuer);
  } catch {
    throw new Error("Invalid OIDC issuer URL");
  }
  assert(
    issuer.protocol === "https:" &&
      !issuer.username &&
      !issuer.password &&
      !issuer.hash &&
      !issuer.search &&
      !isIP(issuer.hostname.replace(/^\[|\]$/g, "")) &&
      issuer.hostname !== "localhost" &&
      !issuer.hostname.endsWith(".localhost") &&
      !issuer.hostname.endsWith(".local"),
    400,
    "OIDC issuer requires an HTTPS hostname without credentials or query",
  );
  const allowlist = allowedOrigins
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  assert(
    allowlist.length > 0 && allowlist.includes(issuer.origin),
    403,
    "OIDC issuer origin is not operator-approved",
  );
  assert(
    value.scopes.includes("openid") &&
      value.scopes.length <= 12 &&
      value.scopes.every((s) => /^[a-zA-Z0-9:._-]{1,80}$/.test(s)) &&
      new Set(value.scopes).size === value.scopes.length,
    400,
    "Invalid OIDC scopes",
  );
  assert(
    value.tokenAuthMethod === "none"
      ? !value.clientSecret
      : Boolean(value.clientSecret),
    400,
    "OIDC client secret and authentication method must agree",
  );
  return issuer.href;
}
