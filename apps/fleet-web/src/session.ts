// OCP-2B: bootstrap operator session for the fleet console.
//
// The accepted OCP-2A API authenticates operators with a shared bootstrap bearer
// credential. That credential must never reach the browser, so the console verifies it
// server-side and then issues its own opaque signed session cookie. The cookie contains
// a random session id and an expiry, and NOTHING else: no fleet token, no credential
// material. Because the console ships no client-side JavaScript, the token also cannot
// appear in a browser bundle.
//
// Invalidation semantics, stated exactly: the cookie is a signed payload of a random session
// id and an expiry. Rotating FLEET_OPERATOR_TOKEN stops future sign-ins with the old bootstrap
// credential but does NOT invalidate an already-issued cookie, because the token is only used
// during login verification. Rotating FLEET_CONSOLE_SESSION_SECRET invalidates every existing
// cookie at once, since the signature no longer verifies. Otherwise a stolen cookie stays
// usable until its TTL expires. This is a deliberately minimal bootstrap mechanism. Individual OpenJM operator
// identity, per-operator authorisation and session storage are W27 hardening items.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const FLEET_SESSION_COOKIE = "fleet_console_session";

export type SessionRecord = { sid: string; exp: number };

const b64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function issueSession(secret: string, ttlMs: number, now: number = Date.now()): { cookieValue: string; record: SessionRecord } {
  const record: SessionRecord = { sid: randomUUID(), exp: now + ttlMs };
  const payload = b64url(JSON.stringify(record));
  return { cookieValue: `${payload}.${sign(payload, secret)}`, record };
}

// Verifies signature, shape and expiry. Returns null for anything that is not a valid
// live session, so a tampered or expired cookie is simply unauthenticated.
export function readSession(cookieValue: string | undefined, secret: string, now: number = Date.now()): SessionRecord | null {
  if (!cookieValue) return null;
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = cookieValue.slice(0, separator);
  const provided = cookieValue.slice(separator + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let record: any;
  try {
    record = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof record?.sid !== "string" || !record.sid) return null;
  // A session record never carries the fleet credential; if one somehow appeared, the
  // session is refused rather than trusted.
  if (record.token !== undefined || record.secret !== undefined) return null;
  if (typeof record.exp !== "number" || !Number.isFinite(record.exp)) return null;
  if (record.exp <= now) return null;
  return { sid: record.sid, exp: record.exp };
}

export function sessionCookieOptions(config: { secureCookie: boolean; sessionTtlMs: number }) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: config.secureCookie,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  };
}

// Exposed for the isolation test: asserts that a value carries no fleet credential.
export function containsOperatorToken(text: string, operatorToken: string): boolean {
  if (!operatorToken) return false;
  return text.includes(operatorToken);
}
