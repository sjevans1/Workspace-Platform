import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
import type { Query } from "../database/index.ts";
import type { Actor } from "../auth/index.ts";
export async function emit(
  q: Query,
  a: Actor,
  type: string,
  id: string | null,
  version = 1,
) {
  await q.query(
    "INSERT INTO event_outbox(id,tenant_id,actor_id,type,resource_id,version) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), a.tenant_id, a.user_id, type, id, version],
  );
  await q.query(
    "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id,request_id) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), a.tenant_id, a.user_id, type, id, a.requestId || null],
  );
}
function key() {
  const k = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(k))
    throw new Error("ENCRYPTION_KEY must be 64 hex characters");
  return Buffer.from(k, "hex");
}
export function encrypt(v: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key(), iv),
    data = Buffer.concat([c.update(v), c.final()]);
  return [iv, c.getAuthTag(), data]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function decrypt(v: string) {
  const [iv, tag, data] = v.split(".").map((v) => Buffer.from(v, "base64url"));
  const c = createDecipheriv("aes-256-gcm", key(), iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(data), c.final()]).toString();
}
export const signature = (secret: string, time: string, body: string) =>
  createHmac("sha256", secret).update(`${time}.${body}`).digest("hex");
