// W27 B2: bounded abuse protection for the separate fleet security plane.
//
// Deliberately self-contained: it shares no state with the customer Workspace, uses no
// distributed infrastructure, and never puts a credential, token or signature into a key,
// a log or an error. The limiter is per-process. For the supported 1.0 topology (an
// OpenJM-controlled operator plane, usually one fleet replica behind a trusted reverse
// proxy) that is an accepted and documented boundary rather than a claim of global
// enforcement: with N replicas the effective budget is up to N times the configured limit.
// A shared primitive would need distributed state, which this package deliberately does not
// introduce for rate limiting alone.

import { normalizedNetworkIdentity } from "./rate-network.ts";

export type RateLimitRule = { limit: number; windowMs: number };

export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };

export type RateLimitPolicy = {
  // There is deliberately no production-facing switch that disables abuse protection: it is
  // part of the release security boundary. Limits and windows remain tunable within bounds.
  // Tests exercise the limiter and rules directly instead of turning the control off.
  // The socket peer is the default identity. A proxy header is honoured ONLY when an
  // operator explicitly names it, because X-Forwarded-For and friends are client-controlled.
  trustedClientIpHeader: string | null;
  maxKeys: number;
  // The effective budgets. They are configurable so an operator can tune them, but every
  // value is clamped to a safe range so a misconfiguration cannot disable protection.
  rules: Record<keyof typeof FLEET_RATE_LIMIT_RULES, RateLimitRule>;
};

export const FLEET_RATE_LIMIT_RULES = {
  // Operator authentication failures get the strictest budget, and are tracked per client
  // and in one generous global bucket so that a hostile client cannot starve legitimate
  // operators while still bounding a distributed guessing attempt.
  operatorAuthFailure: { limit: 10, windowMs: 300_000 } satisfies RateLimitRule,
  operatorAuthFailureGlobal: { limit: 200, windowMs: 300_000 } satisfies RateLimitRule,
  // Authenticated reads are cheap and legitimate traffic is bursty, so this is generous.
  operatorRead: { limit: 600, windowMs: 60_000 } satisfies RateLimitRule,
  // Security-sensitive lifecycle mutations are comparatively rare.
  operatorMutation: { limit: 60, windowMs: 60_000 } satisfies RateLimitRule,
  // Telemetry ingestion is machine traffic. The key is the client peer, never a value from
  // the envelope, because envelope fields are attacker-controlled until they verify.
  ingestion: { limit: 1_200, windowMs: 60_000 } satisfies RateLimitRule,
  // Fleet console sign-in attempts.
  consoleLoginFailure: { limit: 5, windowMs: 300_000 } satisfies RateLimitRule,
  consoleLogin: { limit: 30, windowMs: 300_000 } satisfies RateLimitRule,
} as const;

