import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { HttpError } from "../contracts/index.ts";

const pagePrefix = "backlink-page-v1";
const pageAad = Buffer.from("openjm-workspace-backlink-page-v1");
const reconcilePrefix = "link-reconcile-v1";
const reconcileAad = Buffer.from("openjm-workspace-resource-link-reconcile-v1");
const pageLifetime = 1800;
const reconcileLifetime = 3600;
const zeroId = "00000000-0000-0000-0000-000000000000";

const pageSchema = z.object({
  v: z.literal(1),
  tenant: z.uuid(),
  principal: z.uuid(),
  target: z.uuid(),
  limit: z.number().int().min(1).max(40),
  after_at: z.iso.datetime({ offset: true }),
  after: z.uuid(),
  issued: z.number().int().nonnegative(),
  expires: z.number().int().positive(),
}).strict();
export type BacklinkPageCursor = z.infer<typeof pageSchema>;

const reconcileSchema = z.object({
  v: z.literal(1),
  tenant: z.uuid(),
  principal: z.uuid(),
  after: z.uuid(),
  issued: z.number().int().nonnegative(),
  expires: z.number().int().positive(),
}).strict();
export type LinkReconcileCursor = z.infer<typeof reconcileSchema>;

function key(info: string): Buffer {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw new Error("ENCRYPTION_KEY must be configured");
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(raw, "hex"),
    Buffer.from("openjm-workspace"),
    Buffer.from(info),
    32,
  ));
}

function seal(prefix: string, aad: Buffer, info: string, value: unknown) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(info), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return prefix + "." + Buffer.concat([
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url");
}

function open(
  token: string,
  prefix: string,
  aad: Buffer,
  info: string,
): unknown {
  if (typeof token !== "string" || token.length < 50 || token.length > 2048 ||
      !token.startsWith(prefix + "."))
    throw new Error("Invalid cursor");
  const payload = token.slice(prefix.length + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error("Invalid encoding");
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.length < 29 || bytes.length > 1024 ||
      bytes.toString("base64url") !== payload)
    throw new Error("Invalid payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(info),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8"));
}

export function newBacklinkPageCursor(
  tenant: string,
  principal: string,
  target: string,
  limit: number,
  afterAt: string,
  after: string,
  now = Math.floor(Date.now() / 1000),
): BacklinkPageCursor {
  return pageSchema.parse({
    v: 1,
    tenant,
    principal,
    target,
    limit,
    after_at: afterAt,
    after,
    issued: now,
    expires: now + pageLifetime,
  });
}

export function encodeBacklinkPageCursor(value: BacklinkPageCursor): string {
  return seal(
    pagePrefix,
    pageAad,
    "backlink-page-cursor-v1",
    pageSchema.parse(value),
  );
}

export function decodeBacklinkPageCursor(
  value: string,
  context: {
    tenant: string;
    principal: string;
    target: string;
    limit: number;
  },
  now = Math.floor(Date.now() / 1000),
): BacklinkPageCursor {
  try {
    const state = pageSchema.parse(open(
      value,
      pagePrefix,
      pageAad,
      "backlink-page-cursor-v1",
    ));
    if (state.tenant !== context.tenant ||
        state.principal !== context.principal ||
        state.target !== context.target ||
        state.limit !== context.limit ||
        state.issued > now + 30 ||
        state.expires <= now ||
        state.expires - state.issued !== pageLifetime)
      throw new Error("Wrong scope or expiry");
    return state;
  } catch {
    throw new HttpError(400, "Invalid backlink cursor");
  }
}

export function beginLinkReconcileCursor(
  tenant: string,
  principal: string,
  now = Math.floor(Date.now() / 1000),
): LinkReconcileCursor {
  return reconcileSchema.parse({
    v: 1,
    tenant,
    principal,
    after: zeroId,
    issued: now,
    expires: now + reconcileLifetime,
  });
}

export function encodeLinkReconcileCursor(value: LinkReconcileCursor): string {
  return seal(
    reconcilePrefix,
    reconcileAad,
    "resource-link-reconcile-cursor-v1",
    reconcileSchema.parse(value),
  );
}

export function decodeLinkReconcileCursor(
  value: string,
  tenant: string,
  principal: string,
  now = Math.floor(Date.now() / 1000),
): LinkReconcileCursor {
  try {
    const state = reconcileSchema.parse(open(
      value,
      reconcilePrefix,
      reconcileAad,
      "resource-link-reconcile-cursor-v1",
    ));
    if (state.tenant !== tenant ||
        state.principal !== principal ||
        state.issued > now + 30 ||
        state.expires <= now ||
        state.expires - state.issued !== reconcileLifetime)
      throw new Error("Wrong scope or expiry");
    return state;
  } catch {
    throw new HttpError(400, "Invalid resource-link reconciliation cursor");
  }
}
