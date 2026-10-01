import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../contracts/index.ts";

// Resource scan positions may refer to resources that the caller cannot
// access. Encrypt the entire cursor, rather than signing readable base64,
// to avoid disclosing those IDs in opaque pagination handles.
const prefix = "reconcile-v1";
const aad = Buffer.from("openjm-workspace-resource-reconciliation-v1");
const zero = "00000000-0000-0000-0000-000000000000";
const stateSchema = z.object({
  v: z.literal(1),
  tenant: z.uuid(),
  principal: z.uuid(),
  after: z.uuid(),
  scan: z.uuid(),
  issued: z.number().int().nonnegative(),
  expires: z.number().int().positive(),
}).strict();
export type ReconcileCursor = z.infer<typeof stateSchema>;

function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw Error("ENCRYPTION_KEY must be configured");
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(raw, "hex"), Buffer.from("openjm-workspace"),
    Buffer.from("resource-reconciliation-cursor-v1"), 32,
  ));
}

export function beginReconcileCursor(
  tenant: string, principal: string, now = Math.floor(Date.now() / 1000),
): ReconcileCursor {
  return stateSchema.parse({
    v: 1, tenant, principal, after: zero, scan: randomUUID(),
    issued: now, expires: now + 3600,
  });
}

export function encodeReconcileCursor(value: ReconcileCursor): string {
  const state = stateSchema.parse(value);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(aad);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"), cipher.final(),
  ]);
  return prefix + "." + Buffer.concat([nonce, cipher.getAuthTag(), payload])
    .toString("base64url");
}

export function decodeReconcileCursor(
  value: string, tenant: string, principal: string,
  now = Math.floor(Date.now() / 1000),
): ReconcileCursor {
  try {
    if (typeof value !== "string" || value.length > 2048 ||
        !value.startsWith(prefix + ".")) throw Error("Invalid cursor");
    const bytes = Buffer.from(value.slice(prefix.length + 1), "base64url");
    if (bytes.length < 29 || bytes.length > 1024) throw Error("Invalid size");
    const decipher = createDecipheriv(
      "aes-256-gcm", encryptionKey(), bytes.subarray(0, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const state = stateSchema.parse(JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final(),
    ]).toString("utf8")));
    if (state.tenant !== tenant || state.principal !== principal ||
        state.issued > now + 30 || state.expires <= now ||
        state.expires - state.issued !== 3600)
      throw Error("Wrong caller or expired scan");
    return state;
  } catch {
    throw new HttpError(400, "Invalid reconciliation cursor");
  }
}