// Fixed-window counters with a bounded key space: the oldest-window key is evicted when the
// map is full, so a flood of distinct keys cannot grow memory without limit.
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxKeys: number = 10_000) {}

  check(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.store(key, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count >= rule.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // Only used by tests and recovery paths; a window that has elapsed self-heals.
  forget(key: string): void {
    this.buckets.delete(key);
  }

  size(): number {
    return this.buckets.size;
  }

  private store(key: string, value: { count: number; resetAt: number }): void {
    if (this.buckets.size >= this.maxKeys) {
      let oldestKey: string | null = null;
      let oldestReset = Number.POSITIVE_INFINITY;
      for (const [candidate, bucket] of this.buckets) {
        if (bucket.resetAt < oldestReset) {
          oldestReset = bucket.resetAt;
          oldestKey = candidate;
        }
      }
      if (oldestKey !== null) this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, value);
  }
}

// Client attribution. Without an explicitly configured trusted proxy header the socket peer
// is used, so spoofed forwarding headers change nothing. With one configured, the last
// comma-separated hop is used, because that is the value the trusted proxy appended, and a
// value that is not a plausible address falls back to the socket peer. No header value is
// ever echoed into a response.
export function clientKey(
  headers: Record<string, unknown>,
  socketAddress: string | undefined,
  trustedClientIpHeader: string | null,
  trustProxy: boolean,
): string {
  // Addresses are normalised with the repository's accepted network-identity primitive, so
  // IPv6 clients cannot churn interface identifiers (/64 masking) or hide behind an
  // IPv4-mapped form to evade a per-client budget.
  const socket = normalizedNetworkIdentity(socketAddress && socketAddress.trim() ? socketAddress.trim() : "unknown");
  if (!trustProxy || !trustedClientIpHeader) return `socket:${socket}`;
  const raw = headers[trustedClientIpHeader.toLowerCase()] ?? headers[trustedClientIpHeader];
  if (typeof raw !== "string") return `socket:${socket}`;
  // The last hop is the value the trusted proxy appended; anything else is treated as the
  // socket peer, so a client cannot select its own key by sending a header.
  const last = raw.split(",").pop()?.trim() ?? "";
  return /^[0-9a-fA-F:.]{3,45}$/.test(last) ? `proxy:${normalizedNetworkIdentity(last)}` : `socket:${socket}`;
}

export function rateLimitPolicy(env: Record<string, string | undefined>): RateLimitPolicy {
  const header = (env.FLEET_TRUSTED_CLIENT_IP_HEADER ?? "").trim();
  const maxKeys = Number(env.FLEET_RATE_LIMIT_MAX_KEYS);
  const tuning: [keyof typeof FLEET_RATE_LIMIT_RULES, string, number, number, number][] = [
    // name, env var, minimum, maximum, default
    // name, env var, minimum, maximum, default. The floor is 1 so a deliberately small
    // budget is honoured rather than silently raised, while zero and negatives are refused.
    ["operatorAuthFailure", "FLEET_RATE_LIMIT_AUTH_FAILURE", 1, 1_000, FLEET_RATE_LIMIT_RULES.operatorAuthFailure.limit],
    ["operatorAuthFailureGlobal", "FLEET_RATE_LIMIT_AUTH_FAILURE_GLOBAL", 1, 100_000, FLEET_RATE_LIMIT_RULES.operatorAuthFailureGlobal.limit],
    ["operatorRead", "FLEET_RATE_LIMIT_READ", 1, 100_000, FLEET_RATE_LIMIT_RULES.operatorRead.limit],
    ["operatorMutation", "FLEET_RATE_LIMIT_MUTATION", 1, 10_000, FLEET_RATE_LIMIT_RULES.operatorMutation.limit],
    ["ingestion", "FLEET_RATE_LIMIT_INGEST", 1, 1_000_000, FLEET_RATE_LIMIT_RULES.ingestion.limit],
    ["consoleLoginFailure", "FLEET_RATE_LIMIT_LOGIN_FAILURE", 1, 1_000, FLEET_RATE_LIMIT_RULES.consoleLoginFailure.limit],
    ["consoleLogin", "FLEET_RATE_LIMIT_LOGIN", 1, 100_000, FLEET_RATE_LIMIT_RULES.consoleLogin.limit],
  ];
  const rules = { ...FLEET_RATE_LIMIT_RULES } as Record<keyof typeof FLEET_RATE_LIMIT_RULES, RateLimitRule>;
  // A single bounded window override unifies every rule's window. It exists so an operator
  // can tighten the recovery window and so tests can prove recovery without a long sleep;
  // it is clamped so a misconfiguration cannot reduce it to nothing.
  const requestedWindow = Number(env.FLEET_RATE_LIMIT_WINDOW_MS);
  const windowOverride = Number.isFinite(requestedWindow)
    ? Math.min(Math.max(Math.floor(requestedWindow), 100), 3_600_000)
    : null;
  for (const [name, variable, min, max, fallback] of tuning) {
    const requested = Number(env[variable]);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), min), max) : fallback;
    rules[name] = { limit, windowMs: windowOverride ?? FLEET_RATE_LIMIT_RULES[name].windowMs };
  }
  return {
    trustedClientIpHeader: header || null,
    maxKeys: Number.isFinite(maxKeys) ? Math.min(Math.max(Math.floor(maxKeys), 100), 1_000_000) : 10_000,
    rules,
  };
}

// A 429 body carries no request detail, so it can never leak a credential or a signature.
export function rateLimitedBody(): { error: string } {
  return { error: "rate_limited" };
}
