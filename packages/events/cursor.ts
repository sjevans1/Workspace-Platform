import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../contracts/index.ts";

// Opaque-to-client, authenticated continuation state. It is scoped to one
// tenant and principal; each returned event is independently ACL-checked.
const stateSchema = z.object({
  v: z.literal(1),
  tenant: z.uuid(),
  principal: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
}).strict();
export type EventCursor = z.infer<typeof stateSchema>;
const prefix = "event-v1";
const earliest = "1970-01-01T00:00:00.000Z";
const zeroId = "00000000-0000-0000-0000-000000000000";

function signingKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw))
    throw new Error("ENCRYPTION_KEY must be configured");
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(raw, "hex"),
    Buffer.from("openjm-workspace"),
    Buffer.from("integration-event-cursor-v1"),
    32,
  ));
}

function signature(payload: string) {
  return createHmac("sha256", signingKey())
    .update(prefix + "." + payload)
    .digest();
}

export function beginEventCursor(
  tenant: string,
  principal: string,
  since?: string,
): EventCursor {
  if (since && (!z.iso.datetime({ offset: true }).safeParse(since).success || since.length > 60))
    throw new HttpError(400, "Invalid event start time");
  return stateSchema.parse({
    v: 1,
    tenant,
    principal,
    at: since ? new Date(since).toISOString() : earliest,
    id: zeroId,
  });
}

export function encodeEventCursor(value: EventCursor) {
  const body = Buffer.from(JSON.stringify(stateSchema.parse(value))).toString("base64url");
  return [prefix, body, signature(body).toString("base64url")].join(".");
}

export function decodeEventCursor(
  token: string,
  tenant: string,
  principal: string,
): EventCursor {
  try {
    if (typeof token !== "string" || token.length > 2048)
      throw Error("Invalid length");
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== prefix)
      throw Error("Invalid version");
    const supplied = Buffer.from(parts[2], "base64url"),
      expected = signature(parts[1]);
    if (supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected))
      throw Error("Invalid signature");
    const decoded = stateSchema.parse(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
    if (decoded.tenant !== tenant || decoded.principal !== principal)
      throw Error("Wrong cursor principal");
    if (Number.isNaN(Date.parse(decoded.at)))
      throw Error("Invalid datetime");
    return decoded;
  } catch {
    throw new HttpError(400, "Invalid event cursor");
  }
}
