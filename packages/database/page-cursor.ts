import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../contracts/index.ts";

const prefix = "db-page-v1";
const aad = Buffer.from("openjm-workspace-database-page-cursor-v1");
const lifetime = 1800;
const schema = z.object({
  v: z.literal(1),
  tenant: z.uuid(),
  principal: z.uuid(),
  database: z.uuid(),
  view: z.uuid().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  limit: z.number().int().min(1).max(200),
  position: z.number().finite(),
  after: z.uuid(),
  issued: z.number().int().nonnegative(),
  expires: z.number().int().positive(),
}).strict();
export type DatabasePageCursor = z.infer<typeof schema>;

export function databasePageFingerprint(config: unknown, month?: string) {
  // Only server-validated view configs reach this function, never arbitrary
  // executable user input. A changed saved view/month invalidates old cursors.
  return createHash("sha256")
    .update(JSON.stringify({ config, month: month || null }))
    .digest("hex");
}

function secret() {
  const key = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw Error("ENCRYPTION_KEY must be configured");
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(key, "hex"), Buffer.from("openjm-workspace"),
    Buffer.from("database-page-cursor-v1"), 32,
  ));
}

export function newDatabasePageCursor(
  tenant: string, principal: string, database: string, view: string | null,
  fingerprint: string, limit: number, position: number, after: string,
  now = Math.floor(Date.now() / 1000),
): DatabasePageCursor {
  return schema.parse({
    v: 1, tenant, principal, database, view, fingerprint, limit,
    position, after, issued: now, expires: now + lifetime,
  });
}

export function encodeDatabasePageCursor(value: DatabasePageCursor) {
  const state = schema.parse(value);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret(), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"), cipher.final(),
  ]);
  return prefix + "." + Buffer.concat([
    nonce, cipher.getAuthTag(), ciphertext,
  ]).toString("base64url");
}

export function decodeDatabasePageCursor(
  value: string, context: {
    tenant: string; principal: string; database: string; view: string | null;
    fingerprint: string; limit: number;
  }, now = Math.floor(Date.now() / 1000),
): DatabasePageCursor {
  try {
    if (typeof value !== "string" || value.length < 50 ||
        value.length > 2048 || !value.startsWith(prefix + "."))
      throw Error("Bad cursor");
    const payload = value.slice(prefix.length + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw Error("Invalid encoding");
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.length < 29 || bytes.length > 1024 ||
        bytes.toString("base64url") !== payload)
      throw Error("Invalid payload");
    const decipher = createDecipheriv(
      "aes-256-gcm", secret(), bytes.subarray(0, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const state = schema.parse(JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final(),
    ]).toString("utf8")));
    if (state.tenant !== context.tenant ||
        state.principal !== context.principal ||
        state.database !== context.database ||
        state.view !== context.view ||
        state.fingerprint !== context.fingerprint ||
        state.limit !== context.limit ||
        state.issued > now + 30 || state.expires <= now ||
        state.expires - state.issued !== lifetime)
      throw Error("Scope or expiry");
    return state;
  } catch {
    throw new HttpError(400, "Invalid database page cursor");
  }
}
