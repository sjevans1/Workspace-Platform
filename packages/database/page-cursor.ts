import {
  createCipheriv, createDecipheriv, hkdfSync, randomBytes,
} from "node:crypto";
import { z } from "zod";
import { HttpError } from "../contracts/index.ts";

// Store positions *and* IDs inside AES-GCM, not signed readable base64.
// This is a bounded continuation, NOT a long-lived database snapshot.
const prefix = "db-page-v1";
const aad = Buffer.from("workspace-db-keyset-page-v1");
const schema = z.object({
  v: z.literal(1),
  tenant: z.uuid(),
  principal: z.uuid(),
  database: z.uuid(),
  role: z.enum(["owner", "admin", "member", "guest"]),
  scope: z.literal("default-position"),
  limit: z.number().int().min(1).max(200),
  after_pos: z.number().finite().nullable(),
  after_id: z.uuid().nullable(),
  issued: z.number().int().nonnegative(),
  expires: z.number().int().positive(),
}).strict().refine(s => (s.after_pos === null) === (s.after_id === null));
export type DatabasePageCursor = z.infer<typeof schema>;

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw Error("ENCRYPTION_KEY required");
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(raw, "hex"), Buffer.from("openjm-workspace"),
    Buffer.from("database-keyset-page-v1"), 32,
  ));
}

export function beginDatabasePage(
  tenant: string, principal: string, database: string,
  role: DatabasePageCursor["role"], limit: number,
  now = Math.floor(Date.now() / 1000),
): DatabasePageCursor {
  return schema.parse({
    v: 1, tenant, principal, database, role, scope: "default-position",
    limit, after_pos: null, after_id: null,
    issued: now, expires: now + 900,
  });
}

export function encodeDatabasePage(value: DatabasePageCursor): string {
  const state = schema.parse(value);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"), cipher.final(),
  ]);
  return prefix + "." +
    Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
}

export function decodeDatabasePage(
  token: string, tenant: string, principal: string, database: string,
  role: DatabasePageCursor["role"],
  now = Math.floor(Date.now() / 1000),
): DatabasePageCursor {
  try {
    if (typeof token !== "string" || token.length > 2048 ||
      !token.startsWith(prefix + ".")) throw Error("Invalid cursor");
    const bytes = Buffer.from(token.slice(prefix.length + 1), "base64url");
    if (bytes.length < 29 || bytes.length > 1024) throw Error("Invalid size");
    const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const state = schema.parse(JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final(),
    ]).toString("utf8")));
    if (state.tenant !== tenant || state.principal !== principal ||
      state.database !== database || state.role !== role ||
      state.issued > now + 30 || state.expires <= now ||
      state.expires - state.issued !== 900)
      throw Error("Expired/wrong caller");
    return state;
  } catch {
    throw new HttpError(400, "Invalid database pagination cursor");
  }
}
