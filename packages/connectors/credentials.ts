/**
 * W29-A: the connector credential envelope.
 *
 * Connector credentials are server-side secrets. They are stored with the SAME
 * Workspace encryption primitive the rest of the product already uses (AES-256-GCM
 * under the deployment's `ENCRYPTION_KEY`, with the existing base64url
 * `iv.tag.ciphertext` envelope), strengthened with an additional-authenticated-data
 * binding to `tenant:connection:kind`. That binding is what makes a ciphertext
 * unusable if it is moved to another tenant, connection or credential kind, so a
 * copy-paste mistake or a cross-tenant lookup cannot open someone else's secret.
 *
 * Two strictly separated halves:
 *  - `secret_encrypted`: ciphertext only. Never returned to a client, never logged,
 *    never audited, never placed in a support bundle.
 *  - `metadata`: non-secret descriptors only, through an allowlist, so support and
 *    status surfaces can describe a credential without ever carrying its value.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { assert } from "../contracts/index.ts";
import type { Query } from "../database/index.ts";
import { one } from "../database/index.ts";
import type { CredentialKind } from "./registry.ts";
import { CREDENTIAL_KINDS } from "./registry.ts";

function key(): Buffer {
  const value = process.env.ENCRYPTION_KEY || "";
  assert(
    /^[a-f0-9]{64}$/i.test(value),
    500,
    "ENCRYPTION_KEY must be 64 hexadecimal characters",
  );
  return Buffer.from(value, "hex");
}

/** The AAD binds a credential ciphertext to exactly one tenant, connection and kind. */
export function credentialAad(tenant: string, connection: string, kind: CredentialKind): string {
  assert(UUID.test(tenant) && UUID.test(connection), 500, "Credential scope must be identified");
  return `${tenant}:${connection}:${kind}:v1`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sealCredential(aad: string, secret: string): string {
  assert(typeof secret === "string" && secret.length > 0 && secret.length <= 16384, 400, "Credential material is required");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function openCredential(aad: string, envelope: string): string {
  assert(typeof envelope === "string" && envelope.split(".").length === 3, 500, "Credential envelope is malformed");
  const [iv, tag, data] = envelope.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** An irreversible digest of an ingress token; safe to hold in non-secret metadata. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(`connector-ingress:${token}`).digest("hex");
}

/**
 * The only metadata keys that may be persisted or surfaced. Everything else — a
 * raw token, a refresh token, an authorization header — is dropped rather than
 * stored, so a future adapter cannot accidentally widen the secret surface.
 */
export const CREDENTIAL_METADATA_KEYS = [
  "token_digest",
  "scopes",
  "expires_at",
  "algorithm",
  "key_id",
  "label",
  "chat_id",
  "account_hint",
] as const;

export type CredentialMetadata = Partial<
  Record<(typeof CREDENTIAL_METADATA_KEYS)[number], string | string[]>
>;

export function sanitizeCredentialMetadata(value: unknown): CredentialMetadata {
  const input = (value ?? {}) as Record<string, unknown>;
  const output: CredentialMetadata = {};
  for (const key of CREDENTIAL_METADATA_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      output[key] = raw.filter((item) => typeof item === "string").slice(0, 32) as string[];
      continue;
    }
    if (typeof raw === "string") output[key] = raw.slice(0, 512);
  }
  return output;
}

export type CredentialRecord = {
  id: string;
  kind: CredentialKind;
  key_version: number;
  metadata: CredentialMetadata;
  created_at: Date;
  updated_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
};

export function publicCredential(row: any): CredentialRecord {
  return {
    id: row.id,
    kind: row.kind,
    key_version: row.key_version,
    metadata: sanitizeCredentialMetadata(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    rotated_at: row.rotated_at,
    revoked_at: row.revoked_at,
  };
}

/**
 * Stores a credential, rotating any active predecessor of the same kind. The
 * replacement is inserted BEFORE the predecessor is revoked inside the caller's
 * transaction, so an interrupted rotation can never leave the connection without
 * usable material.
 */
export async function putCredential(
  q: Query,
  tenant: string,
  connection: string,
  kind: CredentialKind,
  secret: string,
  metadata: CredentialMetadata = {},
): Promise<CredentialRecord> {
  assert(CREDENTIAL_KINDS.includes(kind), 400, `Unknown credential kind: ${kind}`);
  const aad = credentialAad(tenant, connection, kind);
  const previous = await one(
    q,
    "SELECT id FROM connector_credentials WHERE tenant_id=$1 AND connection_id=$2 AND kind=$3 AND revoked_at IS NULL",
    [tenant, connection, kind],
  );
  const nextVersion = Number(
    (
      await one(
        q,
        "SELECT COALESCE(MAX(key_version),0)+1 AS next FROM connector_credentials WHERE tenant_id=$1 AND connection_id=$2 AND kind=$3",
        [tenant, connection, kind],
      )
    )?.next || 1,
  );
  const id = randomUUID();
  // Rotate by REVOKING the predecessor first, then inserting the replacement, both
  // inside the caller's transaction. The reverse order cannot work: the partial
  // unique index `connector_credentials_active` allows one active credential per
  // (connection, kind), so inserting while the predecessor is still active is
  // rejected, and an operator's token rotation would always fail. Because the two
  // statements share a transaction, the connection is never left without usable
  // material by an interrupted rotation: either both land or neither does.
  if (previous)
    await q.query(
      "UPDATE connector_credentials SET revoked_at=now(),updated_at=now() WHERE id=$1",
      [previous.id],
    );
  await q.query(
    "INSERT INTO connector_credentials(id,tenant_id,connection_id,kind,secret_encrypted,metadata,key_version,rotated_at)" +
      " VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      tenant,
      connection,
      kind,
      sealCredential(aad, secret),
      JSON.stringify(sanitizeCredentialMetadata(metadata)),
      nextVersion,
      previous ? new Date() : null,
    ],
  );
  const stored = await one(q, "SELECT * FROM connector_credentials WHERE id=$1", [id]);
  return publicCredential(stored);
}

/** Reads and decrypts the ACTIVE credential of one kind, or null. */
export async function readCredential(
  q: Query,
  tenant: string,
  connection: string,
  kind: CredentialKind,
): Promise<{ id: string; secret: string; key_version: number } | null> {
  const row = await one(
    q,
    "SELECT id,secret_encrypted,key_version FROM connector_credentials" +
      " WHERE tenant_id=$1 AND connection_id=$2 AND kind=$3 AND revoked_at IS NULL",
    [tenant, connection, kind],
  );
  if (!row) return null;
  return {
    id: row.id,
    secret: openCredential(credentialAad(tenant, connection, kind), row.secret_encrypted),
    key_version: Number(row.key_version),
  };
}

/** Revokes every credential of a connection. Returns the number revoked. */
export async function revokeCredentials(
  q: Query,
  tenant: string,
  connection: string,
): Promise<number> {
  const result = await q.query(
    "UPDATE connector_credentials SET revoked_at=now(),updated_at=now()" +
      " WHERE tenant_id=$1 AND connection_id=$2 AND revoked_at IS NULL",
    [tenant, connection],
  );
  return result.rowCount || 0;
}

export async function credentialsFor(
  q: Query,
  tenant: string,
  connection: string,
): Promise<CredentialRecord[]> {
  return (
    await q.query(
      "SELECT * FROM connector_credentials WHERE tenant_id=$1 AND connection_id=$2" +
        " ORDER BY kind,created_at DESC,id",
      [tenant, connection],
    )
  ).rows.map(publicCredential);
}

/**
 * Adversarial guard used by the acceptance suite and by the status projection: no
 * value that could be secret material may appear in a serialized structure.
 */
export function assertNoSecretMaterial(serialized: string): void {
  assert(
    !/secret_encrypted|client_secret"|refresh_token|access_token|bot_token"|api_key"|-----BEGIN/.test(
      serialized,
    ),
    500,
    "Secret material reached a non-secret surface",
  );
}
